use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use serde::Serialize;
use crate::AppError;

// ── 四信号权重（桌面 graph-relevance.ts 原值）──
const W_DIRECT_LINK: f64 = 3.0;
const W_SOURCE_OVERLAP: f64 = 4.0;
const W_COMMON_NEIGHBOR: f64 = 1.5;
const W_TYPE_AFFINITY: f64 = 1.0;

/// 类型亲和度矩阵（桌面 graph-relevance.ts 5 类型原值 + 服务端扩展 4 类型）。
///
/// 【fidelity】桌面原矩阵覆盖 5 canonical 类型（entity/concept/source/query/synthesis）。
/// ingest LLM 的 GENERATION_WIKI_TYPES 多产 4 类（comparison/thesis/methodology/finding），
/// 桌面矩阵不覆盖 → 原 default 0.5 致 type 信号对这些类型偏弱。服务端扩展补全 9×9 对称矩阵
/// （type_affinity_extended_types_hit_and_symmetric 锁对称），让 type 信号对所有 canonical
/// 类型生效。reserved pages（index/log/overview）page_type='system' 仍落 default 0.5（同语义）。
fn type_affinity(a: &str, b: &str) -> f64 {
    let m = |t: &str| -> std::collections::HashMap<&str, f64> {
        let mut h = std::collections::HashMap::new();
        match t {
            "entity" => { h.insert("concept",1.2); h.insert("entity",0.8); h.insert("source",1.0); h.insert("synthesis",1.0); h.insert("query",0.8); h.insert("comparison",1.2); h.insert("thesis",1.0); h.insert("methodology",0.8); h.insert("finding",1.0); }
            "concept" => { h.insert("entity",1.2); h.insert("concept",0.8); h.insert("source",1.0); h.insert("synthesis",1.2); h.insert("query",1.0); h.insert("comparison",1.2); h.insert("thesis",1.2); h.insert("methodology",1.0); h.insert("finding",1.0); }
            "source" => { h.insert("entity",1.0); h.insert("concept",1.0); h.insert("source",0.5); h.insert("query",0.8); h.insert("synthesis",1.0); h.insert("comparison",1.0); h.insert("thesis",0.8); h.insert("methodology",1.0); h.insert("finding",1.2); }
            "query" => { h.insert("concept",1.0); h.insert("entity",0.8); h.insert("synthesis",1.0); h.insert("source",0.8); h.insert("query",0.5); h.insert("comparison",0.8); h.insert("thesis",0.8); h.insert("methodology",1.0); h.insert("finding",0.8); }
            "synthesis" => { h.insert("concept",1.2); h.insert("entity",1.0); h.insert("source",1.0); h.insert("query",1.0); h.insert("synthesis",0.8); h.insert("comparison",1.2); h.insert("thesis",1.2); h.insert("methodology",1.0); h.insert("finding",1.2); }
            // 以下 4 行为服务端扩展（桌面矩阵不覆盖；对称补全见下方测试）
            "comparison" => { h.insert("concept",1.2); h.insert("entity",1.2); h.insert("source",1.0); h.insert("query",0.8); h.insert("synthesis",1.2); h.insert("comparison",0.5); h.insert("thesis",1.0); h.insert("methodology",0.8); h.insert("finding",1.0); }
            "thesis" => { h.insert("concept",1.2); h.insert("entity",1.0); h.insert("source",0.8); h.insert("query",0.8); h.insert("synthesis",1.2); h.insert("comparison",1.0); h.insert("thesis",0.5); h.insert("methodology",0.8); h.insert("finding",1.2); }
            "methodology" => { h.insert("concept",1.0); h.insert("entity",0.8); h.insert("source",1.0); h.insert("query",1.0); h.insert("synthesis",1.0); h.insert("comparison",0.8); h.insert("thesis",0.8); h.insert("finding",1.2); h.insert("methodology",0.5); }
            "finding" => { h.insert("concept",1.0); h.insert("entity",1.0); h.insert("source",1.2); h.insert("query",0.8); h.insert("synthesis",1.2); h.insert("comparison",1.0); h.insert("thesis",1.2); h.insert("methodology",1.2); h.insert("finding",0.8); }
            _ => {}
        }
        h
    };
    *m(a).get(b).unwrap_or(&0.5)
}

#[derive(Clone, Default)]
pub(crate) struct RetrievalNode {
    pub id: String,        // path
    pub title: String,
    pub r#type: String,
    pub sources: HashSet<String>,
    pub out_links: HashSet<String>,
    pub in_links: HashSet<String>,
}

pub(crate) struct RetrievalGraph {
    pub nodes: HashMap<String, RetrievalNode>,
}

impl RetrievalGraph {
    fn neighbors(&self, id: &str) -> HashSet<String> {
        let mut s = HashSet::new();
        if let Some(n) = self.nodes.get(id) {
            for x in &n.out_links { s.insert(x.clone()); }
            for x in &n.in_links { s.insert(x.clone()); }
        }
        s
    }
    /// 节点度数（对齐桌面 getNodeDegree = outLinks.size + inLinks.size，不去重：
    /// 双向邻居计两次）。neighbors()（Adamic-Adar 交集用）仍是去重并集，两者语义不同。
    fn degree(&self, id: &str) -> usize {
        self.nodes.get(id).map(|n| n.out_links.len() + n.in_links.len()).unwrap_or(0)
    }
}

/// 四信号相关性（移植 calculateRelevance）。
pub(crate) fn calculate_relevance(a: &RetrievalNode, b: &RetrievalNode, g: &RetrievalGraph) -> f64 {
    if a.id == b.id { return 0.0; }
    // 1. directLink：求和两方向（移植桌面 forwardLinks + backwardLinks；双向 = 6.0，非 OR 的 3.0）
    let direct = ((a.out_links.contains(&b.id) as i32) + (b.out_links.contains(&a.id) as i32)) as f64 * W_DIRECT_LINK;
    // 2. sourceOverlap
    let shared = a.sources.intersection(&b.sources).count() as f64 * W_SOURCE_OVERLAP;
    // 3. commonNeighbor (Adamic-Adar)
    let na = g.neighbors(&a.id);
    let nb = g.neighbors(&b.id);
    let mut aa = 0.0;
    for c in na.intersection(&nb) {
        let deg = g.degree(c).max(2) as f64;
        aa += 1.0 / deg.ln();
    }
    let common = aa * W_COMMON_NEIGHBOR;
    // 4. typeAffinity
    let ta = type_affinity(&a.r#type, &b.r#type) * W_TYPE_AFFINITY;
    direct + shared + common + ta
}

/// 归一化 stem/raw：小写 + 空格→连字符。
fn normalize_stem(s: &str) -> String {
    s.to_lowercase().replace(' ', "-")
}

/// 从 path 提取 stem：最后一个 '/' 之后、".md" 之前。
fn path_stem(path: &str) -> &str {
    let last = path.rsplit('/').next().unwrap_or(path);
    last.trim_end_matches(".md")
}

/// 构造 stem_to_path：归一化 stem → path；重复 stem 取首个（§11 #6）。
pub(crate) fn build_stem_to_path(paths: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for p in paths {
        let key = normalize_stem(path_stem(p));
        if map.contains_key(&key) {
            tracing::warn!("dup stem {} (keep first: {:?}, dropped: {})", key, map.get(&key), p);
        } else {
            map.insert(key, p.clone());
        }
    }
    map
}

/// 构造 title_to_path：normalize_stem(title) → path（第二索引，兜底解析 [[中文标题]] 裸链接）。
///
/// 【中文化适配】页面标题译成中文后，新摄入页会产出 [[中文标题]] 裸链接——stem 表按 path
/// 末段英文 slug 建键，无法命中。此表按 title 建键补位。碰撞语义与 stem 表不同：
/// stem 碰撞取首个（path 是人写的，重名常见），title 碰撞若任选一页会把链接指向错误页面，
/// 宁缺毋错——碰撞组（两页同 title 或同归一化 title）整组不进索引，debug 日志每组一次。
pub(crate) fn build_title_to_path(titles_and_paths: &[(String, String)]) -> HashMap<String, String> {
    let mut groups: HashMap<String, Vec<&str>> = HashMap::new();
    for (title, path) in titles_and_paths {
        let t = title.trim();
        if t.is_empty() { continue; } // COALESCE(title,'') 的空标题不可解析
        groups.entry(normalize_stem(t)).or_default().push(path.as_str());
    }
    let mut map = HashMap::new();
    for (key, paths) in groups {
        if paths.len() > 1 {
            tracing::debug!("title collision {:?} across {} pages — excluded from title index", key, paths.len());
            continue;
        }
        map.insert(key, paths[0].to_string());
    }
    map
}

/// [[X]] → path：归一化 raw 后先查 stem_to_path（path 表优先），再查 title_to_path。
pub(crate) fn resolve_wikilink(
    raw: &str,
    stem_to_path: &HashMap<String, String>,
    title_to_path: &HashMap<String, String>,
) -> Option<String> {
    let key = normalize_stem(raw.trim());
    stem_to_path.get(&key).or_else(|| title_to_path.get(&key)).cloned()
}

// ── build_graph 输出类型 ──

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,        // path
    pub label: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub path: String,
    #[serde(rename = "linkCount")]
    pub link_count: i32,
    pub community: usize,
}

