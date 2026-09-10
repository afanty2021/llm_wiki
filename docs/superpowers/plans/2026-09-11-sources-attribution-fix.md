# sources 归因缺陷修复实施方案（管线护栏 + 存量回填）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消灭 wiki 页 `sources` 归因坏值——管线侧加兜底护栏（今后不再产生），存量 ~1116 页按内容匹配回填真实源（可追溯、可回滚）。

**Architecture:** 护栏 = `run_ingest_job` 写循环内（而非 `upsert_wiki_page` 内）对 `page.sources` 做 sanitize：剥占位符/空值并 union 真实源路径 `sp`，同时同步进 `frontmatter.sources`。放写循环而非 `upsert_wiki_page` 的原因：review.rs 写入的空 sources 是**设计内**（审核台页无源文件），不能被兜底误改。回填 = 离线 Python 工具（三 tier 内容匹配器 → 干跑映射表 → 人工抽审 → 带备份执行），匹配语料为盘上 1196 个源 md 文件（34MB，`teams/916/projects/614/` 下）。

**Tech Stack:** Rust（src-server，sqlx + serde_json）/ Python 3（标准库 + psql via docker exec）/ live PG docker 5433。

**Spec:** `.superpowers/today-ingest-qc-2026-09-10/report.md` §六（缺陷发现、根因 `parse_single_block` :400、修复设计）；本计划 §0 事实基线为其数据锚。
**评审:** `.superpowers/sources-attribution-plan-review-2026-09-11/report.md`（2026-09-11 已按 receiving-code-review 收口：C1/C2/I1-I9/M1-M9 全部核实并入本修订；唯一处方升级=T3 源侧取「全集合」而非「两侧同 stride」，理由见 Task 4 C2a 注）。

## Global Constraints

- scope = **project_id=614（LT师训知识库）only**；库内数百个 test-proj 测试项目不碰。
- `wiki/` 命名空间的 4 页空 sources 是 review.rs 设计行为，**永不回填**。
- cargo 命令必须 `cd src-server && export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`（双 workspace 硬约束）。
- 集成测试连 live PG（5433=生产库）；本计划的 Rust 测试全部走 `cargo test --lib`（纯函数单测，不依赖 DB）。
- 部署 = release build + launchd bootout/bootstrap；重启前核 mtime、重启后核 lstart+health（launchd 铁律）；避开周日 19:00 教师周报窗。
- 回填执行前必须整页备份（COPY 全行）到 `~/kb-dumps/20260911-sources-backfill/`；先干跑评审、后执行（live 写纪律）。
- 执行窗口纪律（评审 I2）：回填执行前确认无 in-flight job（`select count(*) from ingest_jobs where status='running'` = 0）且避开摄取/教师编辑窗。
- 回填只改 `sources` 列与 `frontmatter.sources`，**不改 content → 不触发 re-embed**。
- git：main 分支直接提交（本仓惯例）；提交前 `git branch --show-current` 核对；`git add` 禁 `-A`。

## §0 事实基线（2026-09-10 深夜实测，执行者勿重测直接引用）

