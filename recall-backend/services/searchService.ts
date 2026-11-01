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

// Fusion defaults, tuned on the SciFact train split only (eval/tune-fusion.ts).
// Equal weights at k=60 put hybrid below vector only, because FTS is the weaker
// arm on natural-language queries. See eval/RESULTS.md.
export const RRF_K = 3;
export const VECTOR_WEIGHT = 1;
export const FTS_WEIGHT = 0.3;

// At or below this many rows a user gets an exact scan instead of an HNSW walk.
// See nearestContents() and eval/RESULTS.md for the measured crossover.
export const EXACT_SCAN_MAX_ROWS = 450;
const LIMIT = 10;

// Which retrieval arms run. Production always uses the default ("hybrid"); the
// eval harness uses the other two to measure each arm through this same code.
export type SearchMode = "hybrid" | "vector" | "fts";

export interface FusionOptions {
  /** RRF constant: larger values flatten the gap between ranks. */
  k?: number;
  /** Multiplier on the vector arm's scores. */
  vectorWeight?: number;
  /** Multiplier on the FTS arm's scores. */
  ftsWeight?: number;
  limit?: number;
}

/**
 * Weighted Reciprocal Rank Fusion. `idx` is 0-based, so the top row of an arm
 * scores weight/k rather than the textbook weight/(k+1). Ties keep insertion
 * order: vector arm first, then keyword arm. A row in both arms keeps the vector
 * arm's copy (which carries `similarity`).
 */
export function reciprocalRankFusion<T extends Record<string, any>>(
  vectorResults: T[],
  keywordResults: T[],
  options: FusionOptions = {},
): T[] {
  const { k = RRF_K, vectorWeight = VECTOR_WEIGHT, ftsWeight = FTS_WEIGHT, limit = LIMIT } = options;
  const scores = new Map<string, { score: number; item: T }>();

  vectorResults.forEach((item, idx) => {
    const existing = scores.get(item.id);
    scores.set(item.id, {
      score: (existing?.score ?? 0) + vectorWeight / (idx + k),
      item,
    });
  });

  keywordResults.forEach((item, idx) => {
    const existing = scores.get(item.id);
    scores.set(item.id, {
      score: (existing?.score ?? 0) + ftsWeight / (idx + k),
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

type SelectFields = Record<string, any>;

export interface NearestOptions {
  limit?: number;
  minSimilarity?: number;
  /** Columns to return; `similarity` is always added. */
  fields?: SelectFields;
  /** Override for tests; see EXACT_SCAN_MAX_ROWS. */
  exactScanMaxRows?: number;
}

/**
 * Nearest rows for one user, by cosine similarity, highest first. The one vector
 * query in the backend: /search (through hybridSearch) and /chat both use it.
 *
 * A user with few rows gets an exact scan, which costs time in proportion to their
 * own rows. Anyone else gets HNSW with an iterative scan. The row count is a bounded
 * index-only count over idx_contents_user_id: it stops after
 * exactScanMaxRows + 1 entries, so it costs the same for a user with a million rows
 * as for one just over the threshold, with no counter column to keep in sync.
 */
export async function nearestContents(
  db: Db,
  userId: string,
  queryEmbedding: number[],
  options: NearestOptions = {},
): Promise<Array<Record<string, any>>> {
  const {
    limit = LIMIT,
    minSimilarity = 0.3,
    fields = baseFields,
    exactScanMaxRows = EXACT_SCAN_MAX_ROWS,
  } = options;
  const distance = cosineDistance(contents.embedding, queryEmbedding); // emits: embedding <=> $vec
  const similarity = sql<number>`1 - (${distance})`;

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
  // planner cost-chooses a Seq Scan even though the index scan is ~15.1x
  // faster for a user who owns the whole table (SciFact, 5,183 real embeddings,
  // 300 queries x 3 warm passes, p50: 2.74ms index vs 41.57ms seq scan). The gain
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
  // Exact fallback: above the size threshold, fewer than LIMIT rows means the walk
  // ended early, at hnsw.max_scan_tuples (default 20000) or because some rows have
  // no incoming graph links, which no index scan can reach. Rerun exactly. This
  // can't help when LIMIT rows did come back: an unreachable row that should have
  // ranked in them stays missed.
  //
  // The seqscan override is still needed with iterative scan on: the planner
  // still picks a Seq Scan without it, which is correct but much slower for a
  // user who owns most of the table (eval/RESULTS.md).
  const rows: Array<Record<string, any>> = await db.transaction(async (tx) => {
    const nearest = () =>
      tx
        .select({ ...fields, similarity })
        .from(contents)
        .innerJoin(users, eq(contents.userId, users.id))
        .where(eq(contents.userId, userId))
        .orderBy(asc(distance))
        .limit(limit);

    // enable_indexscan = off rules out the HNSW scan. A bitmap scan on the user_id
    // btree stays available, so the planner reads only this user's rows.
    const exact = async () => {
      await tx.execute(sql`set local enable_seqscan = on`);
      await tx.execute(sql`set local enable_bitmapscan = on`);
      await tx.execute(sql`set local enable_sort = on`);
      await tx.execute(sql`set local enable_indexscan = off`);
      return nearest();
    };

    const owned: any = await tx.execute(
      sql`select count(*)::int as n from (select 1 from ${contents} where ${contents.userId} = ${userId} limit ${exactScanMaxRows + 1}) as bounded`,
    );
    if (owned.rows[0].n <= exactScanMaxRows) return exact();

    // All three planner settings are needed to get HNSW. With the user_id btree
    // present, turning off seq scans alone makes the planner read the user's rows
    // through the btree and sort them: exact, and as slow as a seq scan for a large
    // user (eval/RESULTS.md).
    await tx.execute(sql`set local enable_seqscan = off`);
    await tx.execute(sql`set local enable_bitmapscan = off`);
    await tx.execute(sql`set local enable_sort = off`);
    await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
    const approximate = await nearest();
    return approximate.length === limit ? approximate : exact();
  });

  // Similarity cutoff, moved out of SQL (see above). Sorted because relaxed_order
  // does not guarantee distance order, and RRF scores by position.
  return rows
    .filter((r) => (r.similarity as number) > minSimilarity)
    .sort((a, b) => (b.similarity as number) - (a.similarity as number));
}

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
  fusion: FusionOptions = {},
) {
  // NOTE: the two DB queries below run SEQUENTIALLY (separate awaits) — the
  // vector arm fully completes before the keyword arm starts. This is being
  // measured as-is on purpose; do NOT parallelize into Promise.all before the
  // per-arm timings justify it.

  // ---- Dense / vector arm -------------------------------------------------
  let vectorResults: Array<Record<string, any>> = [];
  if (queryEmbedding && mode !== "fts") {
    const t0 = timings ? performance.now() : 0;

    vectorResults = await nearestContents(db, userId, queryEmbedding, { limit: LIMIT, minSimilarity: 0.3 });

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
  const merged = reciprocalRankFusion(vectorResults, keywordResults, fusion);
  if (timings) timings.fusionMs = performance.now() - tf;

  return merged;
}
