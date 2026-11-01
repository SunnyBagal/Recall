import { and, asc, eq, sql } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm";
import { performance } from "node:perf_hooks";
import type { Db } from "../config/db";
import { contents, users } from "../db/schema";

// Optional per-arm timing sink for benchmarking. When a caller passes one,
// hybridSearch() fills in the wall time of each phase. Production callers pass
// nothing, and every measurement is guarded by `if (timings)` so the normal
// code path is completely unchanged.
export interface HybridSearchTimings {
  vectorMs: number; // pgvector (dense) query
  keywordMs: number; // FTS (lexical) query
  fusionMs: number; // RRF fusion in app code
}

// Reciprocal Rank Fusion constant (k). Kept identical to the original inline
// implementation so results are byte-for-byte unchanged after the extraction.
const RRF_K = 60;
const LIMIT = 10;

// Which retrieval arms run. Production always uses the default ("hybrid"); the
// eval harness uses the other two to measure each arm through this same code.
export type SearchMode = "hybrid" | "vector" | "fts";

/**
 * Reciprocal Rank Fusion. `idx` is 0-based, so the top row of an arm scores
 * 1/k rather than the textbook 1/(k+1). Ties keep insertion order: vector arm
 * first, then keyword arm. A row in both arms keeps the vector arm's copy
 * (which carries `similarity`).
 */
export function reciprocalRankFusion<T extends Record<string, any>>(
  vectorResults: T[],
  keywordResults: T[],
  limit: number = LIMIT,
  k: number = RRF_K,
): T[] {
  const scores = new Map<string, { score: number; item: T }>();

  vectorResults.forEach((item, idx) => {
    const existing = scores.get(item.id);
    scores.set(item.id, {
      score: (existing?.score ?? 0) + 1 / (idx + k),
      item,
    });
  });

  keywordResults.forEach((item, idx) => {
    const existing = scores.get(item.id);
    scores.set(item.id, {
      score: (existing?.score ?? 0) + 1 / (idx + k),
      item: existing?.item ?? item,
    });
  });

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => item);
}

// Shared projection for both retrieval arms.
const baseFields = {
  id: contents.id,
  title: contents.title,
  link: contents.link,
  type: contents.type,
  tags: contents.tags,
  ogTitle: contents.ogTitle,
  ogDescription: contents.ogDescription,
  ogImage: contents.ogImage,
  ogSiteName: contents.ogSiteName,
  favicon: contents.favicon,
  embedUrl: contents.embedUrl,
  summary: contents.summary,
  processingStatus: contents.processingStatus,
  createdAt: contents.createdAt,
  username: users.username,
};

/**
 * Hybrid search: pgvector cosine similarity (dense) + Postgres full-text
 * search over the generated search_vector column (lexical), fused with
 * Reciprocal Rank Fusion (k=60) in application code.
 *
 * This is the SINGLE source of truth for the retrieval path — the /search
 * route handler and the benchmark both call this exact function so the bench
 * measures the real code, not a fork.
 *
 * `queryEmbedding` is passed in (not computed here) so callers control where
 * the embedding comes from: the route embeds live via OpenAI per request; the
 * benchmark's retrieval-only mode passes a precomputed embedding to isolate DB
 * + fusion latency from the external embedding call.
 */