#[derive(Serialize, Clone, Debug)]
pub struct GraphEdge {
    pub source: String,    // path
    pub target: String,    // path
    pub weight: f64,       // relevance
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommunityInfo {
    pub id: usize,
    pub node_count: usize,
    pub cohesion: f64,
    pub top_nodes: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct WikiGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub communities: Vec<CommunityInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedNode {
    pub path: String,
    pub title: String,
    pub relevance: f64,
}

/// 项目级缓存：(project_id, max_updated_at) → WikiGraph
static GRAPH_CACHE: std::sync::LazyLock<std::sync::Mutex<HashMap<(i32, i64), WikiGraph>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

#[derive(sqlx::FromRow)]
struct WikiPageRow {
    path: String,
    title: String,
    page_type: Option<String>,
    content: Option<String>,
    sources: Option<serde_json::Value>,
}

/// [[X]] 提取（移植桌面 regex，target 不 resolve）。
fn extract_wikilinks(content: &str) -> Vec<String> {
    let re = regex_lite::Regex::new(r"\[\[([^\]|\n]+?)(?:\|[^\]]+)?\]\]").unwrap();
    re.captures_iter(content).map(|c| c.get(1).unwrap().as_str().trim().to_string()).collect()
}

fn sources_from_json(v: &Option<serde_json::Value>) -> HashSet<String> {
    v.as_ref().and_then(|x| x.as_array()).map(|arr| {
        arr.iter().filter_map(|s| s.as_str().map(String::from)).collect()
    }).unwrap_or_default()
}

/// 从 pages 的 wikilinks 构建有向邻接（out_links/in_links）+ 无向边集（对齐桌面 buildRetrievalGraph）。
///
/// 桌面对每个 resolved wikilink 记录 outLinks[src].add(tgt) 与 inLinks[tgt].add(src)（Set 去重
/// 同向/同源），不去重 per-wikilink。本函数照此：adj_out/in_links_map 按 wikilink 有向填充；
/// 无向边集 placeholder_edges 单独去重（给 petgraph 无向图，每对一次防重复 add_edge）。
///
/// 【fidelity 修复】此前 seen_edges 去重误伤有向记录——双向 wikilink（a→b 且 b→a）的第二方向
/// 被 continue 跳过，致 adj_out/in_links 缺反向、directLink 减半(6.0→3.0)、link_count 偏小
/// 误判 isolated-node。抽成纯函数便于单测锁定有向语义。
fn build_adjacency(
    pages: &[WikiPageRow],
    stem_to_path: &HashMap<String, String>,
    title_to_path: &HashMap<String, String>,
    path_index: &HashMap<String, usize>,
) -> (Vec<HashSet<String>>, HashMap<String, HashSet<String>>, Vec<(String, String)>) {
    let mut adj_out: Vec<HashSet<String>> = pages.iter().map(|_| HashSet::new()).collect();
    let mut in_links_map: HashMap<String, HashSet<String>> = HashMap::new();
    let mut placeholder_edges: Vec<(String, String)> = Vec::new();
    let mut seen_edges: HashSet<(String, String)> = HashSet::new();
    for p in pages {
        let content = p.content.as_deref().unwrap_or("");
        let si = path_index[&p.path];
        for raw in extract_wikilinks(content) {
            let Some(tgt) = resolve_wikilink(&raw, stem_to_path, title_to_path) else { continue };
            if tgt == p.path { continue; }
            // 不变式护栏：tgt 必属 pages（resolve_wikilink 只返回 stem_to_path 的 value）
            debug_assert!(path_index.contains_key(&tgt), "wikilink target {tgt} 不在 pages 内");
            // 有向 out/in（每 wikilink 一条；HashSet 同向/同源去重）
            adj_out[si].insert(tgt.clone());
            in_links_map.entry(tgt.clone()).or_default().insert(p.path.clone());
            // 无向边去重 → placeholder_edges（petgraph 无向图，每对一次）
            let key = if &p.path < &tgt { (p.path.clone(), tgt.clone()) } else { (tgt.clone(), p.path.clone()) };
            if seen_edges.insert(key) {
                placeholder_edges.push((p.path.clone(), tgt.clone()));
            }
        }
    }
    (adj_out, in_links_map, placeholder_edges)
}

/// 主入口：从 wiki_pages 构建图谱（真 Louvain + relevance 边权 + node id=path + 过滤 query）。
pub async fn build_graph(pool: &PgPool, project_id: i32) -> Result<WikiGraph, AppError> {
    // 缓存键 = max(updated_at) 的 epoch 微秒（亚秒精度）。整秒 BIGINT 丢微秒精度，致同秒内多次
    // 写入（API 快速 create/edit）cache_ts 不变 → 返回 stale graph，漏掉新页/改动。
    let max_ts: Option<i64> = sqlx::query_scalar(
        "SELECT (EXTRACT(EPOCH FROM COALESCE(MAX(updated_at), TIMESTAMPTZ '1970-01-01')) * 1000000)::BIGINT \
         FROM wiki_pages WHERE project_id = $1"
    ).bind(project_id).fetch_optional(pool).await.map_err(AppError::DatabaseError)?.flatten();
    let cache_ts = max_ts.unwrap_or(0);
    if let Ok(cache) = GRAPH_CACHE.lock() {
        if let Some(g) = cache.get(&(project_id, cache_ts)) {
            return Ok(g.clone());
        }
    }

    let pages: Vec<WikiPageRow> = sqlx::query_as::<_, WikiPageRow>(
        "SELECT path, COALESCE(title,'') AS title, page_type, content, sources \
         FROM wiki_pages WHERE project_id = $1 AND COALESCE(page_type,'') != 'query'"
    ).bind(project_id).fetch_all(pool).await.map_err(AppError::DatabaseError)?;

    if pages.is_empty() {
        let empty = WikiGraph { nodes: vec![], edges: vec![], communities: vec![] };
        return Ok(empty);
    }

    let paths: Vec<String> = pages.iter().map(|p| p.path.clone()).collect();
    let stem_to_path = build_stem_to_path(&paths);
    let title_to_path = build_title_to_path(
        &pages.iter().map(|p| (p.title.clone(), p.path.clone())).collect::<Vec<_>>(),
    );
    let path_index: HashMap<String, usize> = paths.iter().enumerate().map(|(i,p)| (p.clone(), i)).collect();

    // 3a. 有向邻接 + 无向边集（build_adjacency 纯函数，对齐桌面 buildRetrievalGraph 有向记录）
    let (adj_out, mut in_links_map, placeholder_edges) = build_adjacency(&pages, &stem_to_path, &title_to_path, &path_index);
    // in_degree = in_links 的 source 集大小（入度，按 source 去重；Vec 下标=pages 序，查询处用 i 省hash）
    let in_degree: Vec<i32> = pages.iter().map(|p|
        in_links_map.get(&p.path).map(|s| s.len() as i32).unwrap_or(0)
    ).collect();
    // 3b. 反填 inLinks → 完成 RetrievalGraph
    let mut rnodes: HashMap<String, RetrievalNode> = HashMap::new();
    for p in &pages {
        let i = path_index[&p.path];
        let in_links = in_links_map.remove(&p.path).unwrap_or_default();
        // 【M3 适配】page_type lowercase 填 type（对齐桌面 graph-relevance.ts 的 toLowerCase，
        // 使 type_affinity 矩阵正确匹配 + 2d insights 的 system 排除一致）
        let ty = p.page_type.clone().unwrap_or_else(|| "other".into()).to_lowercase();
        rnodes.insert(p.path.clone(), RetrievalNode {
            id: p.path.clone(), title: p.title.clone(),
            r#type: ty,
            sources: sources_from_json(&p.sources),
            out_links: adj_out[i].clone(),
            in_links,
        });
    }
    let rgraph = RetrievalGraph { nodes: rnodes };

    // 4. 算 relevance 替换 weight
    let mut edges: Vec<GraphEdge> = placeholder_edges.iter().map(|(s, t)| {
        let a = rgraph.nodes.get(s).unwrap();
        let b = rgraph.nodes.get(t).unwrap();
        GraphEdge { source: s.clone(), target: t.clone(), weight: calculate_relevance(a, b, &rgraph) }
    }).collect();

    // 6. petgraph + Louvain
    let mut pg = petgraph::graph::Graph::<(), f64, petgraph::Undirected>::new_undirected();
    let pg_nodes: Vec<_> = (0..pages.len()).map(|_| pg.add_node(())).collect();
    let pi = |path: &str| pg_nodes[path_index[path]];
    for e in &edges {
        pg.add_edge(pi(&e.source), pi(&e.target), e.weight);
    }
    let comm = crate::services::louvain::louvain(&pg, 1.0); // 按 pg 节点序

    // 7. 社区 info + 重编号。按社区大小降序处理，保证 communities[k] 与 id_remap 对齐
    let mut groups_vec: Vec<(usize, Vec<usize>)> = {
        let mut m: HashMap<usize, Vec<usize>> = HashMap::new();
        for (i, &c) in comm.iter().enumerate() { m.entry(c).or_default().push(i); }
        m.into_iter().collect()
    };
    // 按社区大小降序；同 size 时按最小成员节点索引升序 tie-break，锁死跨运行确定性
    // （避免 HashMap 迭代序致同 size 社区的 id 分配漂移）。
    groups_vec.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.1[0].cmp(&b.1[0])));
    let edge_pair: HashSet<(String, String)> = edges.iter().map(|e| {
        if e.source < e.target { (e.source.clone(), e.target.clone()) } else { (e.target.clone(), e.source.clone()) }
    }).collect();
    let mut communities: Vec<CommunityInfo> = Vec::new();
    let mut id_remap: HashMap<usize, usize> = HashMap::new();
    for (new_id, (old_label, members)) in groups_vec.iter().enumerate() {
        id_remap.insert(*old_label, new_id);
        let n = members.len();
        let possible = if n > 1 { n * (n - 1) / 2 } else { 1 }; // n=1 → cohesion=0 防 NaN
        let mut intra = 0;
        for a in 0..n {
            for b in (a + 1)..n {
                let pa = &pages[members[a]].path;
                let pb = &pages[members[b]].path;
                let key = if pa < pb { (pa.clone(), pb.clone()) } else { (pb.clone(), pa.clone()) };
                if edge_pair.contains(&key) { intra += 1; }
            }
        }
        let cohesion = intra as f64 / possible as f64;
        let mut lc: Vec<(usize, i32)> = members.iter().map(|&i| {
            // i 即 pages 下标（== path_index[&pages[i].path]），直接索引省 hash
            let deg = adj_out[i].len() as i32 + in_degree[i];
            (i, deg)
        }).collect();
        lc.sort_by(|a, b| b.1.cmp(&a.1));
        let top_nodes: Vec<String> = lc.iter().take(5).map(|(i, _)| pages[*i].title.clone()).collect();
        communities.push(CommunityInfo { id: new_id, node_count: n, cohesion, top_nodes });
    }

