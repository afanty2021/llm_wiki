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

/// [[X]] → path：归一化 raw 后查 stem_to_path。
pub(crate) fn resolve_wikilink(raw: &str, stem_to_path: &HashMap<String, String>) -> Option<String> {
    stem_to_path.get(&normalize_stem(raw.trim())).cloned()
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
            let Some(tgt) = resolve_wikilink(&raw, stem_to_path) else { continue };
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
    let path_index: HashMap<String, usize> = paths.iter().enumerate().map(|(i,p)| (p.clone(), i)).collect();

    // 3a. 有向邻接 + 无向边集（build_adjacency 纯函数，对齐桌面 buildRetrievalGraph 有向记录）
    let (adj_out, mut in_links_map, placeholder_edges) = build_adjacency(&pages, &stem_to_path, &path_index);
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
        // 大小写
        assert_eq!(resolve_wikilink("Alice", &s2p), Some("entities/alice.md".into()));
        // 空格↔连字符
        assert_eq!(resolve_wikilink("Project Phoenix", &s2p), Some("entities/project-phoenix.md".into()));
        // 未命中
        assert_eq!(resolve_wikilink("nonexistent", &s2p), None);
    }

    #[test]
    fn build_stem_to_path_dedup_first() {
        // 重复 stem 取首个（path 不同但 stem 同）
        let paths = vec!["entities/alice.md".to_string(), "concepts/alice.md".to_string()];
        let s2p = build_stem_to_path(&paths);
        assert_eq!(s2p.get("alice"), Some(&"entities/alice.md".to_string()));
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
        let path_index: HashMap<String, usize> = paths.iter().enumerate().map(|(i, p)| (p.clone(), i)).collect();
        let (adj_out, in_links_map, placeholder_edges) = build_adjacency(&pages, &stem_to_path, &path_index);
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