export async function hybridSearch(
  db: Db,
  userId: string,
  query: string,
  queryEmbedding: number[] | null,
  timings?: HybridSearchTimings,
  mode: SearchMode = "hybrid",
) {
  // NOTE: the two DB queries below run SEQUENTIALLY (separate awaits) — the
  // vector arm fully completes before the keyword arm starts. This is being
  // measured as-is on purpose; do NOT parallelize into Promise.all before the
  // per-arm timings justify it.

  // ---- Dense / vector arm -------------------------------------------------
  let vectorResults: Array<Record<string, any>> = [];
  if (queryEmbedding && mode !== "fts") {
    const distance = cosineDistance(contents.embedding, queryEmbedding); // emits: embedding <=> $vec
    const similarity = sql<number>`1 - (${distance})`;

    const t0 = timings ? performance.now() : 0;

    // Clean top-k ANN: ORDER BY raw distance ASC, LIMIT k, with NO distance
    // predicate in SQL. This is the only ordering form pgvector's HNSW index
    // can serve. The 0.3 similarity cutoff that used to live in the WHERE is
    // applied in JS below — since rows that pass the cutoff are exactly the
    // nearest rows (high similarity = low distance), taking the top-k then
    // filtering yields byte-identical results to `WHERE 1-dist > 0.3 ... LIMIT k`
    // (verified: identical IDs across thresholds -1, 0, 0.05, 0.3). Keeping the
    // threshold in SQL also breaks the HNSW path at scale — it filters the
    // ef_search candidates and can return < k rows.
    //
    // SET LOCAL enable_seqscan = off: at this table size pgvector under-costs
    // the HNSW index (estimated startup cost > a seq-scan+top-N), so the
    // planner cost-chooses a Seq Scan even though the index scan is ~16.8x
    // faster for a user who owns the whole table (SciFact, 5,183 real embeddings,
    // 300 queries x 3 warm passes, p50: 2.65ms index vs 44.60ms seq scan). The gain
    // shrinks with the user's share of the table: see eval/RESULTS.md. The earlier
    // 64x in docs/explain/ was one query on 10k rows owned by one user.
    // Removing the threshold alone does NOT flip the plan (confirmed by
    // EXPLAIN); disabling seqscan for this one transaction does. It's scoped to
    // this transaction via SET LOCAL, so nothing leaks to other queries.
    //
    // SET LOCAL hnsw.iterative_scan = relaxed_order (pgvector >= 0.8): HNSW picks
    // its ef_search candidates BEFORE the user_id filter runs, so without this a
    // user whose rows aren't among the table's nearest candidates loses results,
    // up to all of them. The iterative scan keeps walking the graph until LIMIT
    // rows pass the filter.
    //
    // relaxed_order, not strict_order: on SciFact, strict returned fewer of the
    // exact top 10 at the same latency (eval/RESULTS.md). Relaxed can return rows
    // slightly out of order, so they are re-sorted by similarity below.
    //
    // Exact fallback: fewer than LIMIT rows means the walk ended early. Either the
    // user has few rows, or it hit hnsw.max_scan_tuples (default 20000), or some
    // of the user's rows have no incoming graph links, which no index scan can
    // reach. A user with few saved items must not permanently lose one, so rerun
    // exactly. This can't help when LIMIT rows did come back: an unreachable row
    // that should have ranked in them stays missed.
    //
    // The seqscan override is still needed with iterative scan on: the planner
    // still picks a Seq Scan without it, which is correct but much slower for a
    // user who owns most of the table (eval/RESULTS.md).
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
      const nearest = () =>
        tx
          .select({ ...baseFields, similarity })
          .from(contents)
          .innerJoin(users, eq(contents.userId, users.id))
          .where(eq(contents.userId, userId))
          .orderBy(asc(distance))
          .limit(LIMIT);

      const approximate = await nearest();
      if (approximate.length === LIMIT) return approximate;

      await tx.execute(sql`set local enable_seqscan = on`);
      await tx.execute(sql`set local enable_indexscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      return nearest();
    });

    // 0.3 similarity cutoff, moved out of SQL (see above). Sorted because
    // relaxed_order does not guarantee distance order, and RRF scores by position.
    vectorResults = rows
      .filter((r) => (r.similarity as number) > 0.3)
      .sort((a, b) => (b.similarity as number) - (a.similarity as number));

    if (timings) timings.vectorMs = performance.now() - t0;
  } else if (timings) {
    timings.vectorMs = 0;
  }

  // ---- Lexical / keyword arm (Postgres FTS over the generated tsvector) ---
  // search_vector is GENERATED ALWAYS from title/og_title/summary/
  // og_description (weighted A/B/C/D — see db/schema.ts) and GIN-indexed.
  //
  // Terms are ORed, ranked by ts_rank. websearch_to_tsquery ANDs them, so one
  // unmatched word returned nothing: 285 of 300 SciFact test queries came back
  // empty. Plain OR scored level with "AND, then OR" on the train split and is
  // one query instead of two (eval/fts-variants.ts).
  //
  // Only the implicit ANDs between terms change: "quoted phrases" and an explicit
  // `or` keep their meaning. A query with a -negation keeps AND, since
  // `a | !b` would match nearly every row.
  //
  // The expression appears several times in the SQL text, but it is built from
  // immutable functions, so the planner folds it to one '...'::tsquery constant
  // (confirmed with EXPLAIN).
  //
  // Empty/stopword-only queries: websearch_to_tsquery returns an EMPTY tsquery
  // (numnode = 0), and `@@ empty` matches nothing. The numnode guard preserves
  // the old ILIKE behavior for that case ('%%' matched everything): return up
  // to LIMIT arbitrary rows. ts_rank against an empty query is 0 for every
  // row, so the ordering is as arbitrary as the ILIKE path's missing ORDER BY.
  const parsed = sql`websearch_to_tsquery('english', ${query})`;
  const tsq = sql`(case when strpos(${parsed}::text, '!') > 0 then ${parsed} else replace(${parsed}::text, ' & ', ' | ')::tsquery end)`;
  const tk = timings ? performance.now() : 0;
  const keywordResults: Array<Record<string, any>> = mode === "vector" ? [] : await db
    .select(baseFields)
    .from(contents)
    .innerJoin(users, eq(contents.userId, users.id))
    .where(
      and(
        eq(contents.userId, userId),
        sql`(numnode(${tsq}) = 0 or ${contents.searchVector} @@ ${tsq})`,
      ),
    )
    .orderBy(sql`ts_rank(${contents.searchVector}, ${tsq}) desc`)
    .limit(LIMIT);
  if (timings) timings.keywordMs = performance.now() - tk;

  // ---- Reciprocal Rank Fusion (in app code) -------------------------------
  const tf = timings ? performance.now() : 0;
  const merged = reciprocalRankFusion(vectorResults, keywordResults);
  if (timings) timings.fusionMs = performance.now() - tf;

  return merged;
}
