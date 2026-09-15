#!/usr/bin/env python3
# tools/rename-think-slugs.py — Think 2e slug 口径统一（2026-09-13，用户拍板）
#   状态：已执行完毕（2026-09-13，ledger ~/kb-dumps/.think-rename-ledger.json：68 页
#   改名、残留 0）——留存备查勿当待办；重跑有结构校验+默认干跑双重防误跑。
#   口径：think 2e=第二版；think N=第 N 级；think 0=Starter。数字=级别、2e=版次。
#   目标形态：think-2e-lN[-uM[-topic]][-材料后缀]；welcome 单元=u0。
#   机制：path 改名无 API 端点 → wiki_pages+embeddings 同事务 UPDATE（向量按 path 键，
#   改名不换内容故向量仍有效，仅重键）；入链改写走 API PUT（wiki-cleanup.put_page，
#   fm 补全+乐观锁+内容变更自动重嵌）。干跑默认，--apply 才写。
#   碰撞组（同单元 TB/TN 双胞胎）不改名，留 concept-merge 合并后由幸存者继承干净 stem。
import argparse, csv, json, os, re, subprocess, sys, time
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import importlib
wc_spec = importlib.util.spec_from_file_location("wc", os.path.join(HERE, "wiki-cleanup.py"))
wc = importlib.util.module_from_spec(wc_spec)
wc_spec.loader.exec_module(wc)

RE_LINK = wc.RE_LINK

