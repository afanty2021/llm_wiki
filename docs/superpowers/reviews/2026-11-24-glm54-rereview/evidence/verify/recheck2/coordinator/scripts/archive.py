#!/usr/bin/env python3
"""第二轮复审归档：四席报告 + 协调者证据 → docs/superpowers/reviews/2026-11-24-glm54-rereview/evidence/verify/recheck2/

默认只演练（不写任何文件）；加 --apply 才落盘。幂等，可重复运行（每次整体重写目标目录里的同名文件）。
origin 是公开仓：真实教师的企微 id 一律脱敏为 TeachA–TeachG（任务名与用户名之间的大小写差异原样保留），
落盘前后各做一遍卫生扫描（密钥模式 + 残留 id）。脚本本身按运行原样归档。不做任何 git 操作。"""
import os
import re
import subprocess
import sys
import time

SRC = '/tmp/glm54-recheck-20261125'
LIVE = '/Users/berton/Github/kb-obsidian/llm_wiki'
REVIEW = LIVE + '/docs/superpowers/reviews/2026-11-24-glm54-rereview'
DST = REVIEW + '/evidence/verify/recheck2'
APPLY = '--apply' in sys.argv
OWNER = '<所有者企微名>'

RED = [
    ('wecom_TeachF', 'wecom_TeachF'), ('wecom:teachf', 'wecom:teachf'), ('lt-tutor-weekly:teachf', 'lt-tutor-weekly:teachf'),
    ('TEACHF', 'TEACHF'), ('TeachF', 'TeachF'), ('teachf', 'teachf'),
    ('wecom_TeachA', 'wecom_TeachA'), ('TeachA', 'TeachA'),
    ('wecom_TeachB', 'wecom_TeachB'), ('TeachB', 'TeachB'),
    ('wecom_TeachC', 'wecom_TeachC'), ('TeachC', 'TeachC'),
    ('wecom_TeachD', 'wecom_TeachD'), ('TeachD', 'TeachD'),
    ('wecom_TeachE', 'wecom_TeachE'), ('TeachE', 'TeachE'),
    ('TeachG', 'TeachG'), (OWNER, '<所有者企微名>'),
]
RESID = re.compile(r'\b(TeachA|TeachB|TeachC|TeachD|TeachE|TeachF|teachf|TEACHF|TeachG|' + OWNER + r')\b')
PATS = [
    ('key-prefix', re.compile(r'\b(sk-[A-Za-z0-9_\-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9\-]{10,}|AIza[0-9A-Za-z_\-]{30,}|eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,})')),
    ('kv-secret', re.compile(r'(?i)\b(api[_\-]?key|secret|token|password|passwd|access[_\-]?key|authorization)\b\s*[:=]\s*["\']?([A-Za-z0-9_\-\.\/+]{12,})')),
    ('email', re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')),
    ('cn-mobile', re.compile(r'(?<![\dA-Za-z])1[3-9]\d{9}(?![\dA-Za-z])')),
    ('teacher-id', RESID),
]


def redact(text):
    for a, b in RED:
        text = text.replace(a, b)
    return text


def read(rel):
    p = os.path.join(SRC, rel)
    return open(p, errors='replace').read() if os.path.isfile(p) else None


def head(seat, window, extra):
    return ('<!-- 归档件：第二轮复审 %s。评审窗口 %s。归档时只做了两件事：加这条头注；%s。其余一字未改。'
            '裁决与协调者亲验见 report.md §十一。 -->\n\n' % (seat, window, extra))


def strip_lines(text, drops):
    return '\n'.join(l for l in text.split('\n') if not any(d in l for d in drops)) + '\n'


def tauri_extract():
    t = read('C/raw/tauri-build.txt')
    if t is None:
        return None
    lines = t.split('\n')
    keep = [l for l in lines if re.search(r'^(> |   > |    Finished|    Bundling|    Built application|         /)|warning: unused|error\[|vite v|modules transformed|✓ built', l)]
    mcp_ci = [l for l in lines if re.search(r'mcp', l, re.I)]
    mcp_word = [l for l in lines if re.search(r'\bmcp', l, re.I)]
    return ('$ 摘自 tauri-build.txt（%d 行）：脚本链与构建结论行；全日志大小写不敏感含 mcp 的行 %d 条（全是文件名 ImCp… 这类巧合，含 mcp 词的 %d 条）\n'
            % (len(lines), len(mcp_ci), len(mcp_word))) + '\n'.join(keep[:80]) + '\n'


PLAN = [
    # (目标相对路径, 来源, 处理)
    ('R1.md', 'R1-report.md', lambda t: head('R1 席（N-2 结构性根治 e9738730）', '2026-11-25 上午', '未做其它改动') + t),
    ('R2.md', 'R2b-report.md', lambda t: head('R2 席（web-clip undici 崩溃修复 0f17695f + 回归钉 8887af93 + 技能 note e8ee2893）', '2026-11-25',
                                                '未做其它改动。说明：首任 R2 席在 11-25 11:47 断线、未产出报告；本件是重派席（R2b）的原文，'
                                                '首任席留在临时目录里的中间产物只当作线索用过、未采信其结论，也未归档') + t),
    ('R3.md', 'R3-report.md', lambda t: head('R3 席（03:17 周报巡检 provision 断链修复 710111b0）', '2026-11-25 18:55–19:23',
                                             '把 6 位真实教师的企微 id 脱敏为 TeachA–TeachF（任务名与用户名之间的大小写差异原样保留：TeachF / teachf），'
                                             '旧文档里提到的另一位记为 TeachG') + redact(t)),
    ('R4.md', 'R4-report.md', lambda t: head('R4 席（记录 7b6da1d6 + report.md 权威账目 + 10.7 + 成文防线 300c3771/e9738730）', '2026-11-25 19:31–20:11',
                                             '把真实教师的企微 id 脱敏为 TeachA–TeachG（如出现）') + redact(t)),
    ('coordinator/notes.md', 'C/coordinator-notes.md', redact),
    ('coordinator/summary-light.txt', 'C/raw/summary-light.txt', None),
    ('coordinator/summary-heavy.txt', 'C/raw/summary-heavy.txt', None),
    ('coordinator/summary-r2.txt', 'C/raw/summary-r2.txt', None),
    ('coordinator/summary-tauri.txt', 'C/raw/summary-tauri.txt', None),
    ('coordinator/tauri-build-extract.txt', None, tauri_extract),
    ('coordinator/summary-r3.txt', 'C/raw/summary-r3.txt', redact),
    ('coordinator/test-mocks-head.txt', 'C/raw/test-mocks-head.txt', None),
    ('coordinator/record-loaded-timeline.txt', 'C/raw/record-loaded-timeline.txt',
     lambda t: redact(strip_lines(t, ('msg=', 'title:', 'clipped_by')))),
    ('coordinator/hygiene-scan.txt', 'C/raw/hygiene-scan.txt', None),
    ('coordinator/r3-dryrun-raw.txt', 'C/raw/r3-dryrun-raw.txt', redact),
    ('coordinator/r3-probe-nofix.txt', 'C/raw/r3-probe-nofix.txt', redact),
    ('coordinator/r3-probe-fix.txt', 'C/raw/r3-probe-fix.txt', redact),
    ('coordinator/served-8080.txt', 'C/raw/served-8080.txt', None),
    ('coordinator/summary-r4.txt', 'C/raw/summary-r4.txt', None),
    ('coordinator/summary-tauri-mcp.txt', 'C/raw/summary-tauri-mcp.txt', None),
    ('coordinator/nail-hardened-C.test.ts', 'C/nails/build-form.hardened.test.ts', None),
    ('coordinator/q4-loaded-evidence.txt', 'C/raw/q4-loaded-evidence.txt', redact),
    ('coordinator/scripts/report-corrections.py', 'C/scripts/report-corrections.py', None),
    ('coordinator/scripts/r1-verify.py', 'C/scripts/r1-verify.py', None),
    ('coordinator/scripts/r2-verify.py', 'C/scripts/r2-verify.py', None),
    ('coordinator/scripts/tauri-e2e.py', 'C/scripts/tauri-e2e.py', None),
    ('coordinator/scripts/tauri-mcp-freshness.py', 'C/scripts/tauri-mcp-freshness.py', None),
    ('coordinator/scripts/r3-verify.py', 'C/scripts/r3-verify.py', redact),
    ('coordinator/scripts/r4-nail-verify.py', 'C/scripts/r4-nail-verify.py', None),
    ('coordinator/scripts/q4-evidence.py', 'C/scripts/q4-evidence.py', None),
    ('coordinator/scripts/q4-session-probe.py', 'C/scripts/q4-session-probe.py', None),
    ('coordinator/scripts/hygiene-scan.py', 'C/scripts/hygiene-scan.py', None),
    # 脚本自带的脱敏对照表本身就是真实 id 的清单，归档件同样过一遍脱敏
    ('coordinator/scripts/archive.py', 'C/scripts/archive.py', redact),
    ('r3-raw/00-corrections.txt', 'R3/raw/00-corrections.txt', None),
    ('r3-raw/11-dryrun-raw.txt', 'R3/raw/11-dryrun-raw.txt', redact),
    ('r3-raw/10-probe.txt', 'R3/raw/10-probe.txt', redact),
    ('r4-raw/mcpstderr-win.txt', 'R4/mcpstderr-win.txt', redact),
    ('r4-raw/agentlog-win.txt', 'R4/agentlog-win.txt', lambda t: redact(strip_lines(t, ('msg=', 'title:', 'clipped_by')))),
    ('r4-raw/mutate.mjs', 'R4/mutate.mjs', None),
    ('r4-raw/mut-baseline.txt', 'R4/mut-baseline.log', None),  # 后缀用 .txt：.gitignore 的 *.log 会静默挡掉 .log 证据 |
    ('r4-raw/mut-M-g.txt', 'R4/mut-M-g(R4加).log', None),  # 后缀用 .txt：.gitignore 的 *.log 会静默挡掉 .log 证据 |
    ('r4-raw/mut-M-h.txt', 'R4/mut-M-h(R4加).log', None),  # 后缀用 .txt：.gitignore 的 *.log 会静默挡掉 .log 证据 |
    ('r4-raw/mut-M-k.txt', 'R4/mut-M-k(R4加).log', None),  # 后缀用 .txt：.gitignore 的 *.log 会静默挡掉 .log 证据 |
    ('r4-raw/mut-M-l.txt', 'R4/mut-M-l(R4加).log', None),  # 后缀用 .txt：.gitignore 的 *.log 会静默挡掉 .log 证据 |
    ('r4-raw/up-agents.txt', 'R4/up-agents.txt', None),
]

README = '''# 第二轮复审归档（2026-11-25，用户口令「max 复查近期评审修复」）

对象是 11-24 晚闭环复审之后新增、且从未被独立评审过的 8 笔提交：`7b6da1d6`、`710111b0`、`300c3771`、`e9738730`、`cb78ed06`（未推送）与 `0f17695f`、`e8ee2893`、`8887af93`（已推）。
方式：四个互不相见的独立评审席串行派出（每席只拿任务书），协调者对每席的 Important 与承重数字亲手重验。
裁决与结论以 [`report.md`](../../../../report.md) §十一 为准，本目录只是原文与证据。

| 件 | 内容 |
|---|---|
| `R1.md`–`R4.md` | 四席评审报告原文（各带一行归档头注） |
| `coordinator/notes.md` | 协调者亲验笔记（每席亲验了什么、数字是多少） |
| `coordinator/summary-*.txt` | 协调者各轮验证脚本的汇总输出：R1 变异矩阵（light）、构建行为与 `test:mocks`（heavy）、tauri 端到端、R2、R3、R4 回归钉矩阵、暖构建下 mcp-server/dist 变更 / 缺失实验 |
| `coordinator/nail-hardened-C.test.ts` | 协调者按变异结果再加固的回归钉全文（19 个变异体全杀，未入仓，待裁定） |
| `coordinator/record-loaded-timeline.txt`、`coordinator/q4-loaded-evidence.txt` | 「崩溃修复是否在 11-24 22:00 前加载」的日志与会话库取证（只留时间戳、工具名、链接实参与工具回执字符数） |
| `coordinator/served-8080.txt` | :8080 实际下发 web 形态的 curl 取证 |
| `coordinator/r3-*.txt`、`r3-raw/`、`r4-raw/` | R3、R4 的沙箱探针、live dry-run、回归钉变异与日志窗口原始输出（协调者一份、评审席一份）与评审席登记的原始文件瑕疵 |
| `coordinator/scripts/` | 协调者验证、取证、归档与改句脚本，按运行原样归档（路径写死为本机）。`report-corrections.py` 是对 report.md 行内勘误的逐条替换表（默认演练，`--apply` 才写） |
| `coordinator/hygiene-scan.txt` | 推送前卫生扫描（命中只留掩码） |

说明：

- **脱敏**：origin 是公开仓。归档时把真实教师的企微 id 统一换成 `TeachA`–`TeachG`；任务名与用户名之间的大小写差异（R3-I1 的要害）原样保留为 `TeachF` / `teachf`。日志取证里带消息正文的行、收藏页标题行未入档。协调者脚本里的教师 id 同样已脱敏（只动字符串字面量与注释；`r3-verify.py`、`archive.py` 两个脚本原本带真实 id，归档件里连脱敏对照表也换成了化名），照抄运行需换回真实 id。
- **原件**：各席报告与全部原始输出最初落在 `/tmp/glm54-recheck-20261125/`（易失），本目录收录的是其中承重的部分；没有收录的中间产物不承重。
- **R3 席的原始文件有它自己登记的瑕疵**，见 `r3-raw/00-corrections.txt`；归档的 `10-probe.txt` 不在作废之列。
'''


def scan(label, texts):
    bad = 0
    print('卫生扫描 [%s]:' % label)
    for name, txt in sorted(texts.items()):
        hits = []
        for pname, rx in PATS:
            hs = sorted({(m.group(2) if pname == 'kv-secret' else m.group(0)) for m in rx.finditer(txt)})
            if hs:
                hits.append('%s×%d %s' % (pname, len(hs), [h[:6] + '…(%d)' % len(h) for h in hs[:6]]))
                if pname in ('key-prefix', 'teacher-id'):
                    bad += 1
        print('   %-46s %6d 字节 %s' % (name, len(txt.encode()), ' '.join(hits) if hits else 'clean'))
    return bad


def main():
    print('模式:', '落盘' if APPLY else '演练（不写）', '| 目标:', DST.replace(LIVE, '<repo>/'))
    texts = {}
    missing = []
    for rel, src, fn in PLAN:
        if src is None and rel.endswith('tauri-build-extract.txt'):
            t = fn()
        else:
            raw = read(src)
            if raw is None:
                missing.append(src)
                continue
            t = fn(raw) if fn else raw
        texts[rel] = t
    texts['README.md'] = README
    for m in missing:
        print('   （缺源文件，跳过）', m)
    bad = scan('落盘前', texts)
    if not APPLY:
        print('演练结束：bad=%d' % bad)
        return
    for rel, t in texts.items():
        p = os.path.join(DST, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, 'w').write(t)
    on_disk = {}
    for root, _, fs in os.walk(DST):
        for f in fs:
            p = os.path.join(root, f)
            on_disk[os.path.relpath(p, DST)] = open(p, errors='replace').read()
    bad2 = scan('落盘后回读', on_disk)
    # 证据入库后要对数：.gitignore 的 *.log 会静默挡掉文件而 git status 不提示（首轮 10.3 #3 的教训）
    p = subprocess.run(['git', '--no-optional-locks', '-C', LIVE, 'status', '--short', '--ignored', '--', os.path.relpath(DST, LIVE)],
                       capture_output=True, text=True)
    ignored = [l[3:] for l in p.stdout.splitlines() if l.startswith('!!')]
    for l in ignored:
        print('   被 .gitignore 挡住:', l)
    bad2 += len(ignored)
    print('落盘 %d 个文件，bad=%d | %s' % (len(on_disk), bad2, time.strftime('%Y-%m-%d %H:%M:%S')))
    sys.exit(1 if bad2 else 0)


if __name__ == '__main__':
    main()
