import { and, asc, eq, sql } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm";
import { performance } from "node:perf_hooks";
import { db } from "../config/db";
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
  userId: string,
  query: string,
  queryEmbedding: number[] | null,
  timings?: HybridSearchTimings,
) {
  // NOTE: the two DB queries below run SEQUENTIALLY (separate awaits) — the
  // vector arm fully completes before the keyword arm starts. This is being
  // measured as-is on purpose; do NOT parallelize into Promise.all before the
  // per-arm timings justify it.

  // ---- Dense / vector arm -------------------------------------------------
  let vectorResults: Array<Record<string, any>> = [];
  if (queryEmbedding) {
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
    // planner cost-chooses a Seq Scan even though the index scan is ~10-20x
    // faster here (measured warm: ~2-6ms index vs ~44ms seq scan on 10k rows).
    // Removing the threshold alone does NOT flip the plan (confirmed by
    // EXPLAIN); disabling seqscan for this one transaction does. It's scoped to
    // this transaction via SET LOCAL, so nothing leaks to other queries.
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx
        .select({ ...baseFields, similarity })
        .from(contents)
        .innerJoin(users, eq(contents.userId, users.id))
        .where(eq(contents.userId, userId))
        .orderBy(asc(distance))
        .limit(LIMIT);
    });

    // 0.3 similarity cutoff, moved out of SQL (see above).
    vectorResults = rows.filter((r) => (r.similarity as number) > 0.3);

    if (timings) timings.vectorMs = performance.now() - t0;
  } else if (timings) {
    timings.vectorMs = 0;
  }

  // ---- Lexical / keyword arm (Postgres FTS over the generated tsvector) ---
  // search_vector is GENERATED ALWAYS from title/og_title/summary/
  // og_description (weighted A/B/C/D — see db/schema.ts) and GIN-indexed.
  //
  // The tsquery fragment below appears three times in the SQL text, but
  // websearch_to_tsquery with an EXPLICIT config is IMMUTABLE, so the planner
  // folds it to a single '...'::tsquery constant at plan time — verified in
  // the bench's captured EXPLAIN, which shows the folded constant, not three
  // function calls.
  //
  // Empty/stopword-only queries: websearch_to_tsquery returns an EMPTY tsquery
  // (numnode = 0), and `@@ empty` matches nothing. The numnode guard preserves
  // the old ILIKE behavior for that case ('%%' matched everything): return up
  // to LIMIT arbitrary rows. ts_rank against an empty query is 0 for every
  // row, so the ordering is as arbitrary as the ILIKE path's missing ORDER BY.
  const tsq = sql`websearch_to_tsquery('english', ${query})`;
  const tk = timings ? performance.now() : 0;
  const keywordResults = await db
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
  const scores = new Map<string, { score: number; item: any }>();

  vectorResults.forEach((item, idx) => {
    const existing = scores.get(item.id);
    scores.set(item.id, {
      score: (existing?.score ?? 0) + 1 / (idx + RRF_K),
      item,
    });
  });

  keywordResults.forEach((item, idx) => {
    const existing = scores.get(item.id);
    scores.set(item.id, {
      score: (existing?.score ?? 0) + 1 / (idx + RRF_K),
      item: existing?.item ?? item,
    });
  });

  const merged = Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT)
    .map(({ item }) => item);
  if (timings) timings.fusionMs = performance.now() - tf;

  return merged;
}
