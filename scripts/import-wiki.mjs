// scripts/import-wiki.mjs
// 一次性 wiki 导入：读 <wiki_dir>/wiki/**/*.md，js-yaml 解析 frontmatter，幂等 upsert 进 wiki_pages。
// 用法: node scripts/import-wiki.mjs <wiki_dir> <project_name> <user_id>
// 例: node scripts/import-wiki.mjs ~/Documents/English-Teaching English-Teaching 3
import pg from "pg";
import yaml from "js-yaml";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const [,, WIKI_DIR, PROJECT_NAME, USER_ID_S] = process.argv;
if (!WIKI_DIR || !PROJECT_NAME || !USER_ID_S) {
  console.error("用法: node scripts/import-wiki.mjs <wiki_dir> <project_name> <user_id>");
  console.error("例: node scripts/import-wiki.mjs ~/Documents/English-Teaching English-Teaching 3");
  process.exit(1);
}
const USER_ID = Number(USER_ID_S);
const CONN = "postgres://llmwiki:test123@localhost:5433/llmwiki";

const client = new pg.Client({ connectionString: CONN });
await client.connect();

// ① ensure personal team（backfill：用户若无 team 则建 owner team）
let team_id;
const teamRows = (await client.query("SELECT id FROM teams WHERE created_by = $1", [USER_ID])).rows;
if (teamRows.length === 0) {
  const u = (await client.query("SELECT username FROM users WHERE id = $1", [USER_ID])).rows[0];
  const uname = u?.username || `user-${USER_ID}`;
  const t = (await client.query(
    "INSERT INTO teams (name, created_by) VALUES ($1, $2) RETURNING id",
    [`${uname}'s team`, USER_ID]
  )).rows[0];
  team_id = t.id;
  await client.query(
    "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')",
    [team_id, USER_ID]
  );
  console.log(`created personal team ${team_id} for user ${USER_ID}`);
} else {
  team_id = teamRows[0].id;
}

// ② ensure project（幂等：UNIQUE(team_id,name) 命中则复用）
let project_id;
const projRows = (await client.query(
  "SELECT id FROM projects WHERE team_id = $1 AND name = $2", [team_id, PROJECT_NAME]
)).rows;
if (projRows.length === 0) {
  project_id = (await client.query(
    "INSERT INTO projects (team_id, name, storage_path, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
    [team_id, PROJECT_NAME, WIKI_DIR, USER_ID]
  )).rows[0].id;
  console.log(`created project ${PROJECT_NAME} (id=${project_id})`);
} else {
  project_id = projRows[0].id;
  console.log(`reusing existing project ${PROJECT_NAME} (id=${project_id})`);
}

// ③ walk <wiki_dir>/wiki/**/*.md
async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...await walk(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}
const wikiRoot = join(WIKI_DIR, "wiki");
const files = await walk(wikiRoot);
console.log(`found ${files.length} .md files under ${wikiRoot}`);

// ④ 解析 frontmatter（js-yaml）+ 幂等 upsert
let count = 0;
for (const abs of files) {
  const raw = (await readFile(abs, "utf8")).replace(/^﻿/, "");  // 去 BOM（用转义，不用字面 BOM 字符）
  let frontmatter = {};
  let body = raw;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (m) {
    try {
      frontmatter = yaml.load(m[1]) || {};
    } catch (e) {
      console.warn(`YAML parse fail ${abs}: ${e.message}`);
      frontmatter = {};
    }
    body = raw.slice(m[0].length);
  }
  const path = relative(wikiRoot, abs).split(sep).join("/");  // POSIX 路径
  const title = frontmatter.title
    || body.match(/^#\s+(.+?)\s*$/m)?.[1]
    || path.replace(/\.md$/i, "");
  const page_type = frontmatter.type || "concept";
  // ⚠️ frontmatter/sources/images 都必须 JSON.stringify（pg 不自动序列化对象到 JSONB）
  await client.query(
    `INSERT INTO wiki_pages (project_id, path, title, content, frontmatter, page_type, sources, images)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (project_id, path) DO UPDATE SET
       title = EXCLUDED.title,
       content = EXCLUDED.content,
       frontmatter = EXCLUDED.frontmatter,
       page_type = EXCLUDED.page_type,
       sources = EXCLUDED.sources,
       images = EXCLUDED.images,
       updated_at = NOW()`,
    [
      project_id, path, title, body,
      JSON.stringify(frontmatter), page_type,
      JSON.stringify(frontmatter.sources || []),
      JSON.stringify(frontmatter.images || []),
    ]
  );
  count++;
}
console.log(`imported ${count} pages into ${PROJECT_NAME} (project_id=${project_id})`);
await client.end();