| 项 | 值 |
|---|---|
| 占位符坏值（sources 含 `"source.md"`） | **811 页** |
| 空 sources（排除 `wiki/` 4 页 review 设计内） | **305 页**（09-11 评审复测 **311**，+6 为周漂移——干跑前重跑同口径 N₀ 逐个归因，验收弃 ±5 硬线，见 Task 4 Step 2 / Task 5） |
| 回填全集 | **≈1116 页**（部分页两类叠合，执行时以 SQL 重查为准） |
| 源文件盘上位置 | `/Users/berton/kb-storage/teams/916/projects/614/{sources/transcripts×898, raw/sources×298}`，34MB |
| sources 列 ↔ 盘上路径映射 | DB 值 `sources/transcripts/x.md` / `raw/sources/Slug/x.md` → 盘上拼前缀 `teams/916/projects/614/` |
| 根因代码 | `ingest_pipeline.rs:400` `parse_single_block`：`sources = frontmatter.get("sources")...unwrap_or([])` 直接采信 LLM 输出；合并路径 `:1677` 有 `union_sources(…, sp)` 兜底、新建路径无。**prompt 共犯（评审 I3）**：`prompts/step2_generate.txt:8` 模板示例逐字 `sources: ["source.md"]`——占位符是 prompt 教的，非「LLM 偶发」（示例已随根改 `[]`，随 Task 3 release build 上线） |
| 语料真名 source.md | **不存在**（评审核验 find 零命中）——占位符剥除/LIKE 无误伤面 |
| 写循环 | `run_ingest_job` 内 `:1592` `for page in &processed.pages`；两处 `upsert_wiki_page` 调用（`:1707` merge 失败回落、`:1721` 新建/替换） |
| `upsert_wiki_page` 签名 | `(state, project_id, page: &WikiPageInsert)` :2056，被 review.rs:480、research/synthesize.rs:196 复用——**故护栏不能放这里**（会踩 review 的刻意空 sources） |
| 今天 WSW 批受影响 | 24 页（已含在上述全集内） |

---

### Task 1: `sanitize_sources` 纯函数 + 单元测试（TDD）

**Files:**
- Modify: `src-server/src/services/ingest_pipeline.rs`（新增 fn，放在 `union_sources` :470 旁）
- Test: 同文件 `mod tests`（`union_sources` 的测试在 :2311，紧邻添加）

**Interfaces:**
- Produces: `fn sanitize_sources(sources: &mut serde_json::Value, sp: &str)` —— 就地改写：剥空串与 `"source.md"` 占位项 → 尾部 union `sp`（与 `union_sources` 的 tail-append 约定一致）。

- [ ] **Step 1: 写失败测试**（加到 `mod tests` 内，锚在 `union_sources_dedup_order_tail_append_current` 测试旁）

```rust
#[test]
fn sanitize_sources_placeholder_replaced_by_sp() {
    let mut s = serde_json::json!(["source.md"]);
    sanitize_sources(&mut s, "sources/transcripts/a-12345678.md");
    assert_eq!(s, serde_json::json!(["sources/transcripts/a-12345678.md"]));
}

#[test]
fn sanitize_sources_empty_array_becomes_sp() {
    let mut s = serde_json::json!([]);
    sanitize_sources(&mut s, "raw/sources/Book/Ch01.md");
    assert_eq!(s, serde_json::json!(["raw/sources/Book/Ch01.md"]));
}

#[test]
fn sanitize_sources_keeps_real_entries_drops_placeholder_unions_sp() {
    let mut s = serde_json::json!(["a.md", "source.md"]);
    sanitize_sources(&mut s, "b.md");
    assert_eq!(s, serde_json::json!(["a.md", "b.md"]));
}

#[test]
fn sanitize_sources_no_double_append_when_sp_present() {
    let mut s = serde_json::json!(["b.md"]);
    sanitize_sources(&mut s, "b.md");
    assert_eq!(s, serde_json::json!(["b.md"]));
}

#[test]
fn sanitize_sources_non_array_value_rebuilt_from_sp() {
    let mut s = serde_json::json!("source.md"); // LLM 偶发非数组形态
    sanitize_sources(&mut s, "sp.md");
    assert_eq!(s, serde_json::json!(["sp.md"]));
}

#[test]
fn sanitize_after_union_strips_existing_placeholder() {
    // C1（评审）：merge 分支 union 的 existing 取 DB 现值，可能带存量占位符——
    // union 后 sanitize 必须剥净，否则存量坏值借合并还魂。
    let mut s = union_sources(
        &serde_json::json!(["source.md"]),
        &serde_json::json!(["x.md"]),
        "sp.md",
    );
    sanitize_sources(&mut s, "sp.md");
    assert_eq!(s, serde_json::json!(["x.md", "sp.md"]));
}
```

- [ ] **Step 2: 跑测试确认编译失败**（fn 尚不存在）

Run: `cd src-server && export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" && cargo test --lib sanitize_sources`
Expected: 编译错误 `cannot find function sanitize_sources`

