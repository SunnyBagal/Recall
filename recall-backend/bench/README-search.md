# Hybrid-search latency benchmark

Measures latency of Recall's hybrid search: **pgvector cosine (dense) + ILIKE
substring (lexical), fused with Reciprocal Rank Fusion (k=60) in app code.**

> Location note: these scripts live in `recall-backend/bench/` (not repo-root
> `/bench`) so they resolve the backend's `node_modules` (`pg`, `drizzle-orm`,
> `argon2`) and its `.env`. Run everything from the `recall-backend/` directory.

## What's actually being measured (read this first)

- **The retrieval code is the real code.** The search logic was extracted to
  `services/searchService.ts::hybridSearch()`. The `/search` route **and** the
  benchmark's retrieval-only mode both call that exact function — no forked/
  copy-pasted logic.
- The dense side is **pgvector** on a `vector(1536)` column (OpenAI
  `text-embedding-3-small`). The table is `contents` (the "cards"); the
  embedding is a **column on it**, not a separate table.
- The lexical side is **`ILIKE '%q%'`** over `title`/`summary`/`og_title`/
  `og_description`. **It is NOT Postgres `tsvector`/GIN full-text search.** Call
  it "keyword/ILIKE", not "FTS", when you report numbers.
- Synthetic vectors are **random unit vectors**, so they don't match query
  embeddings semantically — the dense arm returns ~nothing above the 0.3
  threshold. **The full cosine scan / HNSW traversal over N rows still runs**
  (that's the latency-relevant work). This is a **latency** benchmark, **not a
  recall/quality** benchmark.

## Safety: local DB only

`seed-vectors.ts` and `bench-search.ts` **seed and wipe** data, so `shared.ts`
gates every run: it parses `DATABASE_URL` and **aborts loudly** unless the host
is `localhost` / `127.0.0.1` / `::1` / `0.0.0.0`. To run against a non-local DB
you must pass `--allow-remote` explicitly — otherwise the production Railway DB
can never be touched by accident. Both scripts print the resolved **DB host**
(and that they load `recall-backend/.env` via Bun auto-load) in their startup
banner, and the gate runs *before* any connection or mutation.

## Prerequisites

- Local Postgres with `pgvector` (verified: 0.8.2), reachable via `DATABASE_URL`
  in `recall-backend/.env`. Bun auto-loads that `.env` when you run from
  `recall-backend/`.
- `OPENAI_API_KEY` in `.env`:
  - **end-to-end mode**: needed on the **server** — every `/search` call embeds
    the query live via OpenAI.
  - **retrieval-only mode**: **optional.** If set, the 20 query embeddings are
    built once via OpenAI and cached to `bench/query-embeddings.json` (re-runs
    cost **zero** API calls). If the key is missing **or** the call fails
    (no credits, network), the bench falls back to **deterministic synthetic**
    query vectors — a mulberry32 PRNG seeded per query string, so re-runs are
    identical. The cache records `"synthetic": true`, and the startup banner
    prints `query embeddings: synthetic (random unit vectors)` vs
    `openai (cached)`.

    **For latency this is equivalent**: pgvector's scan / HNSW traversal does
    the same work over any 1536-d unit vector. Synthetic query vectors would
    only be wrong for a **recall/quality** benchmark — which this explicitly is
    not (see "Do NOT claim").

## The two modes — and why both exist

| Mode | Flag | Times | Includes |
| --- | --- | --- | --- |
| **end-to-end `/search`** | *(default)* | Real HTTP round-trip to the running API | HTTP + **live OpenAI embed** + pgvector + ILIKE + RRF |
| **retrieval-only** | `--retrieval-only` | `hybridSearch()` called directly with a **precomputed** embedding | pgvector + ILIKE + RRF **only** |

End-to-end includes a **third-party network call** (OpenAI embeddings) that
typically **dominates** the number and adds variance. Retrieval-only isolates
*your* database + fusion cost. Report them separately; never present the
end-to-end number as if it were the DB's latency.

## Run steps

```bash
cd recall-backend

# 1. Seed synthetic data (idempotent; default 10k rows, all owned by bench user)
bun run bench/seed-vectors.ts                  # or --scale=50000
#   -> prints final contents count(*)
#   wipe later with: bun run bench/seed-vectors.ts --wipe

# 2a. Retrieval-only (no API server needed; builds the embedding cache once)
bun run bench/bench-search.ts --retrieval-only
bun run bench/bench-search.ts --retrieval-only --concurrency=10   # optional

# 2b. End-to-end (start the API first, in another terminal)
bun run index.ts                               # terminal A  (restart after code changes!)
bun run bench/bench-search.ts                  # terminal B
bun run bench/bench-search.ts --concurrency=10 # optional
```

Every run prints, at startup: **vector index type** (queried from
`pg_indexes`), row count, embeddings count, runtime/Node version, and whether
the DB is local — so before/after runs are self-documenting.

Options: `--measured=500` `--warmup=50` `--concurrency=1` `--api=http://localhost:3000`.
Protocol is fixed at 50 warmup (discarded) + 500 measured, 20 rotating queries,
percentiles nearest-rank from raw samples.

## Per-arm breakdown + HNSW usage check (retrieval-only)

Retrieval-only mode additionally reports **p50/p95 per arm**, measured via an
optional `timings` out-param on `hybridSearch()` (production callers pass
nothing, so the route's code path is unchanged):

```text
--- per-arm breakdown (sequential awaits: pgvector -> ILIKE -> RRF) ---
  (a) pgvector       p50   ...  ms   p95   ...  ms   (n=500)
  (b) ILIKE lexical  p50   ...  ms   p95   ...  ms   (n=500)
  (c) RRF fusion     p50   ...  ms   p95   ...  ms   (n=500)
```

**The two DB queries run sequentially** (separate `await`s: pgvector fully
completes before ILIKE starts), so (a)+(b)+(c) ≈ total. This is measured as-is
on purpose — **do not** parallelize into `Promise.all` until these numbers show
it's worth it.

Every startup also runs a one-shot **`EXPLAIN (ANALYZE, COSTS OFF)`** that
mirrors the real vector arm — clean top-k (`ORDER BY embedding <=> $vec ASC
LIMIT`, no distance predicate) inside a transaction with `SET LOCAL
enable_seqscan = off` — and prints whether the plan is an HNSW `Index Scan` or a
`Seq Scan`:

```text
  hnsw check:    USED — Index Scan (hnsw) ✓
                 plan: ->  Index Scan using idx_contents_embedding_hnsw on contents c ...
```

If it prints `NOT used — Seq Scan`, the index isn't engaging (e.g. the index was
dropped, or there are no embedded rows). This is the guard that keeps an "after"
number honest: if this says Seq Scan, the index did nothing. See the cost-model
note below for *why* `enable_seqscan = off` is needed at all.

## Before/after methodology (measuring the HNSW index)

The whole point of the index is a before/after delta. Because the index only
helps at scale, **seed first**, then:

```bash
cd recall-backend
bun run bench/seed-vectors.ts --scale=10000

# BEFORE — drop the index, re-run retrieval-only, record p50/p95/p99
psql "$DATABASE_URL" -c 'DROP INDEX IF EXISTS idx_contents_embedding_hnsw;'
psql "$DATABASE_URL" -c 'ANALYZE contents;'
bun run bench/bench-search.ts --retrieval-only        # startup prints: index "none (sequential scan)"

# AFTER — recreate the index, re-run
psql "$DATABASE_URL" -f drizzle/0001_hnsw_index.sql
psql "$DATABASE_URL" -c 'ANALYZE contents;'
bun run bench/bench-search.ts --retrieval-only        # startup prints: index "hnsw (vector_cosine_ops)"
```

The startup line documents which index was live for each run. Use
**retrieval-only** for this comparison — the OpenAI call in end-to-end mode
would swamp the index delta.

### Critical correctness notes about the index

Two separate things had to be true for the HNSW index to actually run. Both were
diagnosed with `EXPLAIN ANALYZE`, not guessed.

**1. ORDER BY must be raw distance ascending.** pgvector's HNSW index is **only**
used for `ORDER BY embedding <=> $vec ASC`. The original query ordered by
`1 - (embedding <=> $vec) DESC` — arithmetically identical, but the planner
cannot map it to the index operator, so it `Seq Scan`ned even with
`enable_seqscan=off`. Fixed in `services/searchService.ts` (`ORDER BY asc(distance)`).
Opclass is `vector_cosine_ops`, matching `<=>`.

**2. The planner under-costs HNSW at this table size, and the 0.3 cutoff moved
to JS.** Even with the correct ORDER BY, at 10k rows the plan was *still* a
Seq Scan. Isolated one change at a time:

| Change | Plan |
| --- | --- |
| remove the `1 - dist > 0.3` threshold from WHERE | still Seq Scan |
| remove the `user_id` filter/join | still Seq Scan |
| pure `ORDER BY dist LIMIT 10`, no filters at all | still Seq Scan |
| `SET hnsw.iterative_scan = strict_order` | no change |
| **`SET LOCAL enable_seqscan = off`** | **Index Scan (hnsw) ✓** |

So the WHERE threshold was **not** the culprit (the popular guess) — it's a
**cost-model** miss: pgvector estimates the HNSW startup cost (~2188) above a
seq-scan+top-N (~1388), so the planner picks the seq scan. That estimate is
wrong on real latency — **warm, the forced index is ~2–6 ms vs ~44 ms for the
seq scan** (~10–20×). The vector arm now:

- runs a **clean top-k** (`ORDER BY dist ASC LIMIT k`, no distance predicate in
  SQL) inside a transaction with **`SET LOCAL enable_seqscan = off`** (scoped,
  nothing leaks), and
- applies the **0.3 similarity cutoff in JS** on the returned rows.

Because rows passing the cutoff are exactly the nearest rows, top-k-then-filter
is **byte-identical** to `WHERE 1-dist > 0.3 ... LIMIT k` — verified with a
same-vector ID comparison at thresholds −1, 0, 0.05, 0.3 (all identical).
Keeping the threshold in SQL would also have broken the index path at scale
(it filters the `ef_search` candidates and can return `< k` rows).

The startup `hnsw check:` line confirms the live plan is an `Index Scan` — if it
ever prints `Seq Scan`, the index did nothing and the "after" number is a lie.

## How to state this result (honest templates)

**Retrieval-only (this is "my" number — my code, my DB):**

> "pX search latency of **__ ms** over **N** vectors — hybrid retrieval
> (pgvector cosine + ILIKE keyword, fused with reciprocal rank fusion in app
> code) — measured locally against a seeded dev DB on **[hardware]**,
> **concurrency 1, warm cache**, embedding **precomputed** (excludes the
> embedding call)."

**End-to-end `/search` (includes a third-party API call):**

> "pX **end-to-end** `/search` latency of **__ ms** over **N** vectors,
> measured locally on **[hardware]**, concurrency 1, warm cache — **includes a
> live OpenAI `text-embedding-3-small` call per request**, which dominates the
> number."

If the index was live, add: **"approximate-NN via HNSW, `hnsw.ef_search`=40
(pgvector default)."**

## Do NOT claim

- ❌ No **production / scale** claims. This is a local dev box, seeded synthetic
  data, warm cache — not production traffic, not concurrent real users.
- ❌ No **retrieval-quality** claims. This measures **latency, not recall@k**.
  Random synthetic vectors mean semantic matches are ~zero; **recall@k was not
  measured**.
- ❌ Don't call the lexical side **"full-text search / FTS / GIN"** — it's
  `ILIKE` substring matching.
- ❌ Don't round e.g. **140 ms → "sub-100 ms."** Quote the measured pXX.
- ❌ Don't quote the **`--concurrency=10`** numbers without saying
  "concurrency 10." The headline number is **concurrency 1**.
- ❌ Don't present the **end-to-end** number as the DB's latency — it includes
  the OpenAI round-trip.
- ❌ Don't quote **HNSW** numbers as exact nearest-neighbor. HNSW is
  **approximate** (default `ef_search`=40); recall was not measured.
