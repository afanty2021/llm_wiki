#!/usr/bin/env python3
"""11.3-2 变异矩阵：逐个撤掉 web-clip 小修批的修复，看对应钉子是否变红。只在 /tmp 副本里做（mut/），live 检出零写入。
用法：python3 mutate.py   输出 raw/mutation-matrix.txt"""
import os, re, shutil, subprocess, sys, time

W = '/tmp/glm54-fix-20261126'
M = '/Users/berton/Github/kb-obsidian/llm_wiki/mcp-server'
FIXED, MUT = W + '/work', W + '/mut'
NODE = '/Users/berton/.hermes/tools/node-26.12.1-darwin-arm64/bin/node'
ENV = dict(os.environ, PATH='/opt/homebrew/bin:' + os.environ.get('PATH', ''))
RAW = open(W + '/raw/mutation-matrix.txt', 'a')

NET = 'dist/test/web-clip-net.test.js'
UNIT = 'dist/test/web-clip.test.js'
FETCH = 'dist/test/web-clip-fetch.test.js'
TRAIN = 'dist/test/training.test.js'

T_INFLIGHT, T_UNREAD, T_FULL, T_CONTRACT = '销毁在飞未完成的 302 body', '销毁已收完但未读的 302 body', '真网络·全路径', '真网络·契约层'
T_SLUG, T_IDEM, T_INVIS, T_TITLEFB = 'kebabSlug·截断按码点', 'sanitizeClipTitle·截断点落在空格上', '微信正文阈值只数可见字符', 'title 回落链中段'
T_PREV, T_SEARCH, T_ERRCODE = '回执层 prev 字段收口', 'search 回显·片段不可信提示', '错误码全集'
ALL_NET = {T_INFLIGHT, T_UNREAD, T_FULL, T_CONTRACT}
LISTENER_AT_RETURN = '  res.body.on("error", () => {})\n'
DESTROY_BODY = '      res.body.destroy()\n'
CLIP, TRAINF = 'src/web-clip.ts', 'src/training.ts'