- [ ] **Step 3: 最小实现**（放在 `union_sources` fn 之后，:499 附近）

```rust
/// sources 归因兜底（2026-09-10 Wendy/QC 双事故收口）：parse_single_block 直接采信
/// LLM frontmatter 的 sources，而 step2 模板示例逐字教 `sources: ["source.md"]`
/// （prompts/step2_generate.txt:8，评审 I3 定谳根因——示例已随根改 `[]`，本护栏
/// 退居兜底）→ 占位符/缺省坏值成批入库（全库 811 占位 + 305 空值，见
/// .superpowers/today-ingest-qc-2026-09-10/ §六）。
/// 本 helper 剥空串/占位项后尾部 union 真实源路径 sp（与 union_sources 的
/// tail-append 约定一致）。调用点：run_ingest_job 写循环（sp 在 scope 的唯一层，
/// 多源 job 每源页组用各自 sp——评审核验归因正确）+ merge 分支 union 之后（C1）；
/// 不得放进 upsert_wiki_page——review.rs 的空 sources 是设计内（审核台页无源文件）。
fn sanitize_sources(sources: &mut serde_json::Value, sp: &str) {
    let mut out: Vec<String> = sources
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .filter(|s| !s.is_empty() && *s != "source.md")
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    if !out.iter().any(|o| o == sp) {
        out.push(sp.to_string());
    }
    *sources = serde_json::json!(out);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-server && export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" && cargo test --lib sanitize_sources`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # 必须 main