    let mut nodes: Vec<GraphNode> = pages.iter().enumerate().map(|(i, p)| {
        let deg = adj_out[i].len() as i32 + in_degree[i];
        // 【M3 适配】node_type 也 lowercase（与 RetrievalNode.type 一致）
        let ty = p.page_type.clone().unwrap_or_else(|| "other".into()).to_lowercase();
        GraphNode {
            id: p.path.clone(), label: p.title.clone(),
            node_type: ty,
            path: p.path.clone(), link_count: deg,
            community: id_remap[&comm[i]],
        }
    }).collect();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    edges.sort_by(|a, b| (&a.source, &a.target).cmp(&(&b.source, &b.target)));

    let graph = WikiGraph { nodes, edges, communities };
    if let Ok(mut cache) = GRAPH_CACHE.lock() {
        cache.retain(|&(pid, _), _| pid != project_id);
        cache.insert((project_id, cache_ts), graph.clone());
    }
    Ok(graph)
}

/// Invalidate the in-memory graph cache for a project. Call after a page DELETE
/// (which doesn't change remaining rows' updated_at, so the (project_id, MAX(updated_at))
/// cache key wouldn't change on its own).
pub fn invalidate_project_cache(project_id: i32) {
    if let Ok(mut cache) = GRAPH_CACHE.lock() {
        cache.retain(|&(pid, _), _| pid != project_id);
    }
}

