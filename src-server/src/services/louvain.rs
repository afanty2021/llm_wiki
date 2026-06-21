// 纯函数 Louvain 社区检测（自移植，无并行）。详见 Task 2 实现。
// 入参：petgraph 无向图（边权 f64）。出参：每个节点（按 NodeIndex 序）的 community id。

use petgraph::graph::Graph;
use petgraph::Undirected;

pub fn louvain(_graph: &Graph<(), f64, Undirected>, _resolution: f64) -> Vec<usize> {
    Vec::new() // Task 2 实现
}
