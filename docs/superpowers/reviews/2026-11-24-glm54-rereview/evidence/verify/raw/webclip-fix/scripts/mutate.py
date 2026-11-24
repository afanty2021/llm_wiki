"""变异实跑：只改临时副本的 src，逐个变异体构建+跑全量，列出被哪些测试杀死。仓内文件零改动。"""
import pathlib, re, subprocess, sys

REPO = pathlib.Path("/Users/berton/Github/kb-obsidian/llm_wiki/mcp-server")
T = pathlib.Path("/tmp/webclip-fix/mcp")

# (id, 文件, 旧串, 新串)
M = [
 ("M1 不揭开容器",            "web-clip.ts", "if (weixin) revealWeixinContent(doc)", "void weixin"),
 ("M2 去掉正文阈值",          "web-clip.ts", "if (weixin && bodyChars < WEIXIN_MIN_BODY_CHARS) {", "if (bodyChars < 0) {"),
 ("M3 不论主机名都揭开",      "web-clip.ts", "if (weixin) revealWeixinContent(doc)", "revealWeixinContent(doc)"),
 ("M3b 主机名放宽为后缀匹配", "web-clip.ts", 'return new URL(url).hostname === "mp.weixin.qq.com"', 'return new URL(url).hostname.endsWith("weixin.qq.com") || new URL(url).hostname.endsWith("weixin.qq.com.example.com")'),
 ("M3c 连子元素一起揭开",     "web-clip.ts", 'content.style.visibility = "visible"\n  }', 'content.style.visibility = "visible"\n    content.querySelectorAll<HTMLElement>("*").forEach((el) => { if (el.style.visibility === "hidden") el.style.visibility = "visible" })\n  }'),
 ("M4 提取处不洗标题",        "web-clip.ts", 'sanitizeClipTitle(article.title ?? "") || sanitizeClipTitle(doc.title) || "clip"', '(article.title ?? "").trim() || doc.title.replace(/\\s+/g, " ").trim() || "clip"'),
 ("M6 去掉正文围栏行",        "web-clip.ts", "${CLIP_UNTRUSTED_NOTICE}\\n\\n${o.body}", "${o.body}"),
 ("M6b 围栏行放到正文之后",   "web-clip.ts", "${CLIP_UNTRUSTED_NOTICE}\\n\\n${o.body}", "${o.body}\\n\\n${CLIP_UNTRUSTED_NOTICE}"),
 ("M7 阈值不区分主机名",      "web-clip.ts", "if (weixin && bodyChars < WEIXIN_MIN_BODY_CHARS) {", "if (bodyChars < WEIXIN_MIN_BODY_CHARS) {"),
 ("M8 阈值差一(<=)",          "web-clip.ts", "bodyChars < WEIXIN_MIN_BODY_CHARS", "bodyChars <= WEIXIN_MIN_BODY_CHARS"),
 ("M8b 阈值降到 50",          "web-clip.ts", "export const WEIXIN_MIN_BODY_CHARS = 200", "export const WEIXIN_MIN_BODY_CHARS = 50"),
 ("M9 按 UTF-16 单元截断",    "web-clip.ts", "chars.slice(0, MAX_CLIP_TITLE_CHARS).join(\"\")", "collapsed.slice(0, MAX_CLIP_TITLE_CHARS)"),
 ("M10a 不剥格式字符",        "web-clip.ts", '    .replace(TITLE_FORMAT_CHARS, "")\n', ""),
 ("M10b 不剥变体选择符",      "web-clip.ts", '    .replace(TITLE_INVISIBLE_MARKS, "")\n', ""),
 ("M11 控制符删除而非折空格", "web-clip.ts", '.replace(TITLE_CONTROL_CHARS, " ")', '.replace(TITLE_CONTROL_CHARS, "")'),
 ("M12 不折叠空白",           "web-clip.ts", '    .replace(/\\s+/g, " ")\n    .trim()\n  const chars', '    .trim()\n  const chars'),
 ("M5 回执用原始 title",      "training.ts", 'const title = sanitizeClipTitle(o.title) || "clip"', "const title = o.title"),
]

def rsync():
    for d in ("src", "test"):
        subprocess.run(["rsync", "-a", "--delete", f"{REPO}/{d}/", f"{T}/{d}/"], check=True)

def run_tests():
    p = subprocess.run("node --test --test-reporter=tap dist/test/*.test.js 2>&1", shell=True, cwd=T, capture_output=True, text=True)
    out = p.stdout
    fails = re.findall(r"^\s*not ok \d+ - (.*)$", out, re.M)
    summ = re.search(r"^# fail (\d+)", out, re.M)
    return [re.sub(r"\\([#.])", r"\1", f) for f in fails], (summ.group(1) if summ else "?")

rsync()
subprocess.run("./node_modules/.bin/tsc -p tsconfig.json", cwd=T, shell=True, check=True)
base_fails, base_n = run_tests()
print(f"基线（未变异）：fail={base_n}")
if base_fails:
    print("\n".join(base_fails)); sys.exit(1)

for mid, fn, old, new in M:
    rsync()
    target = T / "src" / fn
    text = target.read_text()
    n = text.count(old)
    if n != 1:
        print(f"{mid}: ✗ 变异未精确应用（命中 {n} 次）"); continue
    target.write_text(text.replace(old, new))
    b = subprocess.run("./node_modules/.bin/tsc -p tsconfig.json", cwd=T, shell=True, capture_output=True, text=True)
    fails, nf = run_tests()
    status = "被杀" if fails else "★★ 存活（无测试检出）★★"
    print(f"{mid}: {status}  fail={nf}  (tsc {'有类型错但仍出 JS' if b.returncode else 'ok'})")
    for f in fails:
        print(f"     ← {f[:78]}")
