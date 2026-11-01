// Standard IR metrics at a cutoff. `ranked` is the retrieved doc ids in rank
// order; `relevant` maps doc id -> graded relevance (SciFact's are all 1).
// A query that retrieves nothing scores 0 on all three and is never dropped.

export type Relevance = Map<string, number>;

export function ndcgAt(ranked: string[], relevant: Relevance, k: number): number {
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => {
    const rel = relevant.get(id) ?? 0;
    if (rel > 0) dcg += (2 ** rel - 1) / Math.log2(i + 2);
  });

  const ideal = [...relevant.values()].filter((r) => r > 0).sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((sum, rel, i) => sum + (2 ** rel - 1) / Math.log2(i + 2), 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

export function recallAt(ranked: string[], relevant: Relevance, k: number): number {
  const total = [...relevant.values()].filter((r) => r > 0).length;
  if (total === 0) return 0;
  const found = ranked.slice(0, k).filter((id) => (relevant.get(id) ?? 0) > 0).length;
  return found / total;
}

export function mrrAt(ranked: string[], relevant: Relevance, k: number): number {
  const idx = ranked.slice(0, k).findIndex((id) => (relevant.get(id) ?? 0) > 0);
  return idx === -1 ? 0 : 1 / (idx + 1);
}

/** Nearest-rank percentile: the smallest value with at least p% of samples at or below it. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) throw new Error("percentile of an empty list");
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
