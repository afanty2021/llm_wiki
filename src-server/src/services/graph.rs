use sqlx::PgPool;
use crate::AppError;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

#[derive(serde::Serialize, Clone)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub path: String,
    #[serde(rename = "linkCount")]
    pub link_count: i32,
    pub community: i32,
}

#[derive(serde::Serialize, Clone)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub weight: f64,
}

#[derive(serde::Serialize, Clone)]
pub struct CommunityInfo {
    pub id: i32,
    #[serde(rename = "nodeCount")]
    pub node_count: i64,
    pub cohesion: f64,
    #[serde(rename = "topNodes")]
    pub top_nodes: Vec<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct WikiGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub communities: Vec<CommunityInfo>,
}

/// 基本内存缓存：key = (project_id, max_updated_at_timestamp)
static GRAPH_CACHE: std::sync::LazyLock<Mutex<HashMap<(i32, i64), WikiGraph>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// 从 wiki_pages 表构建知识图谱
/// 链接通过 [[wikilink]] 引用解析得出
/// 使用基本内存缓存 — 当 wiki_pages updated_at 变更时自动失效
pub async fn build_graph(
    pool: &PgPool,
    project_id: i32,
) -> Result<WikiGraph, AppError> {
    // 0. 检查缓存
    if let Ok(cache) = GRAPH_CACHE.lock() {
        for ((pid, _ts), graph) in cache.iter() {
            if *pid == project_id {
                return Ok(WikiGraph {
                    nodes: graph.nodes.clone(),
                    edges: graph.edges.clone(),
                    communities: graph.communities.clone(),
                });
            }
        }
    }

    // 1. 获取所有 wiki 页面
    let pages = sqlx::query_as::<_, WikiPageRow>(
        "SELECT path, title, content, page_type FROM wiki_pages WHERE project_id = $1"
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::DatabaseError(e))?;

    // 2. 提取 [[wikilinks]]
    let mut links: HashMap<String, HashSet<String>> = HashMap::new();
    let link_pattern = regex_lite::Regex::new(r"\[\[([^\]]+)\]\]").unwrap();

    for page in &pages {
        let mut targets = HashSet::new();
        if let Some(ref content) = page.content {
            for cap in link_pattern.captures_iter(content) {
                let link_target = cap.get(1).unwrap().as_str().to_string();
                let clean_target = link_target.split('#').next()
                    .unwrap_or(&link_target).to_string();
                targets.insert(clean_target);
            }
        }
        links.insert(page.path.clone(), targets);
    }

    // 3. 构建节点
    let nodes: Vec<GraphNode> = pages.iter().enumerate().map(|(i, p)| {
        let link_count = links.get(&p.path).map(|t| t.len() as i32).unwrap_or(0)
            + links.values().filter(|t| t.contains(&p.path)).count() as i32;
        GraphNode {
            id: format!("node_{}", i),
            label: p.title.clone(),
            node_type: p.page_type.clone().unwrap_or_else(|| "concept".into()),
            path: p.path.clone(),
            link_count,
            community: 0,
        }
    }).collect();

    // 4. 构建边
    let path_to_id: HashMap<&str, &str> = nodes.iter()
        .map(|n| (n.path.as_str(), n.id.as_str()))
        .collect();

    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut seen_edges: HashSet<(String, String)> = HashSet::new();

    for (source_path, targets) in &links {
        let source_id = match path_to_id.get(source_path.as_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };
        for target_path in targets {
            let target_id = match path_to_id.get(target_path.as_str()) {
                Some(id) => id.to_string(),
                None => continue,
            };
            if source_id == target_id { continue; }
            let edge_key = if source_id < target_id {
                (source_id.clone(), target_id.clone())
            } else {
                (target_id.clone(), source_id.clone())
            };
            if seen_edges.contains(&edge_key) { continue; }
            seen_edges.insert(edge_key);
            edges.push(GraphEdge {
                source: source_id.clone(),
                target: target_id.clone(),
                weight: 1.0,
            });
        }
    }

    // 5. 简化社区检测 — 按 page_type 分组作为初始社区
    let mut community_map: HashMap<String, i32> = HashMap::new();
    let mut next_community = 1;
    let mut communities: Vec<CommunityInfo> = Vec::new();

    let mut type_groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, node) in nodes.iter().enumerate() {
        type_groups.entry(node.node_type.clone())
            .or_default()
            .push(i);
    }

    for (node_type, indices) in &type_groups {
        let community_id = *community_map.entry(node_type.clone())
            .or_insert_with(|| { let c = next_community; next_community += 1; c });
        communities.push(CommunityInfo {
            id: community_id,
            node_count: indices.len() as i64,
            cohesion: 1.0 / (indices.len() as f64).max(1.0),
            top_nodes: indices.iter().take(5)
                .map(|&i| nodes[i].label.clone())
                .collect(),
        });
    }

    let graph = WikiGraph { nodes, edges, communities };

    // 6. 写入缓存
    if let Ok(mut cache) = GRAPH_CACHE.lock() {
        cache.insert((project_id, 0), WikiGraph {
            nodes: graph.nodes.clone(),
            edges: graph.edges.clone(),
            communities: graph.communities.clone(),
        });
    }

    Ok(graph)
}

#[derive(sqlx::FromRow)]
struct WikiPageRow {
    path: String,
    title: String,
    content: Option<String>,
    page_type: Option<String>,
}
