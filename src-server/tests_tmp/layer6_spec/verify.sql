-- Layer 6 §5.4 SQL + P2/P3b/ON CONFLICT 实测脚本
\set ON_ERROR_STOP off
\echo '\n========== 灌测试数据 =========='
INSERT INTO projects (id, name, storage_path) VALUES (1, 'spec_test', '/tmp/x');
-- 4 个 page：page_id 字典序 z/a/b/c，其中 z-page 相关度最高
INSERT INTO wiki_pages (project_id, path, title, content) VALUES
  (1, 'wiki/sources/zzz-top.md',  'ZZZ 高相关页', '这是相关度最高但 page_id 字典序最靠前的页面内容，用于验证 LIMIT 不按字典序取'),
  (1, 'wiki/sources/aaa-low.md',  'AAA 低相关页', '相关度低但字典序靠前'),
  (1, 'wiki/sources/bbb-mid.md',  'BBB 中相关页', '相关度中等'),
  (1, 'wiki/sources/ccc-mid2.md', 'CCC 中相关页2','相关度中等');

-- chunk 向量：z-page 相关度最高(向量与查询最近)、aaa 最低
-- bge-m3 是 1024 维；这里用低维向量近似余弦排序不影响 DISTINCT ON/LIMIT 逻辑验证
-- 用 array 构造 1024 维向量：z 偏向[1,0,0...], 查询=[1,0,0...]
DO $$
DECLARE q vector(1024) := (SELECT array_agg(1.0)::float4[] ORDER BY ordinality FROM generate_series(1,512) WITH ORDINALITY);  -- 占位，下面真实构造
BEGIN END $$;

-- 用更直接方式：构造查询向量 q(全0,首维1)，page 向量按相关度不同
-- z = (1,0,0,...) 与 q 同向 → cosine=0 score=1
-- m = (1,1,0,...)/norm
-- a = (0,1,0,...) 与 q 正交 → cosine=0 score=0.5(1-0=1? 余弦距离0→score1; 正交距离1→score0)
\echo '\n========== 直接用 INSERT 构造 1024 维向量 =========='
-- 查询向量：[1, 0, 0, ...]
-- z-page:   [1, 0, 0, ...]   score=1.0(最高)
-- b-page:   [1, 1, 0, ...]   score≈0.707
-- c-page:   [1, 1, 0, ...]   score≈0.707
-- a-page:   [0, 1, 0, ...]   score=0.0(最低,正交)

-- z-page 多 chunk(验证一page多chunk去重)
INSERT INTO embeddings (project_id, wiki_page_id, chunk_index, chunk_text, heading_path, content) VALUES
  (1, 'wiki/sources/zzz-top.md', 0, 'zzz 第0段最高分', '## Z0',
     (SELECT ('[' || string_agg('1', ',') || ']')::vector FROM generate_series(1,1024))),
  (1, 'wiki/sources/zzz-top.md', 1, 'zzz 第1段次高分', '## Z1',
     (SELECT ('[' || string_agg(CASE WHEN i<=1 THEN '1' ELSE '0' END, ',') || ']')::vector FROM generate_series(1,1024) AS i));
INSERT INTO embeddings (project_id, wiki_page_id, chunk_index, chunk_text, heading_path, content) VALUES
  (1, 'wiki/sources/bbb-mid.md', 0, 'bbb 段落', '## B',
     (SELECT ('[' || string_agg(CASE WHEN i<=1 THEN '1' ELSE '0' END, ',') || ']')::vector FROM generate_series(1,1024) AS i)),
  (1, 'wiki/sources/ccc-mid2.md', 0, 'ccc 段落', '## C',
     (SELECT ('[' || string_agg(CASE WHEN i<=1 THEN '1' ELSE '0' END, ',') || ']')::vector FROM generate_series(1,1024) AS i)),
  (1, 'wiki/sources/aaa-low.md', 0, NULL, '## A',
     (SELECT ('[' || string_agg(CASE WHEN i=1 THEN '0' ELSE '1' END, ',') || ']')::vector FROM generate_series(1,1024) AS i));

