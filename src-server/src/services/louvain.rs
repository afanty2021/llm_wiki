// 纯函数 Louvain 社区检测（自移植，无并行）。详见 Task 2 实现。
// 入参：petgraph 无向图（边权 f64）。出参：每个节点（按 NodeIndex 序）的 community id。

use petgraph::graph::Graph;
use petgraph::visit::EdgeRef;
use petgraph::Undirected;
use std::collections::{BTreeMap, HashMap};

type Adj = Vec<HashMap<usize, f64>>;

fn build_adj(n: usize, edges: &[(usize, usize, f64)]) -> Adj {
    let mut adj: Adj = vec![HashMap::new(); n];
    for &(s, t, w) in edges {
        *adj[s].entry(t).or_insert(0.0) += w;
        if s != t {
            *adj[t].entry(s).or_insert(0.0) += w;
        }
    }
    adj
}

fn degree(adj: &Adj, i: usize) -> f64 {
    // 自环 adj[i][i] 计一次，degree 惯例计 2x
    let self_w = adj[i].get(&i).copied().unwrap_or(0.0);
    adj[i].values().sum::<f64>() + self_w
}

fn graph_weight(adj: &Adj) -> f64 {
    let mut m = 0.0;
    for i in 0..adj.len() {
        for (&j, &w) in &adj[i] {
            if j >= i {
                m += w; // 无向边计一次（i<=j，含自环）
            }
        }
    }
    m
}

fn renumber(comm: &[usize]) -> Vec<usize> {
    let mut map: HashMap<usize, usize> = HashMap::new();
    let mut next = 0usize;
    comm.iter()
        .map(|&c| {
            if !map.contains_key(&c) {
                map.insert(c, next);
                next += 1;
            }
            map[&c]
        })
        .collect()
}

/// 单层 local-moving：返回当前层每个节点的社区（重编号 0..k 连续）。
fn one_level(adj: &Adj, resolution: f64) -> Vec<usize> {
    let n = adj.len();
    if n == 0 {
        return Vec::new();
    }
    let m = graph_weight(adj);
    let two_m = 2.0 * m;
    if two_m == 0.0 {
        return (0..n).collect(); // 无边：各自独立
    }
    let mut comm: Vec<usize> = (0..n).collect();
    let mut sigma_tot: Vec<f64> = (0..n).map(|i| degree(adj, i)).collect();
    let mut improved = true;
    while improved {
        improved = false;
        for i in 0..n {
            let ci = comm[i];
            let ki = degree(adj, i);
            // i 到各邻居社区的权重和。用 BTreeMap（确定性序）——gain tie 时按社区 id
            // 升序取首个，保证 louvain 输出确定（满足 deterministic 测试）。
            let mut neighbor_comm: BTreeMap<usize, f64> = BTreeMap::new();
            for (&j, &w) in &adj[i] {
                if j == i {
                    continue;
                }
                *neighbor_comm.entry(comm[j]).or_insert(0.0) += w;
            }
            // 先把 i 从当前社区移出
            sigma_tot[ci] -= ki;
            // 留在原地（空社区）gain=0；移入邻居社区 c 的 gain（Blondel，去公共因子 2m）：
            //   gain = k_i_in - resolution * sigma_tot[c] * k_i / (2m)
            let mut best_comm = ci;
            let mut best_gain = 0.0;
            for (&c, &k_i_in) in &neighbor_comm {
                let gain = k_i_in - resolution * sigma_tot[c] * ki / two_m;
                if gain > best_gain + 1e-12 {
                    best_gain = gain;
                    best_comm = c;
                }
            }
            sigma_tot[best_comm] += ki;
            if best_comm != ci {
                comm[i] = best_comm;
                improved = true;
            }
        }
    }
    renumber(&comm)
}

/// Louvain 多级：local-moving → aggregate → 重复直到某层无合并。
pub fn louvain(graph: &Graph<(), f64, Undirected>, resolution: f64) -> Vec<usize> {
    let n = graph.node_count();
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![0];
    }
    let mut edges: Vec<(usize, usize, f64)> =
        graph.edge_references().map(|e| (e.source().index(), e.target().index(), *e.weight())).collect();
    let mut adj = build_adj(n, &edges);
    // 原始节点 → 当前层节点索引（随 aggregate 更新）
    let mut orig_to_layer_node: Vec<usize> = (0..n).collect();

    loop {
        let layer_comm = one_level(&adj, resolution);
        let k = *layer_comm.iter().max().unwrap_or(&0) + 1; // 本层社区数
        if k == adj.len() {
            // 本层无合并 → 收敛。把社区赋给原始节点。
            let result: Vec<usize> = (0..n).map(|orig| layer_comm[orig_to_layer_node[orig]]).collect();
            return renumber(&result);
        }
        // aggregate：新层 k 个节点（社区内边变自环、跨社区边合并）
        let mut new_edges: Vec<(usize, usize, f64)> = Vec::new();
        for i in 0..adj.len() {
            for (&j, &w) in &adj[i] {
                new_edges.push((layer_comm[i], layer_comm[j], w));
            }
        }
        adj = build_adj(k, &new_edges);
        // 更新 orig → 新层节点（= 旧层节点所在社区）
        for orig in 0..n {
            orig_to_layer_node[orig] = layer_comm[orig_to_layer_node[orig]];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use petgraph::graph::Graph;

    fn graph_from_edges(n: usize, edges: &[(usize, usize, f64)]) -> Graph<(), f64, Undirected> {
        let mut g = Graph::<(), f64, Undirected>::new_undirected();
        let nodes: Vec<_> = (0..n).map(|_| g.add_node(())).collect();
        for &(s, t, w) in edges {
            g.add_edge(nodes[s], nodes[t], w);
        }
        g
    }

    #[test]
    fn separates_two_clusters() {
        // 簇1={0,1,2} 内部全连；簇2={3,4} 内部连；仅一条簇间边(2-3)
        let g = graph_from_edges(5, &[
            (0,1,1.0),(1,2,1.0),(0,2,1.0),
            (3,4,1.0),
            (2,3,0.1),  // 弱簇间
        ]);
        let c = louvain(&g, 1.0);
        // 0,1,2 同社区；3,4 同社区；两簇不同
        assert_eq!(c[0], c[1]); assert_eq!(c[1], c[2]);
        assert_eq!(c[3], c[4]);
        assert_ne!(c[0], c[3], "{:?} 应分成两簇", c);
    }

    #[test]
    fn deterministic() {
        let g = graph_from_edges(6, &[(0,1,1.0),(1,2,1.0),(2,0,1.0),(3,4,1.0),(4,5,1.0),(5,3,1.0),(2,3,0.2)]);
        let a = louvain(&g, 1.0);
        let b = louvain(&g, 1.0);
        assert_eq!(a, b, "louvain 必须确定性");
    }

    #[test]
    fn empty_and_single() {
        let g0: Graph<(), f64, Undirected> = Graph::new_undirected();
        assert_eq!(louvain(&g0, 1.0), Vec::<usize>::new());
        let mut g1 = Graph::<(), f64, Undirected>::new_undirected();
        g1.add_node(());
        assert_eq!(louvain(&g1, 1.0), vec![0]);
    }

    #[test]
    fn no_edges_each_own_community() {
        // 无边 → 各自独立（重编号 0..n）
        let g = graph_from_edges(3, &[]);
        let c = louvain(&g, 1.0);
        assert_eq!(c.len(), 3);
        assert_eq!(c.iter().collect::<std::collections::HashSet<_>>().len(), 3);
    }
}