# (old_path, new_path, note)
MAPPING = [
    # A. think-2e-unit-N L2 家族（sources=Think-Teachers-L2 / TN Ch12-l2，全部 L2）
    ("entities/think-2e-unit-1-incredible-people.md", "entities/think-2e-l2-u1-incredible-people.md", "L2 TN"),
    ("entities/think-2e-unit-2-a-good-education.md", "entities/think-2e-l2-u2-a-good-education.md", "L2 TN"),
    ("entities/think-2e-unit-3-on-the-screen.md", "entities/think-2e-l2-u3-on-the-screen.md", "L2 TN"),
    ("entities/think-2e-unit-4-online-life.md", "entities/think-2e-l2-u4-online-life.md", "L2 TN"),
    ("entities/think-2e-unit-5-music-to-my-ears.md", "entities/think-2e-l2-u5-music-to-my-ears.md", "L2 TN"),
    ("entities/think-2e-unit-6-no-planet-b.md", "entities/think-2e-l2-u6-no-planet-b.md", "L2 TN"),
    ("entities/think-2e-unit-7-the-future-is-now.md", "entities/think-2e-l2-u7-the-future-is-now.md", "L2 TB Ch09"),
    ("entities/think-2e-unit-8-science-and-us.md", "entities/think-2e-l2-u8-science-and-us.md", "L2 TN"),
    ("entities/think-2e-unit-9-working-week.md", "entities/think-2e-l2-u9-working-week.md", "L2 TN"),
    ("entities/think-2e-unit-10-mind-and-body.md", "entities/think-2e-l2-u10-mind-and-body.md", "L2 TB Ch12"),
    ("entities/think-2e-unit-12-rules-and-regulations.md", "entities/think-2e-l2-u12-rules-and-regulations.md", "L2 TN"),
    # B. 单元散形（级别按 sources 定谳；all-together 实为 L0——source=Think-Teachers-L0/Ch03 且 think-teachers-l0 页内证）
    ("entities/think-level-1-unit-1-all-together.md", "entities/think-2e-l0-u1-all-together.md", "⚠级别纠错 L1→L0"),
    ("entities/think-level-1-unit-7-smart-life.md", "entities/think-2e-l1-u7-smart-life.md", ""),
    ("entities/think-teachers-level-1-unit-6-friends-forever.md", "entities/think-2e-l1-u6-friends-forever.md", ""),
    ("entities/think-unit-2-spending-money.md", "entities/think-2e-l1-u2-spending-money.md", ""),
    ("entities/think-unit-6-best-friends.md", "entities/think-2e-l0-u6-best-friends.md", "source=L0 Ch08"),
    ("concepts/think-l0-unit-7-living-for-sport.md", "concepts/think-2e-l0-u7-living-for-sport.md", ""),
    ("concepts/think-teachers-l3-unit-1-big-decisions.md", "concepts/think-2e-l3-u1-big-decisions.md", ""),
    # C. welcome/review（welcome 单元=u0）
    ("entities/welcome-unit-think-l0.md", "entities/think-2e-l0-u0-welcome.md", ""),
    ("entities/review-welcome-think-l0.md", "entities/think-2e-l0-u0-review.md", ""),
    ("entities/think-teachers-l1-welcome-section.md", "entities/think-2e-l1-u0-welcome.md", ""),
    ("entities/think-teachers-l2-ch2-welcome-section.md", "entities/think-2e-l2-u0-welcome.md", ""),
    ("entities/think-teachers-l3-welcome-unit.md", "entities/think-2e-l3-u0-welcome.md", ""),
    # D. 级别/书页
    ("entities/think-2nd-edition-level-0.md", "entities/think-2e-l0.md", ""),
    ("entities/think-2nd-edition-level-1.md", "entities/think-2e-l1.md", "stub 144b"),
    ("entities/think-2nd-edition-level-2.md", "entities/think-2e-l2.md", ""),
    ("entities/think-second-edition.md", "entities/think-2e.md", ""),
    ("entities/think-teachers-l0.md", "entities/think-2e-l0-teachers-book.md", ""),
    ("entities/think-second-edition-level1.md", "entities/think-2e-l1-teachers-book.md", ""),
    ("entities/think-second-edition-students-book-2.md", "entities/think-2e-l2-students-book.md", "source=L2 Ch15"),
    ("entities/think-second-edition-students-book-3.md", "entities/think-2e-l3-students-book.md", "source=L3 Ch15"),
    # E. 材料页
    ("entities/think-2nd-edition-level-0-projects.md", "entities/think-2e-l0-projects.md", ""),
    ("entities/think-2nd-edition-level-1-projects.md", "entities/think-2e-l1-projects.md", ""),
    ("entities/think-2nd-edition-level-1-communication-teachers-notes.md", "entities/think-2e-l1-communication-teachers-notes.md", ""),
    ("entities/think-2e-communication-teachers-notes.md", "entities/think-2e-l2-communication-teachers-notes.md", "source=TN Ch12-l2"),
    ("entities/think-level-3-communication-teachers-notes.md", "entities/think-2e-l3-communication-teachers-notes.md", ""),
    ("entities/think-starter-communication-teachers-notes.md", "entities/think-2e-l0-communication-teachers-notes.md", ""),
    ("entities/think-level-3-grammar-presentations.md", "entities/think-2e-l3-grammar-presentations.md", ""),
    ("entities/think-starter-grammar-presentations.md", "entities/think-2e-l0-grammar-presentations.md", ""),
    ("entities/think-level-0-workbook.md", "entities/think-2e-l0-workbook.md", ""),
    ("entities/think-level-1-literature-worksheets.md", "entities/think-2e-l1-literature-worksheets.md", ""),
    ("entities/think-level-2-literature-worksheets.md", "entities/think-2e-l2-literature-worksheets.md", ""),
    ("entities/think-2e-level-3-projects-teacher-notes.md", "entities/think-2e-l3-projects-teacher-notes.md", ""),
    ("entities/think-2e-level-3-videoscripts.md", "entities/think-2e-l3-videoscripts.md", ""),
    ("notes/think2e-l1-videoscripts.md", "notes/think-2e-l1-videoscripts.md", ""),
    ("entities/think-students-book.md", "entities/think-2e-students-book.md", ""),
    ("entities/think-digital-support.md", "entities/think-2e-digital-support.md", ""),
    ("concepts/think-digital-support.md", "concepts/think-2e-digital-support.md", ""),
    # F. 系统批教师单元（think-teachers-lN-unit-N → think-2e-lN-uM-topic，topic 逐字保留）
    ("entities/think-teachers-l0-unit-11.md", "entities/think-2e-l0-u11.md", ""),
    ("entities/think-teachers-l0-unit-3-family-time.md", "entities/think-2e-l0-u3-family-time.md", ""),
    ("entities/think-teachers-l0-unit4-citylife.md", "entities/think-2e-l0-u4-citylife.md", ""),
    ("entities/think-teachers-l0-unit5.md", "entities/think-2e-l0-u5.md", ""),
    ("entities/think-teachers-l0-unit-8-feel-the-rhythm.md", "entities/think-2e-l0-u8-feel-the-rhythm.md", ""),
    ("entities/think-teachers-l1-unit-12-travel-the-world.md", "entities/think-2e-l1-u12-travel-the-world.md", ""),
    ("entities/think-teachers-l1-unit-3.md", "entities/think-2e-l1-u3.md", ""),
    ("entities/think-teachers-l1-unit-4-all-in-the-family.md", "entities/think-2e-l1-u4-all-in-the-family.md", ""),
    ("entities/think-teachers-l1-unit-5-no-place-like-home.md", "entities/think-2e-l1-u5-no-place-like-home.md", ""),
    ("entities/think-teachers-l2-unit-11-breaking-news.md", "entities/think-2e-l2-u11-breaking-news.md", ""),
    ("entities/think-teachers-l3-unit-10-money.md", "entities/think-2e-l3-u10-money.md", ""),
    ("entities/think-teachers-l3-unit-5-storytelling.md", "entities/think-2e-l3-u5-storytelling.md", ""),
    ("entities/think-teachers-l3-unit-6.md", "entities/think-2e-l3-u6.md", ""),
    ("entities/think-teachers-l3-unit-9.md", "entities/think-2e-l3-u9.md", ""),
    # G. 口径 tag 归一（think2e/think-2/think-starter 形态）
    ("entities/pet-test-alignment-think2e.md", "entities/pet-test-alignment-think-2e.md", ""),
    ("concepts/think-2-pronunciation-teaching.md", "concepts/think-2e-l2-pronunciation-teaching.md", ""),
    ("concepts/conditional-progression-think2e.md", "concepts/conditional-progression-think-2e.md", ""),
    ("concepts/present-perfect-progression-think2e.md", "concepts/present-perfect-progression-think-2e.md", ""),
    ("concepts/grammar-vocabulary-review-think-starter.md", "concepts/grammar-vocabulary-review-think-2e-l0.md", ""),
    ("concepts/pronunciation-syllabus-think-starter.md", "concepts/pronunciation-syllabus-think-2e-l0.md", ""),
]