MUTANTS = [
    # (标签, 文件, 原文, 替换, 期望变红的钉子集合, 类别, 跑哪些测试文件)
    ('a1 删常驻监听器', CLIP, LISTENER_AT_RETURN, '', ALL_NET, 'kill', [NET]),
    ('a2 常驻改一次性（once）', CLIP, LISTENER_AT_RETURN, '  res.body.once("error", () => {})\n', set(), 'equivalent', [NET]),
    ('a3 改回旧修法：监听器只挂在 destroy 闭包里', CLIP, LISTENER_AT_RETURN, '', {T_CONTRACT}, 'kill', [NET]),
    ('b1 kebabSlug 退回按 UTF-16 单元截断', CLIP,
     '  const chars = Array.from(cleaned)\n  const slug = chars.length > 60 ? chars.slice(0, 60).join("") : cleaned\n',
     '  const slug = cleaned.slice(0, 60)\n', {T_SLUG}, 'kill', [UNIT]),
    ('b2 kebabSlug 恒走码点路径（写法不同、语义相同）', CLIP,
     '  const chars = Array.from(cleaned)\n  const slug = chars.length > 60 ? chars.slice(0, 60).join("") : cleaned\n',
     '  const slug = Array.from(cleaned).slice(0, 60).join("")\n', set(), 'equivalent', [UNIT]),
    ('c1 sanitizeClipTitle 截断后不再 trim', CLIP,
     'chars.slice(0, MAX_CLIP_TITLE_CHARS).join("").trim()', 'chars.slice(0, MAX_CLIP_TITLE_CHARS).join("")', {T_IDEM}, 'kill', [UNIT]),
    ('d1 阈值计数不剥不可见字符（修前）', CLIP,
     'const INVISIBLE_CHARS = /[\\p{C}\\u115F\\u3164\\uFFA0\\u2800]|[\\u034F\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}]/gu',
     'const INVISIBLE_CHARS = /\\b\\B/gu', {T_INVIS}, 'kill', [FETCH]),
    ('d2 只剥 Cf（首轮建议的最小集）', CLIP,
     'const INVISIBLE_CHARS = /[\\p{C}\\u115F\\u3164\\uFFA0\\u2800]|[\\u034F\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}]/gu',
     'const INVISIBLE_CHARS = /\\p{Cf}/gu', {T_INVIS}, 'kill', [FETCH]),
    ('d3 只剥 C 类（不含填充符与变体选择符）', CLIP,
     'const INVISIBLE_CHARS = /[\\p{C}\\u115F\\u3164\\uFFA0\\u2800]|[\\u034F\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}]/gu',
     'const INVISIBLE_CHARS = /\\p{C}/gu', {T_INVIS}, 'kill', [FETCH]),
    ('e1 删 document.title 回落（修后直落 clip）', CLIP,
     'sanitizeClipTitle(article.title ?? "") || sanitizeClipTitle(doc.title) || "clip"',
     'sanitizeClipTitle(article.title ?? "") || "clip"', {T_TITLEFB}, 'kill', [FETCH]),
    ('e2 先选来源再清洗（写法不同）', CLIP,
     'sanitizeClipTitle(article.title ?? "") || sanitizeClipTitle(doc.title) || "clip"',
     'sanitizeClipTitle((article.title ?? "") || doc.title) || "clip"', {T_TITLEFB}, 'kill', [FETCH]),
    ('i1 search 片段不打提示', TRAINF,
     '    if (result.snippet && result.path.startsWith("clips/")) lines.push(CLIP_SNIPPET_UNTRUSTED_NOTICE)\n',
     '    if (result.path.startsWith("clips/") && result.snippet.length < 0) lines.push(CLIP_SNIPPET_UNTRUSTED_NOTICE)\n', {T_SEARCH}, 'kill', [TRAIN]),
    ('i2 提示打到 Snippet 之后（顺序颠倒）', TRAINF,
     '    if (result.snippet && result.path.startsWith("clips/")) lines.push(CLIP_SNIPPET_UNTRUSTED_NOTICE)\n    if (result.snippet) lines.push(`Snippet: ${result.snippet}`)\n',
     '    if (result.snippet) lines.push(`Snippet: ${result.snippet}`)\n    if (result.snippet && result.path.startsWith("clips/")) lines.push(CLIP_SNIPPET_UNTRUSTED_NOTICE)\n', {T_SEARCH}, 'kill', [TRAIN]),
    ('g1 empty_content 文案退回修前', TRAINF,
     '  empty_content: "这篇提不了正文（可能已删除、需登录、付费墙，或内容太短、以图片为主），可以把正文复制发我",',
     '  empty_content: "这篇提不了正文（可能已删除、需登录或付费墙），可以把正文复制发我",', {T_ERRCODE}, 'kill', [TRAIN]),
    ('h1 收藏人不清洗不截断（修前）', TRAINF,
     '  const who = cleanReplyField(o.prevClippedBy, REPLY_WHO_MAX_CHARS)\n',
     '  const who = typeof o.prevClippedBy === "string" && o.prevClippedBy !== "" ? (REPLY_WHO_MAX_CHARS < 0 ? "" : o.prevClippedBy) : undefined\n', {T_PREV}, 'kill', [TRAIN]),
    ('h5 收藏人只按单元截断、不清洗', TRAINF,
     '  const who = cleanReplyField(o.prevClippedBy, REPLY_WHO_MAX_CHARS)\n',
     '  const who = typeof o.prevClippedBy === "string" && o.prevClippedBy !== "" ? o.prevClippedBy.slice(0, REPLY_WHO_MAX_CHARS).trim() : undefined\n', {T_PREV}, 'kill', [TRAIN]),
    ('h2 收藏人清洗但不另设上限', TRAINF,
     '  const who = cleanReplyField(o.prevClippedBy, REPLY_WHO_MAX_CHARS)\n',
     '  const who = cleanReplyField(o.prevClippedBy, REPLY_WHO_MAX_CHARS < 0 ? 0 : MAX_CLIP_TITLE_CHARS)\n', {T_PREV}, 'kill', [TRAIN]),
    ('h3 日期取原文前 10 位（修前）', TRAINF,
     '  const date = /^\\d{4}-\\d{2}-\\d{2}/.exec(cleanReplyField(o.prevClippedAt, MAX_CLIP_TITLE_CHARS) ?? "")\n',
     '  const date = /^\\d{4}-\\d{2}-\\d{2}/.exec(o.prevClippedAt !== undefined ? o.prevClippedAt.slice(0, 10).padEnd(10, "x") : "")\n', {T_PREV}, 'kill', [TRAIN]),
    ('h4 title 不做类型判断（修前）', TRAINF,
     '  const title = cleanReplyField(o.title, MAX_CLIP_TITLE_CHARS) ?? "clip"\n',
     '  const title = sanitizeClipTitle(o.title) || "clip"\n', {T_PREV}, 'kill', [TRAIN]),
    ('x1 等价修法「排空代替销毁」：永不结束的 302 连接不被释放', CLIP, DESTROY_BODY,
     '      res.body.resume()\n', {T_INFLIGHT}, 'alt-fix', [NET]),
]
# a3 需要两处改动：返回前不挂监听器 + destroy 闭包里挂一次性监听器
A3_SECOND = (DESTROY_BODY, '      res.body.once("error", () => {})\n' + DESTROY_BODY)


