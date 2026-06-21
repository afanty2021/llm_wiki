//! Shared wiki-retrieval layer for Layer 3 (chat + research).
//!
//! Pure parts (budget math, priority fill) are unit-tested inline.
//! `retrieve_context()` is the async orchestrator over `search` + `graph`.

use std::collections::{HashMap, HashSet};
use serde::Serialize;
use crate::{AppState, AppError};
use crate::services::citations::{MessageReference, RefKind};

// ---- budget fractions (ported verbatim from desktop context-budget.ts) ----
const DEFAULT_MAX_CTX: usize = 204_800;
const RESPONSE_RESERVE_FRAC: f64 = 0.15;
const INDEX_BUDGET_FRAC: f64 = 0.05;
const PAGE_BUDGET_FRAC: f64 = 0.5;
const PER_PAGE_FRAC: f64 = 0.3;
const PER_PAGE_FLOOR: usize = 5_000;

// ---- retrieval tuning ----
const SEARCH_LIMIT: usize = 10;
const GRAPH_EXPAND_LIMIT: usize = 3;
const GRAPH_RELEVANCE_THRESHOLD: f64 = 2.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudget {
    pub max_ctx: usize,
    pub response_reserve: usize,
    pub index_budget: usize,
    pub page_budget: usize,
    pub max_page_size: usize,
}

/// Character budgets from the model's context window. `context_size <= 0`
/// falls back to the 200K-char default (matches desktop).
pub fn compute_context_budget(context_size: i32) -> ContextBudget {
    let max_ctx = if context_size > 0 {
        context_size as usize
    } else {
        DEFAULT_MAX_CTX
    };
    let response_reserve = (max_ctx as f64 * RESPONSE_RESERVE_FRAC).floor() as usize;
    let index_budget = (max_ctx as f64 * INDEX_BUDGET_FRAC).floor() as usize;
    let page_budget = (max_ctx as f64 * PAGE_BUDGET_FRAC).floor() as usize;
    // Per-page cap: floor 5K, ceiling = page_budget, else 30% of page_budget.
    let max_page_size = std::cmp::min(
        page_budget,
        std::cmp::max(
            PER_PAGE_FLOOR,
            (page_budget as f64 * PER_PAGE_FRAC).floor() as usize,
        ),
    );
    ContextBudget {
        max_ctx,
        response_reserve,
        index_budget,
        page_budget,
        max_page_size,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_default_when_zero_or_negative() {
        let b = compute_context_budget(0);
        assert_eq!(b.max_ctx, DEFAULT_MAX_CTX);
        assert_eq!(b.response_reserve, 30_720); // 204800 * 0.15
        assert_eq!(b.index_budget, 10_240);     // 204800 * 0.05
        assert_eq!(b.page_budget, 102_400);     // 204800 * 0.5
        assert_eq!(b.max_page_size, 30_720);    // 102400 * 0.3
    }

    #[test]
    fn respects_explicit_context_size() {
        let b = compute_context_budget(100_000);
        assert_eq!(b.max_ctx, 100_000);
        assert_eq!(b.page_budget, 50_000);
        assert_eq!(b.max_page_size, 15_000); // 50000 * 0.3
    }

    #[test]
    fn per_page_floor_kicks_in_for_tiny_context() {
        // page_budget = 1000 -> 30% = 300, but floor 5000 wins, capped at page_budget.
        let b = compute_context_budget(2_000);
        assert_eq!(b.page_budget, 1_000);
        assert_eq!(b.max_page_size, 1_000); // min(page_budget=1000, max(5000, 300)) = 1000
    }
}
