//! Task 9：/t/ 落地页（顶级路由，plan_link token 凭证，教师移动端）。
//! Task 9b：/s/ 短链现签跳转（`GET /s/:code` → 303 `/t/<现签 token>`）。
//!
//! 四端点：
//! - `GET /s/:code`（Task 9b）：查 short_links → 无 → 404；命中 → 现签 7d
//!   plan_link token → 303 See Other Location `/t/<token>`。无鉴权（capability
//!   URL，与 /t/:token 同信任模型）；不记事件（纯跳转，view 由 /t/ 落地记）；
//!   Location 只含服务端现签的 JWT（字符集 [A-Za-z0-9_\-.]），无用户输入反射
//!   ——防响应头注入。短码不过期（plan 存活期间链接永不失效，撤销 = 删行/删 plan，
//!   FK 级联）。
//! - `GET /t/:token`：验签（typ 不符/过期/垃圾 → 403 友好页，401/403 不泄漏是哪种）；
//!   plan 不存在/不归属 → 404；**同事务**记 view 事件（payload 携带简化 ua，
//!   不改投影——view 只是渲染信号，含预取噪声）→ 200 HTML；
//! - `POST /t/:token/seen`：`Option<Json<SeenBody>>` 提取器——beacon 空 body/
//!   无 content-type 时 axum `Json` 会 415/400，Option 把一切提取失败折叠为
//!   None = 页面级语义；有 `{"item_id": N}` 则项级（item ∈ plan 校验 + apply_seen）；
//! - `POST /t/:token/complete`：body `{item_id}`，校验 ∈ plan（伪造 → 400）后
//!   projection::complete_item（单调、幂等）。
//!
//! **限流（Task 6 r3）**：`/s/:code` 30 次/分钟（key=code）、`/t/` 的 seen/
//! complete beacon 60 次/分钟（key=sha256(token) 前 16 hex，两端点共桶）——
//! AppState.limiter（services/rate_limit.rs），超限 `TooManyRequests` → 429。
//!
//! **XSS 防线（存储型，本文件的安全核心）**：label 由 LLM 从老师消息生成、
//! title/reason/content 来自 wiki——全部是不可信输入。`render_t_page` 对所有
//! 插值内容先做 5 字符 HTML 转义（`& < > " '`），**先转义后 linkify**
//! （`[mm:ss]` 跳转与章节链接在已转义文本上做正则替换）；URL 上下文
//! （`src="/media/..."`）对 slug 额外做百分号编码；属性上下文（`title=""`）
//! 同样走转义。渲染是纯函数（lib 可测）。

use std::collections::BTreeMap;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::Duration as ChronoDuration;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{AppError, AppState};

/// /t/ 页内签发的媒体票据 TTL：12h（单次学习会话宽裕上限；远小于
/// media.rs 的 30 天验签纵深上限，票据寿命贴着落地页使用场景收窄）。
const T_MEDIA_TTL_SECS: i64 = 12 * 3600;

/// /s/ 跳转现签 plan_link token TTL：7 天（Task 8 brief 原值；Task 9b 起
/// 签发点从 training.rs 移至此处——短码不过期，每次点击现签新 7d token，
/// plan 存活期间链接永不失效）。
const PLAN_LINK_TTL_DAYS: i64 = 7;

/// view 事件 payload 的 ua 截断长度（「ua 简化」：整段 UA 落库只留前 120 chars）。
const UA_MAX_CHARS: usize = 120;

/// 摘要页（ingest 蒸馏页）查找上限：一个媒体最多展示 3 页相关摘要。
const SUMMARY_PAGE_LIMIT: i64 = 3;

pub fn t_routes() -> Router<AppState> {
    Router::new()
        .route("/t/:token", get(get_t_page))
        .route("/t/:token/seen", post(post_seen))
        .route("/t/:token/complete", post(post_complete))
        .route("/s/:code", get(get_s_redirect))
}

// ============ 渲染数据视图（纯函数入参，lib 可测） ============

/// plan 头部视图（标题/周报摘要）。
pub struct TPlanView {
    pub title: String,
    pub reason: Option<String>,
}

/// item 视图。`wiki_content` 为 wiki_page 项解析出的页面正文
/// （None = 页未同步，渲染占位文案）；media 项的 transcript/摘要内容在
/// `TMediaAssetView` 内。
pub struct TItemView {
    pub id: i32,
    pub kind: String,
    pub target_ref: String,
    pub label: String,
    pub status: String,
    pub wiki_content: Option<String>,
}

/// 章节（media_assets.chapters JSONB 行，防御式解析）。
pub struct TChapter {
    pub start_s: i64,
    pub end_s: i64,
    pub label: String,
}

/// 摘要页（ingest 蒸馏出的 wiki 页，按 sources 反查归属到媒体）。
pub struct TSummaryPage {
    pub path: String,
    pub title: Option<String>,
    pub content: String,
}

pub struct TMediaAssetView {
    pub kind: String,
    pub duration_s: i32,
    pub chapters: Vec<TChapter>,
    /// transcript 阅读（transcript_page_path 的 wiki 页正文）。
    pub transcript: Option<String>,
    /// 摘要页（体验偏差：不内嵌侧栏，折叠 details + 锚点链接替代）。
    pub summary_pages: Vec<TSummaryPage>,
}

// ============ XSS 防线：转义 / 编码 / linkify ============