git add src-server/src/services/ingest_pipeline.rs
git commit -m "fix(ingest): sanitize_sources 兜底——剥占位符/空值并 union 真实源 sp"
```

---

### Task 2: 接入写循环（两处调用点 + frontmatter 同步）

**Files:**
- Modify: `src-server/src/services/ingest_pipeline.rs:1592`（循环改 iter_mut）+ 循环体顶部插一行调用 + frontmatter 同步

**Interfaces:**
- Consumes: Task 1 的 `sanitize_sources(&mut Value, &str)`
- Produces: 写库前 `page.sources` 与 `page.frontmatter["sources"]` 均为 sanitize 后的值（Task 3 的 live probe 依赖此行为）
- 例外（评审 M8，Interfaces 注明）：`frontmatter` 为 Null（非对象）的页，`as_object_mut` 跳过同步——**sources 列生效、frontmatter 不动**，两处形态暂不一致属已知可接受（列是消费面主锚）。

- [ ] **Step 1: 循环改可变迭代并插入调用**

把 `:1592` 的

```rust
for page in &processed.pages {
```

改为

```rust
for page in processed.pages.iter_mut() {
```

并在循环体**第一行**（`is_llm_generated_path` 判断之前）插入：

```rust
                    // sources 归因兜底：LLM frontmatter 占位符/缺省 → 剥占位 + union sp。
                    // frontmatter 同步同一份（列与元数据不劈叉）。
                    sanitize_sources(&mut page.sources, &sp);
                    if let Some(obj) = page.frontmatter.as_object_mut() {
                        obj.insert("sources".into(), page.sources.clone());
                    }
```

若编译错指向 `processed` 不可变：它在 match 臂 `Phase1Output::Done { sp, processed: Some(processed) }` 内绑定（:1577），应改为 **`Some(mut processed)`**（评审 M6 勘误——不是 `let` 声明处的 `let mut processed`；仅编译器指认处改，别动其他借用）。

**同 Step 第二处插入（C1，评审必修）**：merge 分支 `:1677` 的 `union_sources(&e.sources, …)` 中 `e.sources` 取 DB 现值且 union 纯去重无过滤——部署→回填窗口期每次合并都在延续存量占位符，回填后 unresolved 页是永久渗漏点。把

```rust
Some(Ok((merged_content, union_sources(&e.sources, &page.sources, &sp))))
```

改为：

```rust
let mut merged = union_sources(&e.sources, &page.sources, &sp);
sanitize_sources(&mut merged, &sp); // C1：剥 existing 带入的存量占位符
Some(Ok((merged_content, merged)))
```

`update_merged_page` 已同步 `frontmatter.sources`（:2119-2121），改一处全链一致。

- [ ] **Step 2: 全量 lib 测试回归**

Run: `cd src-server && export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" && cargo test --lib`
Expected: 346/346 全绿（340 既有 + 6 新增；若上游数有出入以「全绿零失败」为准）

- [ ] **Step 3: 集成面回归（学习 API + ingest 队列各抽一组，连 live PG，属既定设计）**

Run: 同上环境 `cargo test --test integration learning_api_test:: training_test::`
Expected: 全绿（这些文件默认跑；若遇 ingest 队列两兄弟的 live worker 抢跑既有败，stash 对照归因，与本 diff 无关即放行）

- [ ] **Step 4: Commit**

```bash
git add src-server/src/services/ingest_pipeline.rs
git commit -m "fix(ingest): 写循环接入 sources 兜底——新建/替换路径不再落占位符与空归因"
```

---

### Task 3: 部署 + live 探针验证

**Files:** 无新文件（部署 Task 2 产物 + 探针走 API）

- [ ] **Step 1: release build + 重载**

```bash
cd /Users/berton/Github/kb-obsidian/llm_wiki/src-server && export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" && cargo build --release
launchctl bootout gui/$(id -u)/wiki.src-server; sleep 2
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/wiki.src-server.plist && sleep 3
launchctl list | grep wiki.src-server   # 记下新 pid
ps -p <pid> -o lstart,command           # lstart 必须晚于二进制 mtime
curl -s http://127.0.0.1:8080/health     # 200
```

- [ ] **Step 2: live 探针（占位符 frontmatter 源 → 摄取 → 断言 sources 已兜底 → 清理）**

用 books.json 的 svc-transcriber 凭证：①PUT 探针文件到 `raw/sources/_probe-sources-guard.md`，内容自带 frontmatter `---\n{"type":"concept","title":"sources-guard-probe","sources":["source.md"]}\n---\n# sources-guard-probe\n\n探针正文，验证写循环兜底。\n---END FILE---`；②POST `/api/v1/projects/614/ingest`（source_paths=[该文件]）轮询终态；③GET `page?path=concepts/…`（从 job new_pages 拿实际 path）断言 `sources == ["raw/sources/_probe-sources-guard.md"]`；④DELETE 该页 + DELETE 该源文件（评审 M1 勘误路由形态：`DELETE /api/v1/files/614/delete` + body `{"path": "raw/sources/_probe-sources-guard.md"}`——URL 尾段仅占位，实取 body，files.rs:341+；页面删除走 pages 路由同款 body 形态）。
Expected: 断言一次通过；清理后 `select count(*) from wiki_pages where path like '%probe-sources-guard%'` = 0。另（评审 M2/M3 实施携带）：探针在 ingested_files/日志的留痕属永久记录，**记档不清洗**；删页 best-effort 后补核 probe 相关 embeddings=0。

- [ ] **Step 3: 若探针失败 → 停线回报**（护栏语义有误，不得进入回填）

---

### Task 4: 回填工具 `tools/backfill-sources.py`（匹配器 + 干跑）

**Files:**
- Create: `tools/backfill-sources.py`
- 参考（同款纪律）：`tools/scaffold-purge.py`（--limit 干跑/备份先行）、`tools/embed-backfill.py`（docker exec psql 模式）

**Interfaces:**
- Produces: `python3 tools/backfill-sources.py --dry-run` → `~/kb-dumps/20260911-sources-backfill/mapping.csv`（path,old_sources,new_sources,score,margin,tier）+ `unresolved.csv`（含 tier 列，评审 M4）——**输出物落 kb-dumps 不落 /tmp**（评审 M5：审计证据勿放重启即清处，/tmp 有 08-24 清空事故前科）；`--execute` **只消费已评审的 mapping.csv 落库，文件缺失即拒执行，绝不重算**（评审 I1c：重算=覆写审计证据=评审失效）。
- 不做 `--paths` 限定子集接口（评审 I7：声明而不实现更危险）；unresolved 的人工指定走带备份手工 SQL 并记档。

- [ ] **Step 1: 实现脚本**（核心逻辑如下，全量代码一次写全）

```python
#!/usr/bin/env python3
"""backfill-sources.py — sources 坏值回填（占位符 "source.md" / 空数组）。
匹配器三 tier（确定性、同页可复跑）：
  T1 行探测：页内取最长 12 条规范化行（≥24 字符），在 1196 个源文件规范化文本中
     子串命中计分 = 命中探测字符数/总探测字符数；
  T2 拉丁专名投票（T1 best<0.3 时）：页内拉丁词（≥4 字母，去停用词）在源文的
     命中率（QC 溯源同款探针，'s/复数归一）；
  T3 字符 bigram 容积（T2 仍无 ≥0.3 候选时）：页采样 bigram 集 vs 源**全集合**
     （stride 1；C2a——源侧采样使 containment 数学上限 ≈1/7<0.6，tier 永不可达）。
     三级都取同一判定规则：
       best≥0.6 且 best-second≥0.15 → 单源；best≥0.5 且 second≥0.4 → 双源并集；
       否则 unresolved（人工）。
规范化：剥 wikilink 目标/标记符/全部空白 + lower（CJK 友好）。
写入值：项目相对路径（如 sources/transcripts/x.md、raw/sources/Slug/x.md），
frontmatter 同步 jsonb_set。范围：project 614；wiki/ 命名空间永不触碰。"""
import argparse, csv, json, re, subprocess, sys, unicodedata
from pathlib import Path

ROOT = Path("/Users/berton/kb-storage/teams/916/projects/614")
OUT = Path.home() / "kb-dumps/20260911-sources-backfill"  # M5（评审）：审计证据不落 /tmp
PSQL = ["docker", "exec", "src-server-postgres-1", "psql", "-U", "llmwiki", "-d", "llmwiki", "-Atc"]
# I5（评审）：补教材高频词压同书异章伪双源（look/think 系教材系列名，逐章出现、无章级区分度）
STOP = set("the and that with this from they their have will your what when about which there these those into more also some them then than each other where while being were students student lesson teachers look think unit word picture practice read write say talk play class school story english book".split())

def psql(q):
    r = subprocess.run(PSQL + [q], capture_output=True, text=True)
    r.check_returncode()  # I6（评审）：UPDATE 失败静默则「零 SQL 报错」验收不可验证——失败即中止（已备份可重跑幂等）
    return r.stdout.strip()

def norm(s):
    s = re.sub(r"\[\[([^\]|]*\|)?", " ", s); s = re.sub(r"[\[\]#>*`]|---", " ", s)
    return re.sub(r"\s+", "", s).lower()

def latin_tokens(s):
    s = re.sub(r"\[\[([^\]|]*\|)?", " ", s)
    toks = re.findall(r"[A-Za-z][A-Za-z'’\-]{3,}", s)
    out = []
    for w in toks:
        b = w.lower().strip("'’").replace("'s", "")
        b = b[:-1] if b.endswith("s") and len(b) > 4 else b
        if b not in STOP and len(b) >= 4: out.append(b)
    return out

def load_corpus():
    files = {}
    for p in ROOT.rglob("*.md"):
        rel = str(p.relative_to(ROOT))
        raw = p.read_text(encoding="utf-8", errors="replace")
        files[rel] = raw
    return files

def normed_lines(raw):
    return [norm(l) for l in raw.split("\n") if len(norm(l)) >= 24]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--execute", action="store_true")
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True, parents=True)
    if args.execute:
        # I1c（评审）：执行只消费已评审的 mapping.csv——本分支不触达匹配逻辑，
        # 重算=覆写审计证据=评审失效；文件缺失即拒执行。
        mp = OUT / "mapping.csv"
        if not mp.exists():
            sys.exit("refusing: mapping.csv 不存在——先 --dry-run 并完成人工评审，再 --execute")
        with open(mp, newline="") as f:
            rows = list(csv.DictReader(f))
        bak = Path.home() / "kb-dumps/20260911-sources-backfill"
        bak.mkdir(exist_ok=True, parents=True)
        with open(bak / "affected-rows.csv", "w") as f:
            for i in range(0, len(rows), 200):
                a = ",".join("'%s'" % r["path"].replace("'", "''") for r in rows[i:i+200])
                f.write(psql(f"COPY (SELECT path,title,page_type,frontmatter,sources,content FROM wiki_pages "
                             f"WHERE project_id=614 AND path IN ({a})) TO STDOUT WITH CSV"))
        done = 0
        for r in rows:
            newj = json.dumps(json.loads(r["new"]), ensure_ascii=False).replace("'", "''")
            q = (f"UPDATE wiki_pages SET sources='{newj}'::jsonb, "
                 f"frontmatter=jsonb_set(coalesce(frontmatter,'{{}}'::jsonb),'{{sources}}','{newj}'::jsonb) "
                 f"WHERE project_id=614 AND path='{r['path'].replace(chr(39), chr(39)*2)}'")
            psql(q); done += 1
        print("executed:", done)
        return
    # —— 以下为 --dry-run 匹配路径（--execute 已提前 return，不可达）——
    broken = json.loads(psql(
        "SELECT coalesce(json_agg(t)::text,'[]') FROM (SELECT path, coalesce(sources::text,'') old, "
        "title, content FROM wiki_pages WHERE project_id=614 AND NOT path LIKE 'wiki/%' "
        "AND (sources IS NULL OR sources='[]'::jsonb OR sources::text LIKE '%\"source.md\"%')) t"))
    print("broken pages:", len(broken))
    corpus = load_corpus()
    # C2a（评审，处方升级见下）：源侧第三槽位存**全规范化文本**，T3 时惰性建全集合
    # bigram。原方案源侧 stride 7 采样使 containment 数学上限 ≈1/7<0.6 判定线，
    # tier 永不可达（死亡）；且「两侧同 stride」在偏移子串场景仍退化——页文本在源
    # 文件的起始偏移 k 非 stride 整数倍时两侧采样错位，containment 双峰落 0 或 1/7。
    # **源侧必须全集合（stride 1）**，页侧采样任意。全集合每 T3 页现算不缓存（内存
    # 有界；1196 文件 ≈15-30s/页，T3 页少数，可接受）。
    prepared = {rel: (normed_lines(raw), set(latin_tokens(raw)), norm(raw))
                for rel, raw in corpus.items()}
    rows, unresolved = [], []
    for pg in broken:
        content = pg["content"]; probes = sorted({norm(l) for l in content.split("\n") if len(norm(l)) >= 24},
                                                 key=len, reverse=True)[:12]
        probe_chars = sum(len(p) for p in probes) or 1
        scores = {}
        for rel, (lines, _, _) in prepared.items():
            hit = 0
            joined = "\n".join(lines)  # 每文件拼一次子串搜索
            for p in probes:
                if p in joined: hit += len(p)  # C2b（评审）：命中与计分同口径——24 字符前缀撞车不得全长分
            if hit: scores[rel] = hit / probe_chars
        ranked = sorted(scores.items(), key=lambda x: -x[1])
        best = ranked[0] if ranked else None
        second = ranked[1] if len(ranked) > 1 else None
        tier = "T1"
        if not best or best[1] < 0.3:
            toks = set(latin_tokens(content)); scores2 = {}
            if toks:
                for rel, (_, lat, _) in prepared.items():
                    inter = len(toks & lat)
                    if inter: scores2[rel] = inter / len(toks)
            ranked2 = sorted(scores2.items(), key=lambda x: -x[1]); tier = "T2"
            best, second = (ranked2[0], ranked2[1] if len(ranked2) > 1 else None) if ranked2 else (None, None)
        if not best or best[1] < 0.3:
            pnorm = norm(content)
            bg = {pnorm[i:i+2] for i in range(len(pnorm) - 1)}
            scores3 = {}; tier = "T3"
            for rel, (_, _, ftext) in prepared.items():
                fb = {ftext[i:i+2] for i in range(len(ftext) - 1)}  # C2a：源侧全集合，每页现算不缓存
                inter = len(bg & fb)
                if inter: scores3[rel] = inter / len(bg)
            ranked3 = sorted(scores3.items(), key=lambda x: -x[1])
            best, second = (ranked3[0], ranked3[1] if len(ranked3) > 1 else None) if ranked3 else (None, None)
        if best and best[1] >= 0.6 and (not second or best[1] - second[1] >= 0.15):
            new = [best[0]]
        elif best and second and best[1] >= 0.5 and second[1] >= 0.4:
            new = [best[0], second[0]]
        else:
            unresolved.append({"path": pg["path"], "best": best and best[0], "score": best and best[1], "tier": tier})
            continue
        rows.append({"path": pg["path"], "old": pg["old"],
                     "new": json.dumps(new, ensure_ascii=False),
                     "score": round(best[1], 3),
                     "margin": round(best[1] - (second[1] if second else 0), 3), "tier": tier})
    with open(OUT / "mapping.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["path", "old", "new", "score", "margin", "tier"]); w.writeheader(); w.writerows(rows)
    with open(OUT / "unresolved.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["path", "best", "score", "tier"]); w.writeheader(); w.writerows(unresolved)
    print(f"mapped: {len(rows)}  unresolved: {len(unresolved)}  (mapping.csv / unresolved.csv)")
if __name__ == "__main__":
    main()
```

（实现者可按此语义微调性能——corpus 规范化文本一次性缓存、`joined` 拼串每文件一次——但**判定规则/阈值/输出列不得改**，改即废评审。本版规则已按 2026-09-11 评审 C2/I1c/I5/I6/M4/M5 修订，**此为新的冻结基线**。）

- [ ] **Step 2: 干跑 + 自检断言**

Run: `python3 tools/backfill-sources.py --dry-run`
Expected（评审 I1a/I1b 修订）：
- **N₀ 同口径预计数**：干跑输出的 `broken pages` 即 N₀——与 09-10 基线 1116 的偏差**逐个归因**（已知漂移：空值 +6，09-11 实测 311 vs 方案 305）；**弃 ±5 硬线**——偏差必须能归因，不能垫过去
- mapped ≥ 95%；`mapping.csv` 中 `new` 列 **100% 为项目相对路径形态**（`sources/transcripts/…` 或 `raw/sources/…` 开头，脚本内加一行断言落实现场）
- 已知锚点抽查（评审核正后锚点，干跑报告里必须命中）：`entities/video-5-cartoon-families.md` 不在集合（sources 正常）；WSW 的 24 页应映射回 `raw/sources/WSW-Lesson-Plans/ChXX-….md`；**`entities/lesson-0-2.md`（9 项混合合辑页、无占位）不该在集合**——原方案写 `concepts/lesson-0-2.md` 系笔误，该路径不存在（评审核勘 I1a）；**`entities/wsw2-unit4-my-body-lesson-0-2.md`（sources=["source.md"]）在集合**，且应映射回其 WSW 教案源

- [ ] **Step 3: Commit**

```bash
git add tools/backfill-sources.py
git commit -m "feat(tools): backfill-sources.py——sources 坏值三 tier 匹配回填（干跑/执行双模）"
```

---

### Task 5: 干跑评审 → 执行回填 → 终验

- [ ] **Step 1: 人工评审映射表**：`mapping.csv` 按分层抽读 30 行（T1 高分 10 + T1 低分 10 + T2/T3 10），逐行开页面与源文件对照语义；`unresolved.csv` 逐行给处置（人工指定走带备份手工 SQL 并记档，或留档不回填）。评审人不合格率 >2/30 → 停，调阈值重干跑（评审 M7 加严：>2/30 对 5% 真错率有 ~81% 概率放行——**T1-low 分层内 >1/10 或不合格总量 ≥50 同样停线**）。
- [ ] **Step 2: 执行**（评审 I2 窗口纪律：执行前 `select count(*) from ingest_jobs where status='running'` 必须 =0，避开摄取/教师编辑窗；备份由 `--execute` 自动落 `~/kb-dumps/20260911-sources-backfill/affected-rows.csv`）

Run: `python3 tools/backfill-sources.py --execute`
Expected: `executed: N`（N=映射行数），零 SQL 报错

- [ ] **Step 3: 终验断言（写死）**

```bash
docker exec src-server-postgres-1 psql -U llmwiki -d llmwiki -Atc "
select count(*) from wiki_pages where project_id=614 and not path like 'wiki/%'
and (sources is null or sources='[]'::jsonb or sources::text like '%\"source.md\"%')"
```
Expected: **0**。另跑 §0 的周分布表复测（各周坏值清零）、embed 不变量按**差集对账**（评审 I2：执行前后各 `copy (select wiki_page_id from embeddings where project_id=614) to stdout` 落 snapshot 到 kb-dumps，两集合差必须为空——计数相等会被同窗增删抵消，不可作判据）、红链面不变（content 未动，`tools/redlink-audit.py` 复跑 SERVER 悬空仍=2 存量）。**检索面对比（评审 I4）**：`graph.rs` `W_SOURCE_OVERLAP=4.0` 是最大单信号，811 占位页两两假共享各 +4.0、回填后塌缩为真实共享——这是修复最大隐性收益也是可感知排序变化；执行前后各抽 3-5 个教师典型 query 跑 search，记录 top-k 变化入报告。

- [ ] **Step 4: 报告落盘 + 记忆同步**

报告写 `.superpowers/sources-attribution-fix-2026-09-11/report.md`（护栏 diff 摘要、探针证据、映射统计、unresolved 处置账目、备份路径、**N₀ 归因记录、embed 差集对账结果、检索面 top-k 前后对比（I4）、并发丢失更新结论记档（I2：jsonb_set 服务端读现值仅覆盖 sources 键，窗口纪律下可忽略不加锁）**）；按 [[lt-corpus-scale-and-ingest-progress]] 记忆惯例追加收官段与 MEMORY.md 索引行。

---

## Self-Review 结论

- **Spec 覆盖**：QC 报告 §六的两条修复设计（①管线护栏 sanitize→sp、②存量 n-gram 回填）分别落在 Task 1-3 与 Task 4-5；「质检固定项新增 sources 维度」由 Task 5 Step 3 的终验断言固化。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含实际代码。
- **类型一致性**：`sanitize_sources(&mut serde_json::Value, &str)` 在 Task 1 定义、Task 2 以同名同签名调用；回填输出列与 `--execute` 消费列一致（path/old/new/score/margin/tier）。

## 遗留与不做

- **web PUT 重置面**（评审 I8，记档）：`routes/pages.rs` denormalize 对缺 sources 键一律置 `[]`、web 编辑器对无 frontmatter 块正文送 `{}`——「剥掉 frontmatter 的 PUT」会重置回填成果（正常编辑器 round-trip 不触发，风险低）；可选硬化（frontmatter None 时 COALESCE 保留现值）留后续立项；「sources 坏值计数」维持批量质检固定项作 canary（既定维度，回填后应恒 0，再冒头即报警）。
- **显示名 sources 形态**（评审 I9，记档+后续项）：全库约 2400 页 sources 为「书名 · 章」显示名而非文件路径（源文件首行 `> 来源：书·章` 约定所致；评审核验 concept 1222 + entity 1171 + note 13 = 2406）——人可读可溯，显示名含书名+章 slug 可**确定性映射**回 `raw/sources/<书>/<章>.md`，比内容匹配便宜；独立立项，不阻塞本方案。
- `research/synthesize.rs` / `review.rs` 的写入语义不变（前者 sources=引用 URL、后者刻意空）。
- test-proj 测试项目的历史坏值不在范围（无消费方，巡检过滤兜底）。
- 周日 19:00 周报窗前若未完成部署，回填执行可独立延后（回填不依赖新二进制，但护栏未部署前新摄取会继续产生坏值——故 Task 3 尽量先落）。