\echo '\n========== 实测1: spec §5.4 三层 SQL（rerank_top_n=2，page_id 含 z/a/b/c）=========='
\echo '期望：按相关度取 top2 = zzz-top(1.0) + bbb/ccc(~0.707)，而非字典序 aaa/bbb'
WITH params AS (SELECT
  ('[' || (SELECT string_agg('1', ',') FROM generate_series(1,1024)) || ']')::vector AS q,
  1::int AS proj, 40::int AS top_chunks, 2::int AS top_pages
)
SELECT page_id, title, round(score::numeric, 4) AS score, substring(snippet,1,30) AS snippet, (heading_path IS NOT NULL) AS has_heading
FROM (
    SELECT DISTINCT ON (c.wiki_page_id)
           c.wiki_page_id AS page_id, wp.title,
           substring(COALESCE(c.chunk_text, wp.content) FROM 1 FOR 200) AS snippet,
           COALESCE(c.chunk_text, wp.content) AS rerank_text, c.heading_path, c.score
    FROM (
        SELECT e.wiki_page_id, e.chunk_index, e.chunk_text, e.heading_path,
               1.0 - (e.content <=> (SELECT q FROM params)) AS score
        FROM embeddings e WHERE e.project_id = (SELECT proj FROM params)
        ORDER BY e.content <=> (SELECT q FROM params) LIMIT (SELECT top_chunks FROM params)
    ) c
    JOIN wiki_pages wp ON c.wiki_page_id = wp.path AND wp.project_id = (SELECT proj FROM params)
    ORDER BY c.wiki_page_id, c.score DESC
) t
ORDER BY t.score DESC LIMIT (SELECT top_pages FROM params);

\echo '\n========== 实测2: P2 复现（去掉外层子查询的错误版，LIMIT 按字典序取页）=========='
\echo '错误版会把 zzz 丢了，取 aaa/bbb（字典序前2）'
SELECT page_id, round(score::numeric,4) AS score FROM (
    SELECT DISTINCT ON (c.wiki_page_id) c.wiki_page_id AS page_id, c.score
    FROM (SELECT e.wiki_page_id, 1.0-(e.content <=> (SELECT '['||string_agg('1',',')||']'::vector FROM generate_series(1,1024))) AS score
          FROM embeddings e WHERE e.project_id=1 ORDER BY e.content <=> (SELECT '['||string_agg('1',',')||']'::vector FROM generate_series(1,1024)) LIMIT 40) c
    JOIN wiki_pages wp ON c.wiki_page_id=wp.path AND wp.project_id=1
    ORDER BY c.wiki_page_id, c.score DESC
    LIMIT 2
) bad;

\echo '\n========== 实测3: P3b COALESCE 回退（aaa 页 chunk_text=NULL）=========='
\echo 'spec 版：aaa 命中时 snippet 应回退 wp.content，非空'
WITH params AS (SELECT ('['||string_agg('1',',')||']'::vector)::vector AS q FROM generate_series(1,1024))
SELECT c.wiki_page_id, substring(COALESCE(c.chunk_text, wp.content) FROM 1 FOR 40) AS snippet_via_coalesce,
       (c.chunk_text IS NULL) AS chunk_text_is_null
FROM (SELECT e.wiki_page_id, e.chunk_text FROM embeddings e WHERE e.project_id=1 AND e.chunk_text IS NULL LIMIT 5) c
JOIN wiki_pages wp ON c.wiki_page_id=wp.path AND wp.project_id=1;

\echo '\n========== 实测4: ON CONFLICT 失效复现（011 后旧 2 列声明报错）=========='
\echo '期望：报错 there is no unique or exclusion constraint matching ON CONFLICT'
INSERT INTO embeddings (project_id, wiki_page_id, chunk_index, content)
VALUES (1, 'wiki/sources/zzz-top.md', 99, (SELECT '['||string_agg('1',',')||']'::vector FROM generate_series(1,1024)))
ON CONFLICT (project_id, wiki_page_id) DO UPDATE SET content = EXCLUDED.content;

\echo '\n========== 实测5: DELETE+INSERT 替代方案验证（不报错）=========='
\echo '期望：DELETE 旧 + INSERT 新 chunk_index=0，成功'
DELETE FROM embeddings WHERE project_id=1 AND wiki_page_id='wiki/sources/bbb-mid.md';
INSERT INTO embeddings (project_id, wiki_page_id, chunk_index, chunk_text, content) VALUES
  (1, 'wiki/sources/bbb-mid.md', 0, 'bbb 新段落(DELETE+INSERT)',
   (SELECT '['||string_agg(CASE WHEN i<=1 THEN '1' ELSE '0' END,',')||']'::vector FROM generate_series(1,1024) AS i));
SELECT wiki_page_id, chunk_index, chunk_text FROM embeddings WHERE project_id=1 AND wiki_page_id='wiki/sources/bbb-mid.md';