def out(s):
    print(s, flush=True); RAW.write(s + '\n'); RAW.flush()


def fresh():
    if os.path.exists(MUT):
        shutil.rmtree(MUT)
    os.makedirs(MUT)
    for x in ('src', 'test'):
        shutil.copytree(f'{FIXED}/{x}', f'{MUT}/{x}')
    for x in ('package.json', 'tsconfig.json'):
        shutil.copy2(f'{FIXED}/{x}', f'{MUT}/{x}')
    subprocess.run(['cp', '-cR', FIXED + '/node_modules', MUT + '/node_modules'], check=True)


def build():
    p = subprocess.run(['npm', 'run', 'build'], cwd=MUT, env=ENV, capture_output=True, text=True, timeout=300)
    return p.returncode, p.stdout + p.stderr


def run(files):
    p = subprocess.run([NODE, '--test', '--test-reporter=tap', *files], cwd=MUT, env=ENV, capture_output=True, text=True, timeout=300)
    tap = p.stdout + p.stderr
    red = set(re.findall(r'^not ok \d+ - (.*)$', tap, re.M))
    tot = {k: (re.findall(rf'^# {k} (\d+)$', tap, re.M) or ['?'])[-1] for k in ('tests', 'pass', 'fail')}
    return p.returncode, red, tot, tap


def main():
    out(f'== MUTATION-MATRIX start {time.strftime("%F %T")} ==')
    fresh()
    rc, o = build()
    out(f'基线（修后原件，副本构建 rc={rc}）')
    assert rc == 0, o[-2000:]
    base_rc, base_red, base_tot, _ = run([NET, UNIT, FETCH, TRAIN])
    out(f'基线四个测试文件：rc={base_rc} {base_tot} 红={sorted(base_red)}')
    assert base_rc == 0 and not base_red
    survivors, equiv_killed, results = [], [], []
    for label, rel, old, new, expect, kind, files in MUTANTS:
        fresh()
        src = open(f'{MUT}/{rel}').read()
        assert src.count(old) == 1, f'{label}: 原文命中 {src.count(old)} 处（应恰 1 处）'
        open(f'{MUT}/{rel}', 'w').write(src.replace(old, new))
        if label.startswith('a3 '):
            s = open(f'{MUT}/{rel}').read()
            assert s.count(A3_SECOND[0]) == 1
            open(f'{MUT}/{rel}', 'w').write(s.replace(*A3_SECOND))
        brc, bo = build()
        if brc != 0:
            results.append((label, kind, sorted(expect), None, 'BUILD-FAIL ' + ' | '.join(re.findall(r'error TS\d+:.*', bo)[:2])))
            out(f'BUILD-FAIL {label}: ' + ' | '.join(re.findall(r'error TS\d+:.*', bo)[:2]))
            continue
        rc, red, tot, tap = run(files)
        got = {e for e in expect if any(e in r for r in red)}
        extra = [r for r in red if not any(e in r for e in expect)]
        if kind == 'kill':
            ok = got == expect
            verdict = 'KILLED' if ok else 'SURVIVED'
        elif kind == 'equivalent':
            ok = not red
            verdict = '存活（等价，符合预期）' if ok else '被杀（等价体不该红）'
        else:
            ok = got == expect
            verdict = '红（按设计）' if ok else '未红'
        if kind == 'kill' and not ok:
            survivors.append(label)
        if kind == 'equivalent' and not ok:
            equiv_killed.append(label)
        results.append((label, kind, sorted(expect), sorted(red), verdict))
        missing = sorted(expect - got)
        out(f'{verdict:14s} {label} | {tot} 红={len(red)}' + (f' 缺={missing}' if missing else '') + (f' 额外红={len(extra)}' if extra else ''))
        for r in sorted(red):
            out(f'                 not ok {r[:110]}')
    out(f'== 结果：kill 类 {sum(1 for m in MUTANTS if m[5] == "kill")} 个，存活 {len(survivors)} 个 {survivors}；'
        f'等价类 {sum(1 for m in MUTANTS if m[5] == "equivalent")} 个，被杀 {len(equiv_killed)} 个 {equiv_killed} ==')
    out(f'== MUTATION-MATRIX end {time.strftime("%F %T")} ==')
    sys.exit(1 if survivors or equiv_killed else 0)


if __name__ == '__main__':
    main()
