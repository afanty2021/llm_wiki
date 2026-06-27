-- §5.4 三层 SQL + P2/P3b/ON CONFLICT 实测（维度 1024，查询向量预存）
\set ON_ERROR_STOP off
-- 把 1024 维查询向量 q 预存到 psql 变量（[1,0,0,...]）
SELECT '['||string_agg(CASE WHEN i=1 THEN '1' ELSE '0' END,',')||']' AS q
FROM generate_series(1,1024) i \gset

\echo '=== 灌数据：4 page，page_id 字典序 z/a/b/c，z 相关度最高 ==='
INSERT INTO projects (id, name, storage_path) VALUES (1,'t','/tmp/x');
INSERT INTO wiki_pages (project_id, path, title, content) VALUES
  (1,'wiki/sources/zzz.md','ZZZ高相关','zzz 整页内容用于COALESCE回退测试'),
  (1,'wiki/sources/aaa.md','AAA低相关','aaa 整页内容'),
  (1,'wiki/sources/bbb.md','BBB中相关','bbb 整页内容'),
  (1,'wiki/sources/ccc.md','CCC中相关','ccc 整页内容');
-- 1024 维：z score=1.0；b/c≈0.707；a=0(正交)。aaa chunk_text=NULL 测 COALESCE
INSERT INTO embeddings (project_id, wiki_page_id, chunk_index, chunk_text, heading_path, content) VALUES
  (1,'wiki/sources/zzz.md',0,'zzz 第0段最高分','## Z0', (SELECT '['||string_agg(CASE WHEN i=1 THEN '1' ELSE '0' END,',')||']' FROM generate_series(1,1024) i)::vector),
  (1,'wiki/sources/zzz.md',1,'zzz 第1段次高分','## Z1', (SELECT '['||string_agg(CASE WHEN i<=2 THEN '1' ELSE '0' END,',')||']' FROM generate_series(1,1024) i)::vector),
  (1,'wiki/sources/bbb.md',0,'bbb 段落','## B', (SELECT '['||string_agg(CASE WHEN i<=2 THEN '1' ELSE '0' END,',')||']' FROM generate_series(1,1024) i)::vector),
  (1,'wiki/sources/ccc.md',0,'ccc 段落','## C', (SELECT '['||string_agg(CASE WHEN i<=2 THEN '1' ELSE '0' END,',')||']' FROM generate_series(1,1024) i)::vector),
  (1,'wiki/sources/aaa.md',0,NULL,'## A', (SELECT '['||string_agg(CASE WHEN i=1 THEN '0' ELSE '1' END,',')||']' FROM generate_series(1,1024) i)::vector);

\echo ''
\echo '=== 实测1: spec §5.4 三层 SQL（top_pages=2）=== 期望 zzz(1.0)+bbb/ccc，非字典序 aaa'
SELECT page_id, title, round(score::numeric,4) AS score, substring(snippet,1,18) AS snippet, has_heading FROM (
  SELECT page_id, title, snippet, heading_path IS NOT NULL AS has_heading, score FROM (
    SELECT DISTINCT ON (c.wiki_page_id) c.wiki_page_id AS page_id, wp.title,
      substring(COALESCE(c.chunk_text, wp.content) FROM 1 FOR 200) AS snippet, c.heading_path, c.score
    FROM (SELECT e.wiki_page_id, e.chunk_text, e.heading_path, 1.0-(e.content <=> :'q'::vector) AS score
          FROM embeddings e WHERE e.project_id=1 ORDER BY e.content <=> :'q'::vector LIMIT 40) c
    JOIN wiki_pages wp ON c.wiki_page_id=wp.path AND wp.project_id=1
    ORDER BY c.wiki_page_id, c.score DESC
  ) t ORDER BY t.score DESC LIMIT 2
) final;

\echo ''
\echo '=== 实测2: P2 复现（错误版：DISTINCT ON 后直接 LIMIT 2 无外层排序）=== 期望错取 aaa+bbb 丢 zzz'
SELECT page_id, round(score::numeric,4) AS score FROM (
  SELECT DISTINCT ON (c.wiki_page_id) c.wiki_page_id AS page_id, c.score
  FROM (SELECT e.wiki_page_id, 1.0-(e.content <=> :'q'::vector) AS score
        FROM embeddings e WHERE e.project_id=1 ORDER BY e.content <=> :'q'::vector LIMIT 40) c
  JOIN wiki_pages wp ON c.wiki_page_id=wp.path AND wp.project_id=1
  ORDER BY c.wiki_page_id, c.score DESC LIMIT 2
) bad;

\echo ''
\echo '=== 实测3: P3b COALESCE 回退 === aaa chunk_text=NULL，snippet 应回退 wp.content'
SELECT c.wiki_page_id, (c.chunk_text IS NULL) AS chunk_null,
       substring(COALESCE(c.chunk_text, wp.content),1,25) AS snippet,
       (COALESCE(c.chunk_text, wp.content) IS NOT NULL) AS rerank_has_text
FROM embeddings c JOIN wiki_pages wp ON c.wiki_page_id=wp.path AND wp.project_id=1
WHERE c.chunk_text IS NULL;

\echo ''
\echo '=== 实测4: ON CONFLICT 失效复现 === 期望报错 no unique or exclusion constraint matching'
INSERT INTO embeddings (project_id, wiki_page_id, chunk_index, content)
VALUES (1,'wiki/sources/zzz.md',99, :'q'::vector)
ON CONFLICT (project_id, wiki_page_id) DO UPDATE SET content=EXCLUDED.content;

\echo ''
\echo '=== 实测5: DELETE+INSERT 替代 === 期望成功，bbb 仅新行'
DELETE FROM embeddings WHERE project_id=1 AND wiki_page_id='wiki/sources/bbb.md';
INSERT INTO embeddings (project_id, wiki_page_id, chunk_index, chunk_text, content)
VALUES (1,'wiki/sources/bbb.md',0,'bbb 新段落DELETE+INSERT', (SELECT '['||string_agg(CASE WHEN i<=2 THEN '1' ELSE '0' END,',')||']' FROM generate_series(1,1024) i)::vector);
SELECT wiki_page_id, chunk_index, chunk_text FROM embeddings WHERE project_id=1 AND wiki_page_id='wiki/sources/bbb.md';