# 碰撞组：不改名，留 concept-merge（同单元 TB/TN 双胞胎，合并后幸存者再继承干净 stem）
DEFERRED = [
    "entities/think-l2-unit12-rules-and-regulations.md",
    "entities/think-teachers-l2-ch05-unit-3.md",
]

PSQL = ["docker", "exec", "src-server-postgres-1", "psql", "-U", "llmwiki", "-d", "llmwiki"]


def psql_rows(sql):
    out = subprocess.run(PSQL + ["-tA", "-F", "\x1f", "-c", sql],
                         capture_output=True, text=True, check=True).stdout
    return [ln.split("\x1f") for ln in out.splitlines() if ln]


def stem_of(path):
    return wc.rla.stem_of(path)


def norm(s):
    return wc.rla.norm_server(s)


def link_target_key(raw_target):
    """链接目标 → (去命名空间、去 .md、去 #anchor 的归一 stem)。"""
    t = raw_target.strip().split("#", 1)[0]
    t = re.sub(r"\.md$", "", t)
    t = t.split("/", 1)[1] if "/" in t and t.split("/", 1)[0] in ("entities", "concepts", "notes", "transcripts", "wiki") else t
    return norm(t)


def rewrite_links(content, old_stem_map):
    """fence 感知；仅改目标 stem 命中改名集的链接，display/anchor 原样保留。"""
    if "[[" not in content:
        return content, 0
    out, n, fence = [], 0, False
    for line in content.split("\n"):
        if line.lstrip().startswith("```"):
            fence = not fence
            out.append(line)
            continue
        if fence:
            out.append(line)
            continue

        def repl(m):
            nonlocal n
            target, disp = m.group(1), m.group(2)
            anchor = ""
            base = target
            if "#" in base:
                base, anchor = base.split("#", 1)
                anchor = "#" + anchor
            key = norm(re.sub(r"\.md$", "", base.strip().split("/", 1)[-1]
                              if base.strip().split("/", 1)[0] in ("entities", "concepts", "notes", "transcripts", "wiki")
                              else base.strip()))
            if key in old_stem_map:
                n += 1
                new_stem = old_stem_map[key]
                new_target = new_stem + anchor
                return f"[[{new_target}|{disp}]]" if disp else f"[[{new_target}]]"
            return m.group(0)

        out.append(RE_LINK.sub(repl, line))
    return "\n".join(out), n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    wc.fresh_dump()
    pages = {p["path"]: p for p in wc.load_pages()}
    print(f"载入 project 614 页面 {len(pages)}")

    errs = []
    olds = [o for o, _, _ in MAPPING]
    news = [n for _, n, _ in MAPPING]
    # 结构校验
    for o in olds:
        if o not in pages:
            errs.append(f"旧路径不存在: {o}")
    newset = {}
    for o, n, _ in MAPPING:
        if n in newset:
            errs.append(f"映射内部目标冲突: {n} <- {newset[n]} & {o}")
        newset[n] = o
        if n in pages and n != o:
            errs.append(f"目标已被占: {n}")
    if set(olds) & set(news):
        errs.append(f"旧新路径相交（链式改名风险）: {set(olds) & set(news)}")
    if errs:
        print("结构性错误，中止：")
        [print(" -", e) for e in errs]
        sys.exit(1)
    print(f"映射 {len(MAPPING)} 项：旧路径全部存在、目标全部空闲、无内部冲突")

    # 入链扫描（全库正文，fence 感知）
    old_stem_map = {}
    for o, n, _ in MAPPING:
        old_stem_map[norm(stem_of(o))] = stem_of(n)
    inbound = {}  # path -> (count, new_content)
    total_links = 0
    for p in pages.values():
        new_c, n = rewrite_links(p["content"], old_stem_map)
        if n:
            inbound[p["path"]] = (n, new_c)
            total_links += n
    print(f"入链：{total_links} 实例 / {len(inbound)} 页待改写")
    for path, (n, _) in sorted(inbound.items(), key=lambda x: -x[1][0])[:12]:
        print(f"   {n:3d}  {path}")

    # 其他 path 引用面（media_assets / review_items）
    olds_sql = ", ".join("'" + o.replace("'", "''") + "'" for o in olds)
    hits_media = int(psql_rows(f"SELECT count(*) FROM media_assets WHERE transcript_page_path IN ({olds_sql})")[0][0])
    hits_review = int(psql_rows(f"SELECT count(*) FROM review_items WHERE affected_pages::text LIKE ANY(ARRAY[{olds_sql}])")[0][0])
    print(f"media_assets 命中: {hits_media}；review_items 命中: {hits_review}")
    if hits_media or hits_review:
        print("⚠ 非 wiki_pages/embeddings 引用面命中，需人工处置后再 apply")
        sys.exit(1)

    # embeddings 现状
    emb = {r[0]: int(r[1]) for r in psql_rows(
        f"SELECT wiki_page_id, count(*) FROM embeddings WHERE project_id=614 AND wiki_page_id IN ({olds_sql}) GROUP BY 1")}
    print(f"embeddings：{len(emb)}/{len(olds)} 个旧路径有向量，共 {sum(emb.values())} 行")

    if not args.apply:
        print("\n[DRY-RUN] 未写入。--apply 执行：备份→SQL 事务改名→入链 PUT")
        return

    # ---- 备份 ----
    ts = time.strftime("%Y%m%d-%H%M%S")
    bd = wc.backup("think-slug-rename", [pages[o] for o in olds],
                   f"Think slug 口径统一 {len(MAPPING)} 页改名前全行备份；入链 {total_links} 实例/{len(inbound)} 页")
    subprocess.run(PSQL + ["-c",
                   f"\\copy (SELECT * FROM embeddings WHERE project_id=614 AND wiki_page_id IN ({olds_sql})) TO '/tmp/.emb_bak.csv' WITH CSV"],
                  check=True, stdout=subprocess.DEVNULL)
    emb_bak = os.path.join(bd, "embeddings.csv")
    subprocess.run(["docker", "cp", "src-server-postgres-1:/tmp/.emb_bak.csv", emb_bak], check=True)
    subprocess.run(["docker", "exec", "src-server-postgres-1", "rm", "-f", "/tmp/.emb_bak.csv"],
                   check=True, stdout=subprocess.DEVNULL)
    with open(os.path.join(bd, "rollback.sql"), "w") as f:
        for o, n, _ in MAPPING:
            f.write(f"UPDATE wiki_pages SET path='{o}' WHERE project_id=614 AND path='{n}';\n")
            f.write(f"UPDATE embeddings SET wiki_page_id='{o}' WHERE project_id=614 AND wiki_page_id='{n}';\n")
    print(f"备份齐：{bd}（页面 CSV + embeddings CSV + rollback.sql）")

    # ---- SQL 单事务：wiki_pages + embeddings ----
    sqlf = f"/tmp/.think-rename-{ts}.sql"
    with open(sqlf, "w") as f:
        f.write("BEGIN;\n")
        for o, n, _ in MAPPING:
            f.write(f"UPDATE wiki_pages SET path='{n}' WHERE project_id=614 AND path='{o}';\n")
        for o, n, _ in MAPPING:
            f.write(f"UPDATE embeddings SET wiki_page_id='{n}' WHERE project_id=614 AND wiki_page_id='{o}';\n")
        f.write("COMMIT;\n")
    subprocess.run(["docker", "cp", sqlf, "src-server-postgres-1:/tmp/rename.sql"], check=True)
    r = subprocess.run(PSQL + ["-v", "ON_ERROR_STOP=1", "-f", "/tmp/rename.sql"],
                       capture_output=True, text=True)
    print(r.stdout[-2000:] if r.stdout else "", r.stderr[-2000:] if r.stderr else "")
    if r.returncode != 0:
        print("SQL 事务失败（已回滚），中止")
        sys.exit(1)
    subprocess.run(["docker", "exec", "src-server-postgres-1", "rm", "-f", "/tmp/rename.sql"],
                   check=True, stdout=subprocess.DEVNULL)
    os.remove(sqlf)

    # 改名后验证：旧路径清零、新路径计数、embeddings 行数守恒
    left = psql_rows(f"SELECT count(*) FROM wiki_pages WHERE project_id=614 AND path IN ({olds_sql})")[0][0]
    emb2 = {r[0]: int(r[1]) for r in psql_rows(
        "SELECT wiki_page_id, count(*) FROM embeddings WHERE project_id=614 AND wiki_page_id LIKE '%think-2e%' GROUP BY 1")}
    print(f"改名后：旧路径残留 {left}（应 0）；think-2e 向量行 {sum(emb2.values())}")

    # ---- 入链改写（API PUT）----
    token = wc.login_default()
    done = fail = 0
    for path, (n, new_c) in sorted(inbound.items()):
        try:
            r = wc.put_page(token, path, new_c, None)
            done += 1
        except Exception as e:
            fail += 1
            print(f"  PUT 失败 {path}: {e}")
    print(f"入链改写：{done} 页 PUT 完成 / {fail} 失败")

    # ---- 终验：正文旧 stem 链接残留 ----
    wc.fresh_dump()
    pages2 = wc.load_pages()
    residue = 0
    for p in pages2:
        _, n = rewrite_links(p["content"], old_stem_map)
        residue += n
    print(f"终验：正文旧 stem 链接残留 {residue}（应 0）；备份/回滚在 {bd}")
    json.dump({"renamed": len(MAPPING), "links": total_links, "inbound_pages": len(inbound),
               "embeddings_rows": sum(emb.values()), "residue_links": residue,
               "backup_dir": bd, "deferred": DEFERRED},
              open(os.path.expanduser("~/kb-dumps/.think-rename-ledger.json"), "w"),
              ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
