use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use crate::AppError;

// ── 四信号权重（桌面 graph-relevance.ts 原值）──
const W_DIRECT_LINK: f64 = 3.0;
const W_SOURCE_OVERLAP: f64 = 4.0;
const W_COMMON_NEIGHBOR: f64 = 1.5;
const W_TYPE_AFFINITY: f64 = 1.0;

/// 类型亲和度矩阵（照搬桌面；新 type 走 default 0.5）。
fn type_affinity(a: &str, b: &str) -> f64 {
    let m = |t: &str| -> std::collections::HashMap<&str, f64> {
        let mut h = std::collections::HashMap::new();
        match t {
            "entity" => { h.insert("concept",1.2); h.insert("entity",0.8); h.insert("source",1.0); h.insert("synthesis",1.0); h.insert("query",0.8); }
            "concept" => { h.insert("entity",1.2); h.insert("concept",0.8); h.insert("source",1.0); h.insert("synthesis",1.2); h.insert("query",1.0); }
            "source" => { h.insert("entity",1.0); h.insert("concept",1.0); h.insert("source",0.5); h.insert("query",0.8); h.insert("synthesis",1.0); }
            "query" => { h.insert("concept",1.0); h.insert("entity",0.8); h.insert("synthesis",1.0); h.insert("source",0.8); h.insert("query",0.5); }
            "synthesis" => { h.insert("concept",1.2); h.insert("entity",1.0); h.insert("source",1.0); h.insert("query",1.0); h.insert("synthesis",0.8); }
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

// TRANSIENT NOTE: 旧 build_graph + GraphNode/GraphEdge/CommunityInfo/WikiGraph/GRAPH_CACHE 已删，
// 在 2c Task5 重建（真 Louvain + relevance 边权）。期间 routes/graph.rs 走 transient stub。
// `use sqlx::PgPool;` 暂未消费（Task5 build_graph 才用），unused warning 无害。

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
}
