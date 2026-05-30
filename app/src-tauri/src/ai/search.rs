//! Vector similarity search for "ask my inbox" (RAG). Pure functions over
//! embeddings the store holds; the model provider supplies the vectors.
//!
//! This is an exact (brute-force) cosine search — fine for a personal mailbox.
//! For very large stores, swap in an ANN index (sqlite-vec / HNSW) behind the
//! same `top_k` signature.

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum();
    let nb: f32 = b.iter().map(|x| x * x).sum();
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Return the ids of the `k` most similar items to `query`, best first.
pub fn top_k(query: &[f32], items: &[(String, Vec<f32>)], k: usize) -> Vec<String> {
    let mut scored: Vec<(f32, &String)> = items
        .iter()
        .map(|(id, v)| (cosine(query, v), id))
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(k).map(|(_, id)| id.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_identical_is_one() {
        let v = vec![1.0, 2.0, 3.0];
        assert!((cosine(&v, &v) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_orthogonal_is_zero() {
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }

    #[test]
    fn top_k_orders_by_similarity() {
        let q = vec![1.0, 0.0];
        let items = vec![
            ("far".into(), vec![0.0, 1.0]),
            ("near".into(), vec![0.9, 0.1]),
            ("mid".into(), vec![0.6, 0.6]),
        ];
        let got = top_k(&q, &items, 2);
        assert_eq!(got[0], "near");
        assert_eq!(got.len(), 2);
    }
}