/// 相关节点：path 的邻边按 weight desc 取 top-N。需 title，从 nodes 查。
pub fn related_nodes(graph: &WikiGraph, path: &str, limit: usize) -> Vec<RelatedNode> {
    let title_of: HashMap<&str, &str> = graph.nodes.iter().map(|n| (n.id.as_str(), n.label.as_str())).collect();
    let mut hits: Vec<(String, f64)> = graph.edges.iter()
        .filter_map(|e| {
            if e.source == path { Some((e.target.clone(), e.weight)) }
            else if e.target == path { Some((e.source.clone(), e.weight)) }
            else { None }
        })
        .collect();
    hits.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    hits.into_iter().take(limit).map(|(p, w)| RelatedNode {
        title: title_of.get(p.as_str()).map(|s| s.to_string()).unwrap_or_else(|| p.clone()),
        path: p, relevance: w,
    }).collect()
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SurprisingConnection {
    pub source: GraphNode,
    pub target: GraphNode,
    pub score: i32,
    pub reasons: Vec<String>,
    pub key: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGap {
    #[serde(rename = "type")]
    pub r#type: String, // "isolated-node" | "sparse-community" | "bridge-node"
    pub title: String,
    pub description: String,
    pub node_ids: Vec<String>, // 序列化为 nodeIds
    pub suggestion: String,
}

pub fn find_surprising_connections(graph: &WikiGraph, limit: usize) -> Vec<SurprisingConnection> {
    use std::collections::HashMap;

    let node_map: HashMap<&str, &GraphNode> = graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let degree_map: HashMap<&str, i32> = graph.nodes.iter().map(|n| (n.id.as_str(), n.link_count)).collect();
    let max_degree = graph.nodes.iter().map(|n| n.link_count).max().unwrap_or(1).max(1);

    // 桌面 distant-pairs（source-concept / source-synthesis / query-entity 及反向）
    let is_distant_pair = |a: &str, b: &str| -> bool {
        matches!(
            (a, b),
            ("source", "concept") | ("concept", "source")
                | ("source", "synthesis") | ("synthesis", "source")
                | ("query", "entity") | ("entity", "query")
        )
    };

    let mut scored: Vec<SurprisingConnection> = Vec::new();
    for e in &graph.edges {
        let source = match node_map.get(e.source.as_str()) { Some(n) => *n, None => continue };
        let target = match node_map.get(e.target.as_str()) { Some(n) => *n, None => continue };
        // 排除 structural 节点（system 类型，case-insensitive）
        if source.node_type.to_lowercase() == "system" || target.node_type.to_lowercase() == "system" {
            continue;
        }

        let mut score = 0i32;
        let mut reasons: Vec<String> = Vec::new();

        // Signal 1: 跨社区 (+3)
        if source.community != target.community {
            score += 3;
            reasons.push("crosses community boundary".into());
        }

        // Signal 2: 跨类型（distant-pair +2，其它异类型 +1）
        if source.node_type != target.node_type {
            if is_distant_pair(&source.node_type, &target.node_type) {
                score += 2;
                reasons.push(format!("connects {} to {}", source.node_type, target.node_type));
            } else {
                score += 1;
                reasons.push("different types".into());
            }
        }

        // Signal 3: 边缘↔枢纽耦合。双条件：min deg ≤ 2 且 max deg ≥ 0.5 × maxDegree
        let sd = degree_map.get(e.source.as_str()).copied().unwrap_or(0);
        let td = degree_map.get(e.target.as_str()).copied().unwrap_or(0);
        if sd.min(td) <= 2 && sd.max(td) as f64 >= max_degree as f64 * 0.5 {
            score += 2;
            reasons.push("peripheral node links to hub".into());
        }

        // Signal 4: 弱边（0 < weight < 2）+1
        if e.weight > 0.0 && e.weight < 2.0 {
            score += 1;
            reasons.push("weak but present connection".into());
        }

        if score >= 3 && !reasons.is_empty() {
            let mut ids = [source.path.clone(), target.path.clone()];
            ids.sort();
            let key = ids.join(":::");
            scored.push(SurprisingConnection {
                source: source.clone(),
                target: target.clone(),
                score,
                reasons,
                key,
            });
        }
    }
    scored.sort_by(|a, b| b.score.cmp(&a.score));
    scored.truncate(limit);
    scored
}

pub fn detect_knowledge_gaps(graph: &WikiGraph, limit: usize) -> Vec<KnowledgeGap> {
    use std::collections::{HashMap, HashSet};

    let mut gaps: Vec<KnowledgeGap> = Vec::new();

    // 1. isolated nodes (degree ≤ 1, exclude system)
    let isolated: Vec<&GraphNode> = graph.nodes.iter()
        .filter(|n| n.link_count <= 1 && n.node_type.to_lowercase() != "system")
        .collect();
    if !isolated.is_empty() {
        let top5: Vec<String> = isolated.iter().take(5).map(|n| n.label.clone()).collect();
        let desc = if isolated.len() > 5 {
            format!("{}, ... and {} more", top5.join(", "), isolated.len() - 5)
        } else {
            top5.join(", ")
        };
        gaps.push(KnowledgeGap {
            r#type: "isolated-node".into(),
            title: format!("{} isolated page{}", isolated.len(), if isolated.len() > 1 { "s" } else { "" }),
            description: desc,
            node_ids: isolated.iter().map(|n| n.path.clone()).collect(),
            suggestion: "These pages have few or no connections. Consider adding [[wikilinks]] to related pages, or research to expand their content.".into(),
        });
    }

    // 2. sparse communities (cohesion < 0.15, ≥ 3 nodes)
    let comm_nodes: HashMap<usize, Vec<&GraphNode>> = {
        let mut m: HashMap<usize, Vec<&GraphNode>> = HashMap::new();
        for n in &graph.nodes {
            m.entry(n.community).or_default().push(n);
        }
        m
    };
    for c in &graph.communities {
        if c.cohesion < 0.15 && c.node_count >= 3 {
            let first = c.top_nodes.first().cloned().unwrap_or_else(|| format!("Community {}", c.id));
            gaps.push(KnowledgeGap {
                r#type: "sparse-community".into(),
                title: format!("Sparse cluster: {}", first),
                description: format!("{} pages with cohesion {:.2} — internal connections are weak.", c.node_count, c.cohesion),
                node_ids: comm_nodes.get(&c.id).map(|ns| ns.iter().map(|n| n.path.clone()).collect()).unwrap_or_default(),
                suggestion: "This knowledge area lacks internal cross-references. Consider adding links between these pages or researching to fill gaps.".into(),
            });
        }
    }

    // 3. bridge nodes (neighbors span ≥ 3 communities, exclude system)
    let mut comm_neighbors: HashMap<&str, HashSet<usize>> = graph.nodes.iter()
        .map(|n| (n.id.as_str(), HashSet::new())).collect();
    let node_map: HashMap<&str, &GraphNode> = graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    for e in &graph.edges {
        if let (Some(s), Some(t)) = (node_map.get(e.source.as_str()), node_map.get(e.target.as_str())) {
            if let Some(cs) = comm_neighbors.get_mut(e.source.as_str()) { cs.insert(t.community); }
            if let Some(cs) = comm_neighbors.get_mut(e.target.as_str()) { cs.insert(s.community); }
        }
    }
    let mut bridges: Vec<(&GraphNode, usize)> = graph.nodes.iter()
        .filter(|n| {
            if n.node_type.to_lowercase() == "system" { return false; }
            comm_neighbors.get(n.id.as_str()).map(|c| c.len() >= 3).unwrap_or(false)
        })
        .map(|n| (n, comm_neighbors.get(n.id.as_str()).map(|c| c.len()).unwrap_or(0)))
        .collect();
    bridges.sort_by(|a, b| b.1.cmp(&a.1)); // desc by community count
    for (bridge, count) in bridges.iter().take(3) {
        gaps.push(KnowledgeGap {
            r#type: "bridge-node".into(),
            title: format!("Key bridge: {}", bridge.label),
            description: format!("Connects {} different knowledge clusters. This is a critical junction in your wiki.", count),
            node_ids: vec![bridge.path.clone()],
            suggestion: "This page bridges multiple knowledge areas. Ensure it's well-maintained — if it's thin, expanding it will strengthen your entire wiki.".into(),
        });
    }

    gaps.truncate(limit); // 桌面 overall slice
    gaps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, t: &str, sources: &[&str], out: &[&str], inl: &[&str]) -> RetrievalNode {
        RetrievalNode {
            id: id.into(), title: id.into(), r#type: t.into(),
            sources: sources.iter().map(|s| s.to_string()).collect(),
            out_links: out.iter().map(|s| s.to_string()).collect(),
            in_links: inl.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn direct_link_signal_sums_both_directions() {
        let a = node("a", "entity", &[], &["b"], &[]);
        let b = node("b", "entity", &[], &["a"], &[]);
        let g = RetrievalGraph { nodes: [("a".to_string(), a.clone()), ("b".to_string(), b.clone())].into_iter().collect() };
        let r = calculate_relevance(&a, &b, &g);
        assert!((r - (6.0 + 0.8)).abs() < 1e-9, "got {} (双向应 6.0)", r);
    }

    #[test]
    fn source_overlap_signal() {
        let a = node("a", "entity", &["s1","s2"], &[], &[]);
        let b = node("b", "concept", &["s2","s3"], &[], &[]);
        let g = RetrievalGraph { nodes: [("a".to_string(), a.clone()), ("b".to_string(), b.clone())].into_iter().collect() };
        let r = calculate_relevance(&a, &b, &g);
        assert!((r - (4.0 + 1.2)).abs() < 1e-9, "got {}", r);
    }

    #[test]
    fn common_neighbor_adamic_adar() {
        let a = node("a", "entity", &[], &["c"], &[]);
        let b = node("b", "entity", &[], &["c"], &[]);
        let c = node("c", "entity", &[], &[], &["a","b"]);
        let g = RetrievalGraph { nodes: [("a".into(),a.clone()),("b".into(),b.clone()),("c".into(),c)].into_iter().collect() };
        let r = calculate_relevance(&a, &b, &g);
        let expect = (1.0 / 2f64.ln()) * 1.5 + 0.8;
        assert!((r - expect).abs() < 1e-9, "got {} expect {}", r, expect);
    }

    #[test]
    fn type_affinity_matrix_values() {
        assert!((type_affinity("entity","concept") - 1.2).abs() < 1e-9);
        assert!((type_affinity("source","source") - 0.5).abs() < 1e-9);
        assert!((type_affinity("unknowntype","entity") - 0.5).abs() < 1e-9); // default
    }

    #[test]
    fn type_affinity_extended_types_hit_and_symmetric() {
        // 新增 4 类型命中矩阵（非 default 0.5）
        assert!((type_affinity("comparison", "concept") - 1.2).abs() < 1e-9);
        assert!((type_affinity("thesis", "finding") - 1.2).abs() < 1e-9);
        assert!((type_affinity("methodology", "finding") - 1.2).abs() < 1e-9);
        assert!((type_affinity("finding", "source") - 1.2).abs() < 1e-9);
        // system（reserved pages）仍落 default 0.5
        assert!((type_affinity("system", "entity") - 0.5).abs() < 1e-9);
        // 全 9 类型两两对称：type_affinity(a,b) == type_affinity(b,a)
        let types = ["entity","concept","source","query","synthesis",
                     "comparison","thesis","methodology","finding"];
        for &a in &types {
            for &b in &types {
                assert!(
                    (type_affinity(a, b) - type_affinity(b, a)).abs() < 1e-9,
                    "不对称: {a}↔{b} ({} vs {})", type_affinity(a, b), type_affinity(b, a)
                );
            }
        }
    }

    #[test]
    fn common_neighbor_degree_not_dedup_bidirectional() {
        // c 与 a、b 双向相连：out={a,b}, in={a,b}。
        // 桌面 degree(c) = out.size(2) + in.size(2) = 4（不去重），非去重的 2。
        // Adamic-Adar 用 1/ln(4)；锁住 degree 不去重语义。
        let a = node("a", "entity", &[], &["c"], &[]);
        let b = node("b", "entity", &[], &["c"], &[]);
        let c = node("c", "entity", &[], &["a", "b"], &["a", "b"]);
        let g = RetrievalGraph {
            nodes: [("a".into(), a.clone()), ("b".into(), b.clone()), ("c".into(), c)].into_iter().collect(),
        };
        // 先直接验 degree(c)=4（不去重）
        assert_eq!(g.degree("c"), 4, "degree 应不去重（out+in 计两次），双向 c 应=4");
        // 再验 relevance：common neighbor c，deg=4 → 1/ln(4)
        let r = calculate_relevance(&a, &b, &g);
        let expect = (1.0 / 4f64.ln()) * 1.5 + 0.8; // aa*W_COMMON_NEIGHBOR + typeAffinity(entity,entity)=0.8
        assert!((r - expect).abs() < 1e-9, "got {} expect {} (degree 不去重 deg=4)", r, expect);
    }

    #[test]
    fn resolve_wikilink_fuzzy_to_path() {
        // stem_to_path: 归一化 stem(lowercase+空格→连字符) → path
        let mut s2p = std::collections::HashMap::new();
        s2p.insert("alice".into(), "entities/alice.md".into());
        s2p.insert("project-phoenix".into(), "entities/project-phoenix.md".into());
        let empty_title = std::collections::HashMap::new();
        // 大小写
        assert_eq!(resolve_wikilink("Alice", &s2p, &empty_title), Some("entities/alice.md".into()));
        // 空格↔连字符
        assert_eq!(resolve_wikilink("Project Phoenix", &s2p, &empty_title), Some("entities/project-phoenix.md".into()));
        // 未命中
        assert_eq!(resolve_wikilink("nonexistent", &s2p, &empty_title), None);
    }

    #[test]
    fn build_stem_to_path_dedup_first() {
        // 重复 stem 取首个（path 不同但 stem 同）
        let paths = vec!["entities/alice.md".to_string(), "concepts/alice.md".to_string()];
        let s2p = build_stem_to_path(&paths);
        assert_eq!(s2p.get("alice"), Some(&"entities/alice.md".to_string()));
    }

    #[test]
    fn title_index_three_states() {
        // 三态：① 同 slug（不同目录同名 stem，title 唯一）→ title 表正常兜底
        //       ② 同 title（两页 title 完全相同）→ 碰撞组不进索引
        //       ③ 同归一化 title（大小写/空格差异归一后相同）→ 碰撞组不进索引
        let tp = vec![
            // ① concepts/overview.md 与 notes/overview.md 同 slug；title 唯一可兜底
            ("总览页面".to_string(), "concepts/overview.md".to_string()),
            ("备注页".to_string(), "notes/overview.md".to_string()),
            // ② 同 title 两页
            ("学术英语".to_string(), "concepts/academic-english.md".to_string()),
            ("学术英语".to_string(), "notes/academic-english-dup.md".to_string()),
            // ③ 归一化碰撞："PPP Teaching Model" vs "ppp teaching model"
            ("PPP Teaching Model".to_string(), "concepts/ppp-teaching-model.md".to_string()),
            ("ppp teaching model".to_string(), "notes/ppp-model-dup.md".to_string()),
            // 空标题不进索引
            ("".to_string(), "concepts/empty-title.md".to_string()),
        ];
        let t2p = build_title_to_path(&tp);
        // ① 唯一 title 命中（stem 表查不到中文 title 时兜底）
        assert_eq!(t2p.get("总览页面"), Some(&"concepts/overview.md".to_string()));
        assert_eq!(t2p.get("备注页"), Some(&"notes/overview.md".to_string()));
        // ② 同 title 碰撞 → 整组排除
        assert!(t2p.get("学术英语").is_none(), "同 title 两页应排除");
        // ③ 归一化碰撞 → 整组排除
        assert!(t2p.get("ppp-teaching-model").is_none(), "归一化同 title 应排除");
        // 空标题不进索引
        assert!(t2p.get("").is_none());
    }

    #[test]
    fn resolve_wikilink_stem_table_takes_priority_over_title_table() {
        // path 表优先：stem 键与 title 归一化键同键时，stem 表先命中
        let s2p = build_stem_to_path(&["concepts/zone-of-proximal-development.md".to_string()]);
        let t2p = build_title_to_path(&[
            ("最近发展区".to_string(), "notes/zpd-note.md".to_string()),
        ]);
        // [[zone-of-proximal-development]]（slug 形）→ stem 表
        assert_eq!(
            resolve_wikilink("zone-of-proximal-development", &s2p, &t2p),
            Some("concepts/zone-of-proximal-development.md".into()),
        );
        // [[最近发展区]]（中文裸链接）→ title 表兜底
        assert_eq!(
            resolve_wikilink("最近发展区", &s2p, &t2p),
            Some("notes/zpd-note.md".into()),
        );
    }

    #[test]
    fn build_adjacency_resolves_chinese_title_links_via_title_index() {
        // 端到端：[[中文标题]] 裸链接经 title_to_path 兜底建边（修复前 77.7% 边解析失败）
        let pages = vec![
            WikiPageRow { path: "concepts/ppp-teaching-model.md".into(), title: "PPP 教学模式".into(),
                          page_type: Some("concept".into()), content: Some("[[学术写作]] 指向未译页".into()), sources: None },
            WikiPageRow { path: "concepts/academic-writing-fundamentals.md".into(), title: "学术写作".into(),
                          page_type: Some("concept".into()), content: Some("[[PPP 教学模式]] 中文裸链接".into()), sources: None },
        ];
        let paths: Vec<String> = pages.iter().map(|p| p.path.clone()).collect();
        let stem_to_path = build_stem_to_path(&paths);
        let title_to_path = build_title_to_path(&pages.iter().map(|p| (p.title.clone(), p.path.clone())).collect::<Vec<_>>());
        let path_index: HashMap<String, usize> = paths.iter().enumerate().map(|(i, p)| (p.clone(), i)).collect();
        let (adj_out, in_links_map, placeholder_edges) = build_adjacency(&pages, &stem_to_path, &title_to_path, &path_index);
        // 双向 [[中文标题]] 裸链接均解析建边
        assert!(adj_out[1].contains("concepts/ppp-teaching-model.md"), "中文裸链接应经 title 表解析");
        assert!(adj_out[0].contains("concepts/academic-writing-fundamentals.md"));
        assert!(in_links_map.get("concepts/ppp-teaching-model.md").map(|s| s.contains("concepts/academic-writing-fundamentals.md")).unwrap_or(false));
        assert_eq!(placeholder_edges.len(), 1);
    }

    #[test]
    fn build_adjacency_records_bidirectional_wikilinks() {
        // 双向 wikilink（a→b 且 b→a）：有向 out/in 应双向记录；无向边集去重为 1 条。
        // 【回归护栏】修复前 seen_edges 去重误伤反向 adj_out/in_links → directLink 6→3、
        // link_count 偏小误判 isolated。本测试锁住有向语义。
        let pages = vec![
            WikiPageRow { path: "a.md".into(), title: "A".into(), page_type: Some("entity".into()),
                          content: Some("[[b]]".into()), sources: None },
            WikiPageRow { path: "b.md".into(), title: "B".into(), page_type: Some("entity".into()),
                          content: Some("[[a]]".into()), sources: None },
        ];
        let paths: Vec<String> = pages.iter().map(|p| p.path.clone()).collect();
        let stem_to_path = build_stem_to_path(&paths);
        let title_to_path = build_title_to_path(&pages.iter().map(|p| (p.title.clone(), p.path.clone())).collect::<Vec<_>>());
        let path_index: HashMap<String, usize> = paths.iter().enumerate().map(|(i, p)| (p.clone(), i)).collect();
        let (adj_out, in_links_map, placeholder_edges) = build_adjacency(&pages, &stem_to_path, &title_to_path, &path_index);
        // 有向 out 双向（修复前 b→a 被 seen_edges 去重跳过）
        assert!(adj_out[0].contains("b.md"), "a→b 应记录");
        assert!(adj_out[1].contains("a.md"), "b→a 应记录");
        // 有向 in 双向
        assert!(in_links_map.get("a.md").map(|s| s.contains("b.md")).unwrap_or(false), "in_links[a] 应含 b");
        assert!(in_links_map.get("b.md").map(|s| s.contains("a.md")).unwrap_or(false), "in_links[b] 应含 a");
        // 无向边集去重为 1 条（petgraph 无向图，每对一次）
        assert_eq!(placeholder_edges.len(), 1, "双向 pair 无向边应去重为 1 条");
    }

    #[test]
    fn related_nodes_sorted_by_weight_topn() {
        let g = WikiGraph {
            nodes: vec![
                GraphNode { id: "a".into(), label: "A".into(), node_type: "entity".into(), path: "a".into(), link_count: 0, community: 0 },
            ],
            edges: vec![
                GraphEdge { source: "a".into(), target: "b".into(), weight: 0.5 },
                GraphEdge { source: "c".into(), target: "a".into(), weight: 3.0 },
                GraphEdge { source: "a".into(), target: "d".into(), weight: 1.2 },
                GraphEdge { source: "x".into(), target: "y".into(), weight: 9.0 }, // 无关
            ],
            communities: vec![],
        };
        let r = related_nodes(&g, "a", 2);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].path, "c"); // weight 3.0 最高
        assert_eq!(r[1].path, "d"); // 1.2 次之
    }

    #[test]
    fn empty_graph_gives_empty_insights() {
        let g = WikiGraph { nodes: vec![], edges: vec![], communities: vec![] };
        assert!(find_surprising_connections(&g, 5).is_empty());
        assert!(detect_knowledge_gaps(&g, 8).is_empty());
    }

    fn mk_node(id: &str, label: &str, ty: &str, deg: i32, comm: usize) -> GraphNode {
        GraphNode { id: id.into(), label: label.into(), node_type: ty.into(), path: id.into(), link_count: deg, community: comm }
    }
    fn mk_edge(src: &str, tgt: &str, w: f64) -> GraphEdge {
        GraphEdge { source: src.into(), target: tgt.into(), weight: w }
    }

    #[test]
    fn surprising_cross_community_gives_3() {
        let g = WikiGraph {
            nodes: vec![
                mk_node("a","A","entity",2,0),
                mk_node("b","B","entity",3,1),        // same type → no signal2
                mk_node("big","Big","entity",10,2),    // maxDegree=10 → threshold=5, no signal3
            ],
            edges: vec![mk_edge("a","b",5.0)],         // weight ≥2 → no signal4
            communities: vec![],
        };
        let s = find_surprising_connections(&g, 5);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].score, 3, "only cross-community: {:?}", s[0].reasons);
        assert!(s[0].reasons.iter().any(|r| r.contains("community")));
    }

    #[test]
    fn surprising_distant_pair_gives_2() {
        let g = WikiGraph {
            nodes: vec![mk_node("a","A","source",2,1), mk_node("b","B","concept",2,0)],
            edges: vec![mk_edge("a","b",5.0)],
            communities: vec![],
        };
        let s = find_surprising_connections(&g, 5);
        assert!(s[0].score >= 5, "cross-community(+3) + distant-pair(+2) = 5, got {}", s[0].score);
        assert!(s[0].reasons.iter().any(|r| r.contains("connects")));
    }

    #[test]
    fn surprising_peripheral_to_hub_needs_both_conditions() {
        // min deg ≤2 AND max deg ≥ 0.5 × maxDegree (global max=10)
        let g = WikiGraph {
            nodes: vec![
                mk_node("peri","P","entity",2,0),
                mk_node("hub","H","concept",6,1),  // 6 ≥ 10*0.5 → hub
                mk_node("ref","R","entity",10,1),   // maxDegree=10
            ],
            edges: vec![mk_edge("peri","hub",5.0)],
            communities: vec![],
        };
        let s = find_surprising_connections(&g, 5);
        assert!(!s.is_empty(), "peri-hub should be surprising: {:?}", s);
        assert!(s[0].reasons.iter().any(|r| r.contains("peripheral")));
    }

    #[test]
    fn surprising_peripheral_to_peripheral_not_surprising_on_signal3() {
        // both deg≤2 but no hub → signal 3 should NOT fire
        let g = WikiGraph {
            nodes: vec![
                mk_node("p1","P1","entity",2,0),
                mk_node("p2","P2","concept",1,1),
                mk_node("big","Big","entity",10,2),  // maxDegree=10 → threshold=5, no signal3
            ],
            edges: vec![mk_edge("p1","p2",5.0)],
            communities: vec![],
        };
        let s = find_surprising_connections(&g, 5);
        // cross-community+different-types, but NO peripheral-hub
        assert!(!s.is_empty());
        assert!(!s[0].reasons.iter().any(|r| r.contains("peripheral")), "should be no peripheral: {:?}", s[0].reasons);
    }

    #[test]
    fn surprising_weak_edge_gives_1() {
        let g = WikiGraph {
            nodes: vec![mk_node("a","A","entity",2,0), mk_node("b","B","concept",3,1)],
            edges: vec![mk_edge("a","b",1.5)],
            communities: vec![],
        };
        let s = find_surprising_connections(&g, 5);
        // cross-community(+3) + weak-edge(+1) = 4
        assert!(s[0].score >= 4);
        assert!(s[0].reasons.iter().any(|r| r.contains("weak")));
    }

    #[test]
    fn surprising_score_2_not_included() {
        // same community (=0), same type (=0), not peripheral-hub, weak edge (+1) → 1 → excluded
        let g = WikiGraph {
            nodes: vec![mk_node("a","A","entity",5,0), mk_node("b","B","entity",5,0)],
            edges: vec![mk_edge("a","b",1.5)],
            communities: vec![],
        };
        let s = find_surprising_connections(&g, 5);
        assert!(s.is_empty(), "score<3 should not be included: {:?}", s);
    }

    #[test]
    fn surprising_excludes_system_nodes() {
        let g = WikiGraph {
            nodes: vec![mk_node("a","A","entity",2,0), mk_node("sys","Index","system",2,1)],
            edges: vec![mk_edge("a","sys",5.0)],
            communities: vec![],
        };
        let s = find_surprising_connections(&g, 5);
        assert!(s.is_empty(), "edges involving system nodes should be excluded");
    }

    #[test]
    fn gaps_isolated_nodes() {
        let g = WikiGraph {
            nodes: vec![mk_node("orphan","Orphan","entity",0,0), mk_node("conn","Connected","concept",5,0)],
            edges: vec![mk_edge("conn","orphan",5.0)], // only one edge — orphan degree via edge
            communities: vec![],
        };
        let gaps = detect_knowledge_gaps(&g, 8);
        assert!(gaps.iter().any(|g| g.r#type == "isolated-node"));
    }

    #[test]
    fn gaps_sparse_community() {
        let g = WikiGraph {
            nodes: vec![
                mk_node("a","A","concept",2,0), mk_node("b","B","concept",2,0), mk_node("c","C","concept",1,0),
            ],
            edges: vec![mk_edge("a","b",5.0)], // only one edge — cohesion=1/3≈0.33... wait need cohesion<0.15
            communities: vec![CommunityInfo{id:0,node_count:3,cohesion:0.10,top_nodes:vec!["A".into()]}],
        };
        let gaps = detect_knowledge_gaps(&g, 8);
        assert!(gaps.iter().any(|g| g.r#type == "sparse-community"));
    }

    #[test]
    fn gaps_bridge_nodes() {
        // node a connects to b(comm0), c(comm1), d(comm2) → 3 communities
        let g = WikiGraph {
            nodes: vec![
                mk_node("bridge","Bridge","concept",3,0),
                mk_node("b","B","concept",1,1),
                mk_node("c","C","concept",1,2),
                mk_node("d","D","concept",1,3),
            ],
            edges: vec![mk_edge("bridge","b",5.0),mk_edge("bridge","c",5.0),mk_edge("bridge","d",5.0)],
            communities: vec![],
        };
        let gaps = detect_knowledge_gaps(&g, 8);
        assert!(gaps.iter().any(|g| g.r#type == "bridge-node"));
    }

    #[test]
    fn gaps_desktop_order_isolated_sparse_bridge() {
        // 三类 gap 同时存在
        let g = WikiGraph {
            nodes: vec![
                mk_node("orphan","O","entity",0,0),
                mk_node("a","A","concept",2,0), mk_node("b","B","concept",2,0), mk_node("c","C","concept",1,0),
                mk_node("bridge","Br","concept",3,0),
                mk_node("x","X","concept",1,1), mk_node("y","Y","concept",1,2), mk_node("z","Z","concept",1,3),
            ],
            edges: vec![
                mk_edge("a","b",5.0),
                mk_edge("orphan","bridge",5.0),
                mk_edge("bridge","x",5.0), mk_edge("bridge","y",5.0), mk_edge("bridge","z",5.0),
            ],
            communities: vec![CommunityInfo{id:0,node_count:3,cohesion:0.10,top_nodes:vec!["A".into()]}],
        };
        let gaps = detect_knowledge_gaps(&g, 8);
        let types: Vec<&str> = gaps.iter().map(|g| g.r#type.as_str()).collect();
        // 桌面序：isolated → sparse → bridge
        let iso = types.iter().position(|t| *t == "isolated-node");
        let spa = types.iter().position(|t| *t == "sparse-community");
        let bri = types.iter().position(|t| *t == "bridge-node");
        assert!(iso < spa, "desktop order: isolated before sparse, got {:?}", types);
        assert!(spa < bri, "desktop order: sparse before bridge, got {:?}", types);
    }

    #[test]
    fn gaps_exclude_system_nodes() {
        let g = WikiGraph {
            nodes: vec![mk_node("sys","Idx","system",0,0),
                        mk_node("orphan","O","entity",0,1)],
            edges: vec![],
            communities: vec![],
        };
        let gaps = detect_knowledge_gaps(&g, 8);
        // system node should NOT be isolated; only orphan counts
        let iso = gaps.iter().find(|g| g.r#type == "isolated-node");
        assert!(iso.is_some());
        assert!(!iso.unwrap().node_ids.contains(&"sys".to_string()));
    }
}


#[cfg(test)]
mod page_links_tests {
    use super::*;

    fn page(path: &str, title: &str, content: &str) -> WikiPageRow {
        WikiPageRow { path: path.into(), title: title.into(), page_type: Some("entity".into()), content: Some(content.into()), sources: None }
    }

    fn pages() -> Vec<WikiPageRow> {
        vec![
            page("entities/kwl-chart.md", "KWL Chart", "参见 [[Skimming]] 与 [[不存在的页]]。"),
            page("concepts/skimming.md", "Skimming", "回看 [[KWL Chart]] 的 [[KWL Chart]] 自链。"),
            page("concepts/other.md", "Other", "无链接。"),
        ]
    }

    #[test]
    fn three_sections_match_desktop_semantics() {
        let data = page_links_from_pages(&pages(), "entities/kwl-chart.md").unwrap();
        assert_eq!(data.outgoing.len(), 1);
        assert_eq!(data.outgoing[0].path.as_deref(), Some("concepts/skimming.md"));
        assert_eq!(data.outgoing[0].title, "Skimming");
        assert_eq!(data.missing.len(), 1);
        assert_eq!(data.missing[0].title, "不存在的页");
        // 反链：skimming 链回本页（自链重复不影响），snippet 以本页 title 定位
        assert_eq!(data.backlinks.len(), 1);
        assert_eq!(data.backlinks[0].path.as_deref(), Some("concepts/skimming.md"));
        assert!(data.backlinks[0].snippet.as_deref().unwrap().contains("KWL Chart"));
    }

    #[test]
    fn self_links_skipped_and_not_missing() {
        let data = page_links_from_pages(&pages(), "concepts/skimming.md").unwrap();
        assert!(data.outgoing.iter().all(|e| e.path.as_deref() != Some("concepts/skimming.md")));
        assert!(data.missing.is_empty(), "self-link must be skipped, not missing");
    }

    #[test]
    fn path_variants_resolve_to_same_page() {
        for variant in [
            "entities/kwl-chart.md",
            "/entities/kwl-chart.md",
            "/wiki/entities/kwl-chart.md",
            "wiki/entities/kwl-chart.md",
        ] {
            let data = page_links_from_pages(&pages(), variant);
            assert!(data.is_ok(), "variant {variant} must resolve");
        }
    }

    #[test]
    fn sources_transcripts_maps_to_derived_page() {
        // Files 树点存储源文件 → 计算同 slug 衍生 DB 页的链接（M1 约定）
        let mut pp = pages();
        pp.push(page("transcripts/src-x.md", "Src X 页", "链 [[Skimming]]"));
        let data = page_links_from_pages(&pp, "sources/transcripts/src-x.md").unwrap();
        assert_eq!(data.outgoing.len(), 1);
        assert_eq!(data.outgoing[0].path.as_deref(), Some("concepts/skimming.md"));
        // 前导斜杠变体同样命中
        assert!(page_links_from_pages(&pp, "/sources/transcripts/src-x.md").is_ok());
    }

    #[test]
    fn full_path_wikilinks_resolve_by_direct_lookup() {
        // 全路径形（含 .md）直查命中；缺 .md / 大小写不符 → missing（桌面同构）
        let pp = vec![
            page("a.md", "A", "链 [[concepts/skimming]]、[[concepts/skimming.md]]、[[Concepts/Skimming.md]]"),
            page("concepts/skimming.md", "Skimming", ""),
        ];
        let d = page_links_from_pages(&pp, "a.md").unwrap();
        assert_eq!(d.outgoing.len(), 1, "only the exact .md form resolves");
        assert_eq!(d.outgoing[0].path.as_deref(), Some("concepts/skimming.md"));
        assert_eq!(d.missing.len(), 2, "no-.md and case-mismatch stay missing");

        // 反链：全路径形链接的目标页也能探测到 backlink
        let d2 = page_links_from_pages(&pp, "concepts/skimming.md").unwrap();
        assert_eq!(d2.backlinks.len(), 1);
        assert_eq!(d2.backlinks[0].path.as_deref(), Some("a.md"));
    }

    #[test]
    fn sources_without_derived_page_and_raw_sources_stay_404() {
        let err = page_links_from_pages(&pages(), "sources/transcripts/never-transcribed.md").unwrap_err();
        assert!(matches!(err, AppError::ResourceNotFound(_)));
        let err = page_links_from_pages(&pages(), "raw/sources/LT-Book/Ch01-lesson.md").unwrap_err();
        assert!(matches!(err, AppError::ResourceNotFound(_)), "book chapters have no same-slug derived page");
    }

    #[test]
    fn unknown_path_is_not_found() {
        let err = page_links_from_pages(&pages(), "entities/nope.md").unwrap_err();
        assert!(matches!(err, AppError::ResourceNotFound(_)));
    }

    #[test]
    fn title_resolution_fallback_works() {
        // [[KWL Chart]] 走 title_to_path 命中（stem 不匹配）
        let data = page_links_from_pages(&pages(), "concepts/other.md").unwrap();
        let _ = data; // other 无链接，仅确保构造不炸
        let pages2 = vec![
            page("a.md", "A", "链 [[B Title]]"),
            page("b/actual-stem.md", "B Title", ""),
        ];
        let d = page_links_from_pages(&pages2, "a.md").unwrap();
        assert_eq!(d.outgoing[0].path.as_deref(), Some("b/actual-stem.md"));
    }
}

// ── Page links（Links 面板，镜像桌面 get_page_links_inner 三段语义）──

#[derive(Serialize, Clone, Debug)]
pub struct PageLinkEntry {
    pub title: String,
    pub path: Option<String>,
    pub snippet: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct PageLinksData {
    pub outgoing: Vec<PageLinkEntry>,
    pub backlinks: Vec<PageLinkEntry>,
    pub missing: Vec<PageLinkEntry>,
}

/// 桌面 build_snippet 同构：query（lowercase）定位，±80 字符窗口，换行折空格，截断加省略号。
fn build_snippet(content: &str, query: &str) -> String {
    const SNIPPET_CONTEXT: usize = 80;
    let lower = content.to_lowercase();
    let q = query.to_lowercase();
    let idx = lower.find(&q).unwrap_or(0);
    let char_positions: Vec<usize> = content.char_indices().map(|(i, _)| i).collect();
    if char_positions.is_empty() {
        return String::new();
    }
    let match_char = char_positions
        .iter()
        .position(|byte| *byte >= idx)
        .unwrap_or(char_positions.len().saturating_sub(1));
    let query_chars = query.chars().count().max(1);
    let start_char = match_char.saturating_sub(SNIPPET_CONTEXT);
    let end_char = (match_char + query_chars + SNIPPET_CONTEXT).min(char_positions.len());
    let start = char_positions[start_char];
    let end = if end_char < char_positions.len() {
        char_positions[end_char]
    } else {
        content.len()
    };
    let mut snippet = content[start..end].replace('\n', " ");
    if start > 0 {
        snippet = format!("...{snippet}");
    }
    if end < content.len() {
        snippet.push_str("...");
    }
    snippet
}

/// path 归一：消费方可能传 DB 原路径（entities/x.md）、前导斜杠、或 /wiki 虚拟根
/// 前缀形态（web 知识树）——统一剥到 DB 原路径再查 pages。
fn normalize_page_path(path: &str) -> String {
    let mut p = path.trim().trim_start_matches('/').to_string();
    if let Some(stripped) = p.strip_prefix("wiki/") {
        p = stripped.to_string();
    }
    p
}

/// Links 查找候选：DB 原路径 + 存储源文件→衍生页映射。Files 树点开
/// `sources/transcripts/<slug>.md`（存储源，DB 无同名页）时，计算其同 slug
/// 衍生页 `transcripts/<slug>.md` 的链接（M1 约定，239 个全成立）。
/// raw/sources/**（书籍章节）无同 slug 衍生页（衍生内容并入 concepts 等），
/// 维持 404（与桌面 wiki/ 外报错同语义）。
fn page_link_candidates(target_raw: &str) -> Vec<String> {
    let norm = normalize_page_path(target_raw);
    let mut candidates = vec![norm.clone()];
    if let Some(rest) = norm.strip_prefix("sources/transcripts/") {
        if !rest.is_empty() {
            candidates.push(format!("transcripts/{rest}"));
        }
    }
    candidates
}

/// wikilink 解析（page_links 专用）：全路径形（含 '/'）by_path 直查——镜像桌面
/// resolve_reader_wikilink 第一分支（须含 .md、大小写敏感、miss 不回落 basename，
/// 否则全路径形在 web 恒 missing，Create 按钮会以链接原文建近垃圾页）；裸链接照旧
/// 走 stem/title 双 map（与图谱解析同源）。
fn resolve_link_with_path_form(
    raw: &str,
    by_path: &HashMap<&str, &WikiPageRow>,
    stem_to_path: &HashMap<String, String>,
    title_to_path: &HashMap<String, String>,
) -> Option<String> {
    let link = raw.trim().replace('\\', "/");
    if link.contains('/') {
        return if by_path.contains_key(link.as_str()) {
            Some(link)
        } else {
            None
        };
    }
    resolve_wikilink(&link, stem_to_path, title_to_path)
}

/// 计算 target 页的 outgoing/backlinks/missing（镜像桌面 get_page_links_inner：
/// resolve 用的 stem/title 双 map 与 build_graph 同源，resolve 失败进 missing）。
fn page_links_from_pages(
    pages: &[WikiPageRow],
    target_raw: &str,
) -> Result<PageLinksData, AppError> {
    let paths: Vec<String> = pages.iter().map(|p| p.path.clone()).collect();
    let stem_to_path = build_stem_to_path(&paths);
    let title_to_path = build_title_to_path(
        &pages.iter().map(|p| (p.title.clone(), p.path.clone())).collect::<Vec<_>>(),
    );
    let by_path: HashMap<&str, &WikiPageRow> =
        pages.iter().map(|p| (p.path.as_str(), p)).collect();
    let current = page_link_candidates(target_raw)
        .iter()
        .find_map(|c| by_path.get(c.as_str()))
        .ok_or_else(|| AppError::ResourceNotFound("page not in project".into()))?;

    let mut outgoing: Vec<PageLinkEntry> = Vec::new();
    let mut missing: Vec<PageLinkEntry> = Vec::new();
    for raw in extract_wikilinks(current.content.as_deref().unwrap_or("")) {
        match resolve_link_with_path_form(&raw, &by_path, &stem_to_path, &title_to_path) {
            Some(tgt) if tgt != current.path => {
                if let Some(t) = by_path.get(tgt.as_str()) {
                    outgoing.push(PageLinkEntry {
                        title: t.title.clone(),
                        path: Some(t.path.clone()),
                        snippet: None,
                    });
                }
            }
            Some(_) => {} // 自链接：桌面跳过
            None => missing.push(PageLinkEntry {
                title: raw,
                path: None,
                snippet: None,
            }),
        }
    }

    let mut backlinks: Vec<PageLinkEntry> = Vec::new();
    for page in pages {
        if page.path == current.path {
            continue;
        }
        let links_here = extract_wikilinks(page.content.as_deref().unwrap_or("")).iter().any(|raw| {
            resolve_link_with_path_form(raw, &by_path, &stem_to_path, &title_to_path)
                .is_some_and(|tgt| tgt == current.path)
        });
        if links_here {
            backlinks.push(PageLinkEntry {
                title: page.title.clone(),
                path: Some(page.path.clone()),
                snippet: Some(build_snippet(
                    page.content.as_deref().unwrap_or(""),
                    &current.title,
                )),
            });
        }
    }

    outgoing.sort_by(|a, b| a.title.cmp(&b.title));
    outgoing.dedup_by(|a, b| a.path == b.path);
    backlinks.sort_by(|a, b| a.title.cmp(&b.title));
    missing.sort_by(|a, b| a.title.cmp(&b.title));
    missing.dedup_by(|a, b| a.title == b.title);
    Ok(PageLinksData { outgoing, backlinks, missing })
}

pub async fn page_links(pool: &PgPool, project_id: i32, path: &str) -> Result<PageLinksData, AppError> {
    let pages: Vec<WikiPageRow> = sqlx::query_as::<_, WikiPageRow>(
        "SELECT path, COALESCE(title,'') AS title, page_type, content, sources \
         FROM wiki_pages WHERE project_id = $1 AND COALESCE(page_type,'') != 'query'"
    ).bind(project_id).fetch_all(pool).await.map_err(AppError::DatabaseError)?;
    page_links_from_pages(&pages, path)
}