/// 5 字符 HTML 转义（`& < > " '`）。**所有**插值内容（plan title/reason、item
/// label、chapters 标题、wiki/transcript content、media 元数据、status/kind）
/// 必须先过这里再进模板；属性上下文（`title=""`）同样。先转义后 linkify
/// （顺序不可反——后转义会把 linkify 产出的 `<a>` 二次转义成纯文本）。
pub fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// URL 组件百分号编码（RFC 3986 unreserved 之外全编码）。媒体 slug 进
/// `src="/media/{...}"` 属性前过这里——引号/尖括号/空格均被编码，杜绝
/// 属性逃逸；服务端 axum Path 解码后得到原始 slug 参与验签，闭环一致。
pub fn urlencode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// `[mm:ss]`（分最多 3 位——转写器 ≥100 分钟不截断）→ 可点击跳转锚。
/// **输入必须是已转义文本**（转义不动 `[ : 数字`，正则在转义后仍可匹配）。
fn linkify_timestamps(escaped: &str) -> String {
    let re = regex_lite::Regex::new(r"\[(\d{1,3}):(\d{2})\]").expect("ts regex");
    re.replace_all(escaped, |caps: &regex_lite::Captures| {
        let m: i64 = caps[1].parse().unwrap_or(0);
        let s: i64 = caps[2].parse().unwrap_or(0);
        let start = m * 60 + s;
        format!(r##"<a class="ts" href="#" data-start="{start}">{}</a>"##, &caps[0])
    })
    .into_owned()
}

/// 剥离 YAML frontmatter（transcript 页正文以 `---\n...---\n` 开头，元数据不渲染）。
fn strip_frontmatter(md: &str) -> &str {
    let Some(rest) = md.strip_prefix("---\n").or_else(|| md.strip_prefix("---\r\n")) else {
        return md;
    };
    match rest.find("\n---") {
        Some(i) => {
            let after = &rest[i + 4..]; // 跳过 "\n---"
            after.strip_prefix('\n').or_else(|| after.strip_prefix("\r\n")).unwrap_or(after)
        }
        None => md, // 有头无尾的畸形 frontmatter：整体按正文渲染（宁多勿丢）
    }
}

/// 极简 markdown 呈现（只读渲染）：标题行（`#{1,6} `）→ `<h4>`，其余非空行按
/// 空行分组为段落（组内 `<br>` 换行）。**输入必须已转义（+可选 linkify）**——
/// 本函数不再转义（否则会把 linkify 产出的锚点转成纯文本），也不插入任何
/// 原始用户数据（只加标签骨架）。
fn render_md_lite(escaped: &str) -> String {
    let mut out = String::with_capacity(escaped.len() + 64);
    let mut para: Vec<&str> = Vec::new();
    fn flush(para: &mut Vec<&str>, out: &mut String) {
        if !para.is_empty() {
            out.push_str("<p class=\"md-p\">");
            out.push_str(&para.join("<br>"));
            out.push_str("</p>\n");
            para.clear();
        }
    }
    for line in escaped.lines() {
        let t = line.trim();
        let hashes = t.chars().take_while(|&c| c == '#').count();
        if (1..=6).contains(&hashes) && t[hashes..].starts_with(' ') {
            flush(&mut para, &mut out);
            out.push_str("<h4 class=\"md-h\">");
            out.push_str(t[hashes + 1..].trim()); // '#' 均为 ASCII，字节边界安全
            out.push_str("</h4>\n");
        } else if t.is_empty() {
            flush(&mut para, &mut out);
        } else {
            para.push(t);
        }
    }
    flush(&mut para, &mut out);
    out
}

/// 秒 → "m:ss"（章节/时长展示；纯数字，安全）。
fn fmt_secs(s: i64) -> String {
    format!("{}:{:02}", s / 60, s % 60)
}

// ============ 纯函数渲染 ============

/// 落地页 HTML（纯函数，lib 可测）。`token` 仅用于 beacon 路径（JWT 字符集
/// [A-Za-z0-9_\-.] 本身安全，仍经 JSON 字符串字面量嵌入双保险）。
/// 插值点全量清单（XSS 审计基线，逐一过 html_escape / urlencode）：
/// plan.title（title+h1）、plan.reason（p）、item.label（h2 文本 + title 属性）、
/// item.status/kind（badge/meta）、asset.kind（meta）、chapter.label（li 文本 +
/// title 属性）、transcript/摘要正文与 wiki_page 正文（escape→linkify→md-lite）、
/// summary 页 title/path（h3）、媒体 URL（slug 百分号编码 + hex sig）。
pub fn render_t_page(
    plan: &TPlanView,
    items: &[TItemView],
    media_assets: &BTreeMap<String, TMediaAssetView>,
    signed_urls: &BTreeMap<String, String>,
    token: &str,
) -> String {
    let total = items.len();
    let done = items.iter().filter(|i| i.status == "completed").count();
    let mut html = String::with_capacity(16 * 1024);
    html.push_str(
        r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>"#,
    );
    html.push_str(&html_escape(&plan.title));
    html.push_str(
        r#"</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.7 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #1c1e21; }
.wrap { max-width: 680px; margin: 0 auto; padding: 16px 14px calc(24px + env(safe-area-inset-bottom)); }
.plan { background: #fff; border-radius: 12px; padding: 16px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
.plan h1 { font-size: 20px; margin: 0 0 6px; }
.reason { color: #555; font-size: 14px; margin: 0 0 8px; white-space: pre-wrap; }
.meta { color: #888; font-size: 13px; margin: 0; }
.item { background: #fff; border-radius: 12px; padding: 14px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
.item-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.item-head h2 { font-size: 17px; margin: 0; flex: 1 1 auto; overflow-wrap: anywhere; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: #eef0f3; color: #666; }
.badge-completed { background: #e3f4e3; color: #1a7f37; }
.badge-viewed { background: #e8f0fe; color: #1a56b0; }
video, audio { width: 100%; border-radius: 8px; margin-top: 10px; }
.chapters { padding-left: 0; list-style: none; margin: 10px 0 0; }
.chapters li { border-top: 1px solid #f0f1f3; }
.chap { display: block; padding: 8px 2px; text-decoration: none; color: #1c1e21; }
.chap .t { color: #1a56b0; font-variant-numeric: tabular-nums; margin-right: 6px; }
details.tr, details.summary { margin-top: 10px; }
details summary { cursor: pointer; color: #1a56b0; font-size: 14px; }
.md { font-size: 15px; }
.md .md-h, .md h3.md-h { font-size: 15px; margin: 12px 0 4px; color: #333; }
.md .md-p { margin: 6px 0; overflow-wrap: anywhere; }
a.ts { color: #1a56b0; text-decoration: none; font-variant-numeric: tabular-nums; }
.sum-link { font-size: 13px; color: #1a56b0; text-decoration: none; }
.complete { display: block; width: 100%; margin-top: 12px; padding: 10px; border: 0; border-radius: 8px; background: #1a56b0; color: #fff; font-size: 15px; }
.complete.done { background: #e3f4e3; color: #1a7f37; }
.complete[disabled] { opacity: .8; }
.empty { color: #999; font-size: 14px; }
</style>
</head>
<body>
<main class="wrap">
<header class="plan">
<h1>"#,
    );
    html.push_str(&html_escape(&plan.title));
    html.push_str("</h1>\n");
    if let Some(reason) = plan.reason.as_ref().filter(|r| !r.trim().is_empty()) {
        html.push_str("<p class=\"reason\">");
        html.push_str(&html_escape(reason));
        html.push_str("</p>\n");
    }
    html.push_str(&format!(
        "<p class=\"meta\">共 {total} 项 · 已完成 {done} 项</p>\n</header>\n"
    ));

    for item in items {
        let label_esc = html_escape(&item.label);
        let status_esc = html_escape(&item.status);
        let status_cls = match item.status.as_str() {
            "completed" => "badge-completed",
            "viewed" => "badge-viewed",
            _ => "",
        };
        html.push_str(&format!(
            "<section class=\"item\" id=\"item-{id}\" data-item=\"{id}\">\n\
             <div class=\"item-head\">\n\
             <span class=\"badge {status_cls}\">{status_esc}</span>\n\
             <h2 title=\"{label_esc}\">{label_esc}</h2>\n",
            id = item.id,
        ));
        if item.kind == "media" {
            if let Some(asset) = media_assets.get(&item.target_ref) {
                if !asset.summary_pages.is_empty() {
                    // 摘要页锚点链接（体验偏差：不内嵌侧栏，折叠 details + 锚点替代；
                    // 无摘要页时不渲染，避免死链）
                    html.push_str(&format!(
                        "<a class=\"sum-link\" href=\"#item-{id}-summary\">摘要页</a>\n",
                        id = item.id
                    ));
                }
            }
        }
        html.push_str("</div>\n");

        if item.kind == "media" {
            match media_assets.get(&item.target_ref) {
                Some(asset) => {
                    let tag = if asset.kind == "audio" { "audio" } else { "video" };
                    if let Some(url) = signed_urls.get(&item.target_ref) {
                        // URL 内 slug 已百分号编码、sig/fp/exp 为 hex/数字；再过一次
                        // 属性转义作双保险（对上述字符集为 no-op）
                        // playsinline 三连：iOS WKWebView（企微/微信）无 playsinline 拒绝内联播放，
                        // 安卓 X5 需 x5-playsinline（2026-08-19 真机排障实证）
                        let inline_attrs = if tag == "video" {
                            " playsinline webkit-playsinline x5-playsinline"
                        } else {
                            ""
                        };
                        html.push_str(&format!(
                            "<{tag}{inline_attrs} controls preload=\"metadata\" src=\"{}\"></{tag}>\n",
                            html_escape(url)
                        ));
                    } else {
                        html.push_str("<p class=\"empty\">媒体播放未启用（未配置签名密钥）</p>\n");
                    }
                    html.push_str(&format!(
                        "<p class=\"meta\">时长 {} · {}</p>\n",
                        fmt_secs(asset.duration_s as i64),
                        html_escape(&asset.kind)
                    ));
                    if !asset.chapters.is_empty() {
                        html.push_str("<ol class=\"chapters\">\n");
                        for ch in &asset.chapters {
                            let ch_label = html_escape(&ch.label);
                            html.push_str(&format!(
                                "<li><a class=\"chap\" href=\"#\" data-start=\"{}\" data-end=\"{}\" \
                                 title=\"{ch_label}\"><span class=\"t\">[{}]</span>{ch_label}</a></li>\n",
                                ch.start_s,
                                ch.end_s,
                                fmt_secs(ch.start_s),
                            ));
                        }
                        html.push_str("</ol>\n");
                    }
                    if let Some(tr) = asset.transcript.as_ref() {
                        // 先转义后 linkify（XSS 防线），md-lite 只加标签骨架
                        let body =
                            render_md_lite(&linkify_timestamps(&html_escape(strip_frontmatter(tr))));
                        html.push_str("<details class=\"tr\"><summary>Transcript 阅读</summary>\n");
                        html.push_str(&format!("<div class=\"md\">{body}</div></details>\n"));
                    }
                    if !asset.summary_pages.is_empty() {
                        let n = asset.summary_pages.len();
                        html.push_str(&format!(
                            "<details class=\"summary\" id=\"item-{id}-summary\">\
                             <summary>摘要页（{n}）</summary>\n",
                            id = item.id
                        ));
                        for sp in &asset.summary_pages {
                            let sp_title =
                                html_escape(sp.title.as_deref().filter(|t| !t.is_empty()).unwrap_or(&sp.path));
                            let body = render_md_lite(&html_escape(strip_frontmatter(&sp.content)));
                            html.push_str(&format!(
                                "<h3 class=\"md-h\">{sp_title}</h3>\n<div class=\"md\">{body}</div>\n"
                            ));
                        }
                        html.push_str("</details>\n");
                    }
                }
                None => {
                    html.push_str("<p class=\"empty\">媒体资源不存在或已下线</p>\n");
                }
            }
        } else {
            // wiki_page 项：只读渲染（escape→md-lite；无播放器，不做时间戳 linkify）
            match item.wiki_content.as_deref() {
                Some(c) => {
                    let body = render_md_lite(&html_escape(strip_frontmatter(c)));
                    html.push_str(&format!("<div class=\"md\">{body}</div>\n"));
                }
                None => html.push_str("<p class=\"empty\">内容尚未同步到知识库，请稍后再试</p>\n"),
            }
        }

        // 完成按钮（completed 态禁用）
        if item.status == "completed" {
            html.push_str(&format!(
                "<button class=\"complete done\" data-complete=\"{id}\" disabled>已完成 ✓</button>\n",
                id = item.id
            ));
        } else {
            html.push_str(&format!(
                "<button class=\"complete\" data-complete=\"{id}\">标记完成</button>\n",
                id = item.id
            ));
        }
        html.push_str("</section>\n");
    }

    html.push_str("</main>\n<script>\n");
    html.push_str(&beacon_js(token));
    html.push_str("\n</script>\n</body>\n</html>\n");
    html
}

/// 过期/无效链接友好页（403 同状态返回；不区分 401 签名无效/403 过期——
/// 对教师一律「链接已过期或无效」，防探测泄漏）。无可变插值。
pub fn render_invalid_link_page() -> String {
    r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>链接已过期</title>
<style>
body { margin: 0; font: 16px/1.7 -apple-system, "PingFang SC", sans-serif; background: #f5f6f8; color: #1c1e21; }
.card { max-width: 480px; margin: 20vh auto 0; background: #fff; border-radius: 12px; padding: 24px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
</style>
</head>
<body>
<div class="card">
<h1>链接已过期或无效</h1>
<p>请回到企业微信，向学习助手重新要一个新链接。</p>
</div>
</body>
</html>
"#
    .to_string()
}

/// beacon JS（内联，无框架）。页面级 seen（空 body 由服务端 Option 提取器折叠）；
/// 项级 seen（IntersectionObserver 进入视口 40% 触发一次）；complete 按钮；
/// `[mm:ss]`/章节点击 → 所在 item 的播放器 currentTime 跳转。TOKEN 经 JSON
/// 字符串字面量嵌入（JWT 字符集无引号/反斜杠，serde_json 再兜底转义）。
fn beacon_js(token: &str) -> String {
    let token_lit = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(function () {{
  var TOKEN = {token_lit};
  function beacon(path, body) {{
    try {{
      fetch('/t/' + TOKEN + path, {{ method: 'POST', headers: {{ 'content-type': 'application/json' }}, body: body }}).catch(function () {{}});
    }} catch (e) {{}}
  }}
  beacon('/seen', '{{}}');
  if ('IntersectionObserver' in window) {{
    var io = new IntersectionObserver(function (entries) {{
      entries.forEach(function (en) {{
        if (en.isIntersecting) {{
          beacon('/seen', JSON.stringify({{ item_id: parseInt(en.target.getAttribute('data-item'), 10) }}));
          io.unobserve(en.target);
        }}
      }});
    }}, {{ threshold: 0.4 }});
    Array.prototype.forEach.call(document.querySelectorAll('section.item'), function (el) {{ io.observe(el); }});
  }}
  document.addEventListener('click', function (ev) {{
    var t = ev.target;
    while (t && t !== document.body) {{
      if (t.tagName === 'A' && (t.classList.contains('ts') || t.classList.contains('chap'))) {{
        ev.preventDefault();
        var sec = t.closest ? t.closest('section.item') : null;
        var player = sec && sec.querySelector('video,audio');
        if (player) {{
          var s = parseInt(t.getAttribute('data-start'), 10);
          if (!isNaN(s)) {{
            try {{ player.currentTime = s; var p = player.play(); if (p && p.catch) p.catch(function () {{}}); }} catch (e) {{}}
          }}
        }}
        return;
      }}
      if (t.classList && t.classList.contains('complete') && !t.disabled) {{
        var id = parseInt(t.getAttribute('data-complete'), 10);
        t.disabled = true;
        try {{
          fetch('/t/' + TOKEN + '/complete', {{ method: 'POST', headers: {{ 'content-type': 'application/json' }}, body: JSON.stringify({{ item_id: id }}) }})
            .then(function (r) {{
              if (r.ok) {{ t.textContent = '已完成 ✓'; t.classList.add('done'); }}
              else {{ t.disabled = false; }}
            }})
            .catch(function () {{ t.disabled = false; }});
        }} catch (e) {{ t.disabled = false; }}
        return;
      }}
      t = t.parentElement;
    }}
  }});
}})();
"#
    )
}

// ============ 端点 ============

#[derive(Deserialize, Default)]
pub struct SeenBody {
    pub item_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct CompleteBody {
    pub item_id: i64,
}

/// GET /s/:code — 短链现签跳转（Task 9b，plan_create / plans/:id/link 吐出的
/// 10-char 短码在此兑现）。
/// - 无鉴权：capability URL，与 /t/:token 同信任模型（知码即有权看）；
/// - 查 short_links：无行 → 404（纯 JSON 错误，无需 HTML——教师拿到 404 即知
///   链接失效，回到企微要新链；plan 删除时 FK 级联删行，code 随之失效）；
/// - 命中 → **现签** 7d plan_link token（generate_plan_link_token 原路径不变，
///   /s/ 只是把「签发时机」从 plan 创建推迟到点击——故短码本身无需过期列：
///   plan 存活期间链接永不失效）；
/// - 303 See Other（GET-after-redirect 语义最安全；浏览器/预取器均按 GET 跟进）；
/// - SECURITY：Location 只含服务端现签的 JWT（字符集 [A-Za-z0-9_\-.]，无 CR/LF/
///   引号），路径里的 :code 仅作 DB 查键、**不反射**进响应——无响应头注入面；
/// - 不记 view 事件：纯跳转，view 由浏览器落地 /t/:token 时记（媒体 fp 也锚定
///   /t/ token，跳转后页面自洽）。
async fn get_s_redirect(
    State(state): State<AppState>,
    Path(code): Path<String>,
) -> Result<Redirect, AppError> {
    // 限流（Task 6 r3）：30 次/分钟，key=code。放最前（先于 DB）——爆表请求
    // 连短链查询都不该消耗 DB。超限 → TooManyRequests → 429。
    if !state.limiter.short_link.check(&code) {
        return Err(AppError::TooManyRequests);
    }
    // plan.status 门禁（评审 #1）：归档 plan 的短链一并失效（404，与未知 code 同
    // 语义）——归档即止血，教师侧拿 404 回企微要新链，而非继续可跳转。
    let row: Option<(i32, i32)> = sqlx::query_as(
        "SELECT s.user_id, s.plan_id FROM short_links s \
         WHERE s.code = $1 \
           AND EXISTS (SELECT 1 FROM learning_plans p \
                       WHERE p.id = s.plan_id AND p.status = 'active')",
    )
    .bind(&code)
    .fetch_optional(&state.db)
    .await?;
    let Some((user_id, plan_id)) = row else {
        return Err(AppError::ResourceNotFound("Short link not found".into()));
    };
    let token = crate::utils::generate_plan_link_token(
        user_id,
        plan_id,
        state.config.jwt_secret(),
        ChronoDuration::days(PLAN_LINK_TTL_DAYS),
    )?;
    let location = format!("/t/{token}");
    Ok(Redirect::to(&location))
}

/// GET /t/:token — 验签 → 同事务 view 事件 + 数据装载 → 200 HTML。
async fn get_t_page(
    State(state): State<AppState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let (user_id, plan_id) =
        match crate::utils::verify_plan_link_token(&token, state.config.jwt_secret()) {
            Ok(v) => v,
            // 401(AuthInvalid)/403(PermissionDenied) 统一 403 + 友好页：不向教师
            // 泄漏失败原因（签名无效 vs 过期 vs 垃圾），防探测。
            Err(_) => {
                return Ok(
                    (StatusCode::FORBIDDEN, Html(render_invalid_link_page())).into_response()
                )
            }
        };

    let mut tx = state.db.begin().await.map_err(AppError::from)?;

    // plan 归属（不属/不存在 → 404；提前 return → tx drop 回滚，view 不落库）。
    // status='active' 门禁（评审 #1）：归档 plan 的 /t/ 同样 404（与归属 miss 同
    // 语义，不泄漏归档与不存在的区别）。
    let plan: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT title, reason FROM learning_plans \
         WHERE id = $1 AND user_id = $2 AND status = 'active'",
    )
    .bind(plan_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((title, reason)) = plan else {
        return Err(AppError::ResourceNotFound("Plan not found".into()));
    };

    // 同事务 view 事件（渲染信号；不改投影——预取噪声不算 seen）
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let ua: String = ua.chars().take(UA_MAX_CHARS).collect();
    sqlx::query(
        "INSERT INTO learning_events (user_id, item_id, event_type, payload) \
         VALUES ($1, NULL, 'view', $2)",
    )
    .bind(user_id)
    .bind(serde_json::json!({ "plan_id": plan_id, "ua": ua }))
    .execute(&mut *tx)
    .await?;

    // items（排序 sort_order, id）
    let items: Vec<(i32, String, String, String, String)> = sqlx::query_as(
        "SELECT id, kind, target_ref, label, status FROM learning_items \
         WHERE plan_id = $1 ORDER BY sort_order, id",
    )
    .bind(plan_id)
    .fetch_all(&mut *tx)
    .await?;

    // media 项的 media_assets 行
    let media_slugs: Vec<String> = items
        .iter()
        .filter(|(_, kind, _, _, _)| kind == "media")
        .map(|(_, _, tr, _, _)| tr.clone())
        .collect();
    let media_rows: Vec<(String, String, i32, serde_json::Value, Option<String>, Option<String>)> =
        if media_slugs.is_empty() {
            Vec::new()
        } else {
            sqlx::query_as(
                "SELECT slug, kind, duration_s, chapters, transcript_page_path, source_path \
                 FROM media_assets WHERE slug = ANY($1)",
            )
            .bind(&media_slugs)
            .fetch_all(&mut *tx)
            .await?
        };

    // wiki 内容装载：wiki_page 项 target_ref + media transcript_page_path。
    // TRAINING__PROJECT_ID 缺失（或页未同步）→ 内容为空 → 占位文案，页面其余
    // 功能（媒体播放/beacon/完成）不受影响（内容是辅助呈现，plan 归属才是硬门）。
    let project_id = state.config.training.project_id;
    let mut wiki_paths: Vec<String> = items
        .iter()
        .filter(|(_, kind, _, _, _)| kind == "wiki_page")
        .map(|(_, _, tr, _, _)| tr.clone())
        .collect();
    wiki_paths.extend(media_rows.iter().filter_map(|r| r.4.clone()));
    let wiki_pages: BTreeMap<String, String> = if wiki_paths.is_empty() || project_id.is_none() {
        BTreeMap::new()
    } else {
        sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT path, content FROM wiki_pages WHERE project_id = $1 AND path = ANY($2)",
        )
        .bind(project_id)
        .bind(&wiki_paths)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .filter_map(|(p, c)| c.map(|c| (p, c)))
        .collect()
    };

    // 摘要页：sources ?| {"<slug>.md", source_path}（蒸馏页 sources 的两种历史
    // 形态：裸 slug.md / 完整 source 路径），排除 transcripts/ 命名空间自身
    let mut media_assets: BTreeMap<String, TMediaAssetView> = BTreeMap::new();
    for (slug, kind, duration_s, chapters, transcript_page_path, source_path) in media_rows {
        let ch_list = parse_chapters(&chapters);
        let transcript = transcript_page_path.as_ref().and_then(|p| wiki_pages.get(p).cloned());
        let mut summary_pages = Vec::new();
        if let Some(pid) = project_id {
            let candidates: Vec<String> = match source_path.as_ref() {
                Some(sp) => vec![format!("{slug}.md"), sp.clone()],
                None => vec![format!("{slug}.md")],
            };
            let rows: Vec<(String, Option<String>, String)> = sqlx::query_as(
                "SELECT path, title, content FROM wiki_pages \
                 WHERE project_id = $1 AND sources ?| $2 AND path NOT LIKE 'transcripts/%' \
                 ORDER BY path LIMIT $3",
            )
            .bind(pid)
            .bind(&candidates)
            .bind(SUMMARY_PAGE_LIMIT)
            .fetch_all(&mut *tx)
            .await?;
            summary_pages = rows
                .into_iter()
                .map(|(path, title, content)| TSummaryPage { path, title, content })
                .collect();
        }
        media_assets.insert(
            slug,
            TMediaAssetView { kind, duration_s, chapters: ch_list, transcript, summary_pages },
        );
    }

    tx.commit().await.map_err(AppError::from)?;

    // 签名 URL（CPU-only，事务外）：fp = sha256(plan_link token) 前 16 hex；
    // 签名密钥未配置 → 不签（渲染「媒体播放未启用」占位）
    let media_key = state.config.media.signing_key.clone();
    let signed_urls: BTreeMap<String, String> = if media_key.is_empty() {
        BTreeMap::new()
    } else {
        let exp = chrono::Utc::now().timestamp() + T_MEDIA_TTL_SECS;
        let fp = hex::encode(Sha256::digest(token.as_bytes()));
        let fp = &fp[..16];
        media_assets
            .keys()
            .map(|slug| {
                let sig = crate::utils::media_sign::sign_media_with_fp(&media_key, slug, exp, fp);
                let url =
                    format!("/media/{}?exp={exp}&sig={sig}&fp={fp}", urlencode_component(slug));
                (slug.clone(), url)
            })
            .collect()
    };

    // 视图组装：wiki_page 项正文（未同步 → None → 占位文案）
    let t_items: Vec<TItemView> = items
        .into_iter()
        .map(|(id, kind, target_ref, label, status)| {
            let wiki_content = if kind == "wiki_page" {
                wiki_pages.get(&target_ref).cloned()
            } else {
                None
            };
            TItemView { id, kind, target_ref, label, status, wiki_content }
        })
        .collect();
    let plan_view = TPlanView { title, reason };
    Ok((
        StatusCode::OK,
        Html(render_t_page(&plan_view, &t_items, &media_assets, &signed_urls, &token)),
    )
        .into_response())
}

/// POST /t/:token/seen — beacon 双粒度。`Option<Json<SeenBody>>`：提取失败
/// （空 body / 无 content-type / 畸形 JSON）一律 None = 页面级语义（beacon
/// 兼容的关键——裸 `Json` 对无 content-type 请求直接 415）。
async fn post_seen(
    State(state): State<AppState>,
    Path(token): Path<String>,
    body: Option<Json<SeenBody>>,
) -> Result<Json<serde_json::Value>, AppError> {
    // 限流（Task 6 r3）：beacon 60 次/分钟，key=sha256(token) 前 16 hex
    // （与 complete 共桶——一个 /t/ 会话的全部 beacon 共用预算）。先于验签/DB。
    if !state.limiter.beacon.check(&crate::services::rate_limit::beacon_key(&token)) {
        return Err(AppError::TooManyRequests);
    }
    let (user_id, plan_id) =
        crate::utils::verify_plan_link_token(&token, state.config.jwt_secret())?;
    let mut tx = state.db.begin().await.map_err(AppError::from)?;

    // 归属 + status 门禁（评审 #1）：归档 plan 不再接受任何 beacon（404）。
    let owned: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM learning_plans \
         WHERE id = $1 AND user_id = $2 AND status = 'active'",
    )
    .bind(plan_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    if owned.is_none() {
        return Err(AppError::ResourceNotFound("Plan not found".into()));
    }

    let item_id = body.and_then(|Json(b)| b.item_id);
    if let Some(item_id) = item_id {
        // item ∈ plan 校验（伪造 item_id → 400；不属本 plan 的他人 item 不可记账）
        let ok: Option<i32> =
            sqlx::query_scalar("SELECT id FROM learning_items WHERE id = $1 AND plan_id = $2")
                .bind(item_id)
                .bind(plan_id)
                .fetch_optional(&mut *tx)
                .await?;
        if ok.is_none() {
            return Err(AppError::BadRequest(format!(
                "item_id {item_id} does not belong to this plan"
            )));
        }
    }

    crate::services::projection::apply_seen(&mut tx, plan_id, item_id.map(|i| i as i32), user_id)
        .await?;
    tx.commit().await.map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "ok": true, "item_id": item_id })))
}

/// POST /t/:token/complete — body {item_id}（beacon JS 恒带 content-type + body，
/// 提取器用裸 Json）；校验 ∈ plan（伪造 → 400）后 complete_item（单调/幂等）。
async fn post_complete(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(body): Json<CompleteBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    // 限流（Task 6 r3）：与 seen 共桶（60 次/分钟，key=token 指纹）。
    if !state.limiter.beacon.check(&crate::services::rate_limit::beacon_key(&token)) {
        return Err(AppError::TooManyRequests);
    }
    let (user_id, plan_id) =
        crate::utils::verify_plan_link_token(&token, state.config.jwt_secret())?;
    let mut tx = state.db.begin().await.map_err(AppError::from)?;

    // 归属 + status 门禁（评审 #1，与 post_seen 一致）：归档 plan 拒收 complete。
    let owned: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM learning_plans \
         WHERE id = $1 AND user_id = $2 AND status = 'active'",
    )
    .bind(plan_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    if owned.is_none() {
        return Err(AppError::ResourceNotFound("Plan not found".into()));
    }

    let ok: Option<i32> =
        sqlx::query_scalar("SELECT id FROM learning_items WHERE id = $1 AND plan_id = $2")
            .bind(body.item_id)
            .bind(plan_id)
            .fetch_optional(&mut *tx)
            .await?;
    if ok.is_none() {
        return Err(AppError::BadRequest(format!(
            "item_id {} does not belong to this plan",
            body.item_id
        )));
    }

    crate::services::projection::complete_item(&mut tx, body.item_id as i32, user_id).await?;
    tx.commit().await.map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "item_id": body.item_id, "status": "completed" })))
}

/// chapters JSONB → Vec<TChapter>（防御式：畸形数组/缺失字段降级为空/默认，
/// 负 start/end 钳 0——CLI/LLM 产出的 JSON 不可信）。
fn parse_chapters(v: &serde_json::Value) -> Vec<TChapter> {
    #[derive(serde::Deserialize)]
    struct Raw {
        #[serde(default)]
        start_s: i64,
        #[serde(default)]
        end_s: i64,
        #[serde(default)]
        label: String,
    }
    serde_json::from_value::<Vec<Raw>>(v.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|r| TChapter {
            start_s: r.start_s.max(0),
            end_s: r.end_s.max(0),
            label: r.label,
        })
        .collect()
}

// ============ lib 纯函数测试 ============

#[cfg(test)]
mod tests {
    use super::*;

    fn media_view(kind: &str, chapters: Vec<TChapter>, transcript: Option<String>) -> TMediaAssetView {
        TMediaAssetView { kind: kind.into(), duration_s: 600, chapters, transcript, summary_pages: vec![] }
    }

    /// 敌意 fixture 全量渲染：所有插值点均被转义，语义保留。
    #[test]
    fn render_t_page_neutralizes_hostile_fixtures() {
        let plan = TPlanView {
            title: "<script>alert('title')</script>".into(),
            reason: Some("因 <b>ask</b> 生成 \"引号\" 与 '单引号'".into()),
        };
        let hostile_label = "<img src=x onerror=fetch('/t/X/seen')>";
        let items = vec![
            TItemView {
                id: 1,
                kind: "wiki_page".into(),
                target_ref: "pages/a.md".into(),
                label: hostile_label.into(),
                status: "pending".into(),
                wiki_content: Some(
                    "# 标题 <script>alert('content')</script>\n\n正文 <img src=x onerror=alert(2)>（wiki_page 项不做时间戳 linkify：无播放器可跳）\n".into(),
                ),
            },
            TItemView {
                id: 2,
                kind: "media".into(),
                target_ref: "slug\"a<b".into(),
                label: "正常媒体项".into(),
                status: "viewed".into(),
                wiki_content: None,
            },
        ];
        let mut assets = BTreeMap::new();
        assets.insert(
            "slug\"a<b".to_string(),
            media_view(
                "video",
                vec![TChapter {
                    start_s: 0,
                    end_s: 60,
                    label: "<script>alert('chap')</script>".into(),
                }],
                Some("---\ntitle: \"t\"\n---\n\n## [00:10] <b>章</b>\n\n[00:10] 转写 <script>alert('tr')</script> [00:42] 尾。\n".into()),
            ),
        );
        let mut urls = BTreeMap::new();
        urls.insert("slug\"a<b".to_string(), "/media/slug%22a%3Cb?exp=1&sig=ab&fp=cd".to_string());
        let html = render_t_page(&plan, &items, &assets, &urls, "tok.en_123");

        // 敌意标签不出现原样（转义后仅作可见文本，无标签语义）
        assert!(!html.contains("<img"), "no raw <img> tag");
        assert!(!html.contains("<script>alert"), "no raw hostile <script>");
        assert!(!html.contains("<b>"), "no raw <b> tag");
        // 结构性 XSS 审计：输出中每个 '<' 只允许来自模板自身的标签词表
        // （敌意内容里的 '<' 一律被转义为 &lt;，不可能命中白名单外的标签）
        let mut idx = 0;
        let allowed = [
            "DOCTYPE", "html", "head", "meta", "title", "style", "body", "main", "header",
            "h1", "h2", "h3", "h4", "p", "span", "section", "div", "video", "audio", "ol",
            "li", "a", "details", "summary", "button", "script", "br",
        ];
        while let Some(pos) = html[idx..].find('<') {
            let rest = html[idx + pos + 1..].trim_start_matches(['!', '/']);
            let word: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            assert!(
                allowed.contains(&word.as_str()),
                "unexpected raw tag in html (XSS leak?) context: {:?}",
                &html[idx + pos..(idx + pos + 40).min(html.len())]
            );
            idx += pos + 1;
        }
        // 转义形态保留语义
        assert!(html.contains("&lt;script&gt;alert(&#39;title&#39;)&lt;/script&gt;"));
        assert!(html.contains("&lt;img src=x onerror=fetch(&#39;/t/X/seen&#39;)&gt;"));
        assert!(html.contains("&lt;script&gt;alert(&#39;content&#39;)&lt;/script&gt;"));
        assert!(html.contains("&lt;script&gt;alert(&#39;chap&#39;)&lt;/script&gt;"));
        assert!(html.contains("&lt;b&gt;章&lt;/b&gt;"));
        // 属性上下文：title="..." 内是转义文本
        assert!(html.contains("title=\"&lt;img src=x"));
        assert!(!html.contains("title=\"<"));
        // 敌意 media 项无摘要页 → 不渲染摘要锚点（避免死链；CSS 类定义除外）
        assert!(!html.contains("class=\"sum-link\""), "no summary anchor without summary pages");
        // 时间戳 linkify 在转义后仍工作
        assert!(html.contains("data-start=\"42\""));
        assert!(html.contains("data-start=\"10\""));
        // beacon 形状
        assert!(html.contains("beacon('/seen', '{}');"));
        assert!(html.contains("'/t/' + TOKEN + path"));
        assert!(html.contains("'/t/' + TOKEN + '/complete'"));
        assert!(html.contains("content-type"));
    }

    /// 空态/占位：无 reason、无 wiki 内容 → 占位文案；completed 项按钮禁用。
    #[test]
    fn render_t_page_placeholders_and_completed_state() {
        let plan = TPlanView { title: "计划".into(), reason: None };
        let items = vec![
            TItemView {
                id: 7,
                kind: "wiki_page".into(),
                target_ref: "pages/none.md".into(),
                label: "未同步".into(),
                status: "pending".into(),
                wiki_content: None,
            },
            TItemView {
                id: 8,
                kind: "wiki_page".into(),
                target_ref: "pages/done.md".into(),
                label: "已完成项".into(),
                status: "completed".into(),
                wiki_content: Some("正文".into()),
            },
        ];
        let html = render_t_page(&plan, &items, &BTreeMap::new(), &BTreeMap::new(), "tok");
        assert!(html.contains("内容尚未同步到知识库"));
        assert!(html.contains("共 2 项 · 已完成 1 项"));
        assert!(html.contains("data-complete=\"8\" disabled"));
        assert!(html.contains("data-complete=\"7\">标记完成"));
    }

    /// 摘要页：折叠 details + 锚点链接（体验偏差的替代形态）。
    #[test]
    fn render_t_page_summary_pages_collapsible_with_anchor() {
        let plan = TPlanView { title: "p".into(), reason: None };
        let items = vec![TItemView {
            id: 3,
            kind: "media".into(),
            target_ref: "s1".into(),
            label: "l".into(),
            status: "pending".into(),
            wiki_content: None,
        }];
        let mut assets = BTreeMap::new();
        let mut mv = media_view("video", vec![], None);
        mv.summary_pages = vec![TSummaryPage {
            path: "concepts/x.md".into(),
            title: Some("<i>摘要标题</i>".into()),
            content: "摘要正文".into(),
        }];
        assets.insert("s1".to_string(), mv);
        let mut urls = BTreeMap::new();
        urls.insert("s1".to_string(), "/media/s1?exp=1&sig=ab&fp=cd".to_string());
        let html = render_t_page(&plan, &items, &assets, &urls, "tok");
        assert!(html.contains("href=\"#item-3-summary\""), "summary anchor link");
        assert!(html.contains("id=\"item-3-summary\""), "summary details block");
        assert!(html.contains("&lt;i&gt;摘要标题&lt;/i&gt;"), "summary title escaped");
        assert!(html.contains("摘要正文"));
        assert!(html.contains("<video"), "video kind renders video element");
        assert!(
            html.contains("playsinline webkit-playsinline x5-playsinline"),
            "video carries inline-playback attrs for iOS WKWebView / Android X5"
        );
    }

    #[test]
    fn html_escape_five_chars() {
        assert_eq!(html_escape("&<>\"'"), "&amp;&lt;&gt;&quot;&#39;");
        assert_eq!(html_escape("中文 安全"), "中文 安全");
        assert_eq!(html_escape(""), "");
    }

    #[test]
    fn urlencode_component_encodes_hostile_slug() {
        assert_eq!(urlencode_component("slug\"a<b c"), "slug%22a%3Cb%20c");
        assert_eq!(urlencode_component("abcXYZ09-_.~"), "abcXYZ09-_.~");
        // JWT 字符集原样（beacon token 路径安全）
        assert_eq!(urlencode_component("e.y-z_A9"), "e.y-z_A9");
    }

    #[test]
    fn linkify_timestamps_on_escaped_text() {
        let esc = html_escape("x [00:12] y [105:03] z");
        let out = linkify_timestamps(&esc);
        assert!(out.contains("data-start=\"12\""));
        assert!(out.contains("data-start=\"6303\""), "105:03 = 6303s");
        assert!(out.contains("[00:12]</a>"));
        // 非时间戳方括号不动
        let out2 = linkify_timestamps("[ab:cd] [1:2] [1234:56]");
        assert_eq!(out2, "[ab:cd] [1:2] [1234:56]");
    }

    #[test]
    fn strip_frontmatter_variants() {
        assert_eq!(strip_frontmatter("---\na: 1\n---\n正文"), "正文");
        assert_eq!(strip_frontmatter("---\na: 1\n---\r\n正文"), "正文");
        assert_eq!(strip_frontmatter("无 frontmatter"), "无 frontmatter");
        assert_eq!(strip_frontmatter("---\n有头无尾"), "---\n有头无尾");
    }

    #[test]
    fn render_md_lite_structure() {
        let out = render_md_lite("## 标题一\n\n第一段\n第二行\n\n第二段");
        assert!(out.contains("<h4 class=\"md-h\">标题一</h4>"));
        assert!(out.contains("<p class=\"md-p\">第一段<br>第二行</p>"));
        assert!(out.contains("<p class=\"md-p\">第二段</p>"));
    }

    #[test]
    fn parse_chapters_defensive() {
        let good = serde_json::json!([{"start_s": 10, "end_s": 20, "label": "a"},
                                      {"start_s": -5, "end_s": 0}]);
        let cs = parse_chapters(&good);
        assert_eq!(cs.len(), 2);
        assert_eq!(cs[0].start_s, 10);
        assert_eq!(cs[1].start_s, 0, "negative clamped");
        assert_eq!(cs[1].label, "");
        assert!(parse_chapters(&serde_json::json!("not-array")).is_empty());
        assert!(parse_chapters(&serde_json::json!({"a": 1})).is_empty());
    }

    #[test]
    fn invalid_link_page_has_friendly_message() {
        let html = render_invalid_link_page();
        assert!(html.contains("链接已过期或无效"));
        assert!(html.contains("企业微信"));
        assert!(html.contains("viewport"));
    }

    #[test]
    fn beacon_js_escapes_token_literal() {
        let js = beacon_js("e0A.b-c_9");
        assert!(js.contains("var TOKEN = \"e0A.b-c_9\";"));
        assert!(js.contains("beacon('/seen', '{}');"));
        // 敌意 token（理论不可达：JWT 字符集受限）也不会破坏 JS 字符串字面量
        let hostile = beacon_js("x\";alert(1);//");
        assert!(hostile.contains(r#"var TOKEN = "x\";alert(1);//";"#), "serde_json escapes quotes");
    }
}
