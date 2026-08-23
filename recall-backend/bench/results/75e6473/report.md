# Recall retrieval benchmark — rigor run

- **Date:** 2026-08-23T11:11:21.747Z
- **Commit:** `75e6473df81dd19aaec1c3ad76feed14ddbcb244` (clean tree at run time)
- **Hardware:** Apple M1 Pro, 10 cores, 16 GB RAM, macOS 26.6.1
- **Database:** PostgreSQL 18.4 (Debian 18.4-1.pgdg12+1) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit
  - Runs in Docker: `pgvector/pgvector:pg18 (postgres-db)` (localhost:5432, no explicit container CPU/memory limits)
- **pgvector:** 0.8.2 · HNSW `m=16, ef_construction=64`, `vector_cosine_ops`, `hnsw.ef_search=40` (default, unchanged)
- **Client:** Bun 1.3.14, node-postgres, one dedicated connection per run, queries strictly sequential

## Honesty caveats — read before quoting

1. **The lexical arm is now real Postgres FTS** (this commit): a `GENERATED ALWAYS ... STORED`
   tsvector over title/og_title/summary/og_description (weighted A/B/C/D) with a GIN index,
   queried via `search_vector @@ websearch_to_tsquery('english', $q)` and ordered by
   `ts_rank`. Before this commit the lexical arm was `ILIKE '%query%'` — the before/after
   section below compares against the ILIKE baseline measured at commit `7943212`
   ([raw samples](../7943212-ilike-baseline/raw/)). Whether the planner actually uses the GIN
   index is captured in arm D's EXPLAIN, not forced. The 200 text queries are unchanged from the
   ILIKE run; under websearch_to_tsquery they become AND-of-terms with stemming (see arm D hit
   rate in Results — any query-generation change would be noted here, none was made).
2. **Embeddings are synthetic random unit vectors** (deterministic, fixed-seed). Latency and
   index-vs-scan comparisons are valid (HNSW does the same work over any 1536-dim unit vector);
   random vectors are close to a worst case for HNSW recall, so real-embedding recall@10 is
   plausibly higher than reported here, not lower. Semantic result *quality* is out of scope.
3. **The app's 0.3 similarity cutoff filters out all synthetic matches** (random 1536-dim unit
   vectors have similarity ≈ 0 ± 0.06), so in arm E the fused output is keyword-driven. The vector
   query still executes in full — timings are unaffected — but arm E's fused-result composition on
   real data would differ.
4. Arms A and C include their `BEGIN`/`SET LOCAL`/`COMMIT` round-trips in the measured time,
   because the application pays exactly that cost (`db.transaction` + `set local`). Arm B is a
   bare query, as the default-planner path would be.
5. All rows belong to one bench user, so the `WHERE user_id = $x` filter (which the app always
   applies) matches every row. Multi-tenant selectivity effects are not measured here.
6. Rows and queries are fully deterministic (fixed seeds), but **pgvector's HNSW build itself is
   stochastic** (node levels are assigned randomly), so the graph — and recall@10 — varies
   slightly between rebuilds (observed ≈±2pp at 10k across two builds). Latency is unaffected.

## Protocol

- Dedicated databases `recall_bench_{1000,10000,50000}`, dropped and rebuilt per seed. Dev data untouched.
- 10,000 / 1,000 / 50,000 deterministic rows (fixed-seed mulberry32 PRNG; row *i* is identical at
  every scale), each with a 1536-dim random **unit** embedding and generated article-length text;
  200 of the rows' title/summary phrases double as the text-query set so the lexical arm has
  real hits (phrases are seeded verbatim, so FTS stemming applies to both sides).
- 200 fixed-seed query vectors + 200 fixed text queries; the same query set for every arm.
- **Cache policy: warm.** Explicit warm pass (the full 200-query set once, discarded) per arm,
  then 3 measured rounds × 200 queries. No OS/PG cache drops between rounds. Percentiles are
  nearest-rank over all 600 measured samples per arm×scale.
- Recall@10: arm A (forced seq scan → exact top-10) is ground truth; overlap of B/C top-10 ids.

## Arms

- **A** — sequential scan (SET LOCAL enable_indexscan=off, enable_bitmapscan=off) — exact
- **B** — HNSW available, default planner, no overrides
- **C** — scoped override as implemented: transaction + SET LOCAL enable_seqscan=off
- **D** — lexical arm alone (FTS: search_vector @@ websearch_to_tsquery, ts_rank ordered, GIN-indexed)
- **E** — full hybrid end-to-end at app layer: real hybridSearch() (C-vector + D-FTS + RRF)

The vector SQL is byte-equivalent to the app's query: same projection, `users` join,
`user_id` filter, `ORDER BY embedding <=> $q ASC LIMIT 10`, no distance predicate.

## Results

| Arm | Rows | p50 (ms) | p95 (ms) | recall@10 vs A | n |
|---|---:|---:|---:|---:|---:|
| A | 1,000 | 9.2 | 10.6 | 1.000 (truth) | 600 |
| C | 1,000 | 2.8 | 5.0 | 0.851 | 600 |
| A | 10,000 | 74.9 | 89.4 | 1.000 (truth) | 600 |
| B | 10,000 | 2.8 | 3.7 | 0.215 | 600 |
| C | 10,000 | 3.7 | 5.1 | 0.215 | 600 |
| D | 10,000 | 1.9 | 2.6 | — | 600 |
| E | 10,000 | 7.9 | 10.5 | — | 600 |
| A | 50,000 | 261.3 | 315.4 | 1.000 (truth) | 600 |
| C | 50,000 | 9.5 | 14.5 | 0.057 | 600 |

Arm D text-query hit rate at 10,000 rows: **100.0%** of the 200 fixed queries returned ≥1 row under websearch_to_tsquery semantics.


## Arm E phase breakdown (10k rows, sequential awaits)

| Phase | p50 (ms) | p95 (ms) |
|---|---:|---:|
| pgvector query (C-style) | 4.67 | 6.78 |
| FTS lexical query | 2.84 | 4.11 |
| RRF fusion (in JS) | 0.02 | 0.04 |

## Before/after: ILIKE → FTS (10k rows)

Baseline: commit `7943212` (ILIKE lexical arm), same protocol/hardware/queries, [raw samples](../7943212-ilike-baseline/raw/). Every other number in this report is from the current run only.

| Arm | ILIKE p50/p95 (ms) | FTS p50/p95 (ms) | p50 speedup |
|---|---:|---:|---:|
| D (lexical alone) | 20.5 / 28.8 | 1.9 / 2.6 | 10.8× |
| E (hybrid end-to-end) | 28.4 / 39.3 | 7.9 / 10.5 | 3.6× |

## Claim check

Existing claim "46ms → 9ms (5×)": measured p50 at 10k rows is 74.9ms (seq scan) → 3.7ms (HNSW, scoped override) = 20.5×. The claim as stated does NOT reproduce; the honest numbers are 74.9ms → 3.7ms (20.5×).

## Summary sentences supported by this data

> On 10,000 synthetic 1536-dim rows, forcing the planner onto the HNSW index cut vector top-10 p50 latency from 74.9ms to 3.7ms (20.5×; p95 89.4ms → 5.1ms), at 21.5% recall@10 against the exact scan.

> The default planner now chooses the HNSW index on its own at this scale (arm B p50 2.8ms, plan in armB explain; recall matches arm C) — unlike the ILIKE-era baseline, where arm B cost-chose a seq scan (72.2ms p50 at commit 7943212). Likely cause: the added search_vector column widened the table and raised the seq-scan cost estimate. The app's scoped override is now a safety net rather than the difference-maker at 10k.

> The full hybrid path (vector + lexical + reciprocal-rank fusion), measured end-to-end at the application layer, runs at p50 7.9ms / p95 10.5ms on 10,000 rows.

> Replacing the ILIKE lexical arm with a weighted tsvector + GIN full-text index cut the lexical query's p50 from 20.5ms to 1.9ms (10.8×) and the end-to-end hybrid p50 from 28.4ms to 7.9ms at 10,000 rows (same protocol, hardware, and query set; ILIKE baseline at commit 7943212).

> The latency advantage grows with corpus size — seq-scan vs HNSW p50 is 9.2ms vs 2.8ms at 1k rows (3.4×) and 261.3ms vs 9.5ms at 50k rows (27.5×) — but on this synthetic vector distribution recall@10 falls with it (85.1% at 1k, 21.5% at 10k, 5.7% at 50k), so the speedup cannot be quoted at scale without a recall figure from real embeddings.

> Caution: with the default hnsw.ef_search=40, HNSW recall@10 against the exact scan collapsed as N grew on fixed-seed random unit vectors (a known worst case for graph navigation — uniform random high-dim vectors have no cluster structure). Real embedding recall was NOT measured here; validate it (or raise ef_search) before citing the HNSW numbers as production quality.

## EXPLAIN (ANALYZE, BUFFERS)

One representative capture (query #0) per arm × scale:

- [`armA_scale1000.txt`](explain/armA_scale1000.txt)
- [`armA_scale10000.txt`](explain/armA_scale10000.txt)
- [`armA_scale50000.txt`](explain/armA_scale50000.txt)
- [`armB_scale10000.txt`](explain/armB_scale10000.txt)
- [`armC_scale1000.txt`](explain/armC_scale1000.txt)
- [`armC_scale10000.txt`](explain/armC_scale10000.txt)
- [`armC_scale50000.txt`](explain/armC_scale50000.txt)
- [`armD_scale10000.txt`](explain/armD_scale10000.txt)
- [`armE_scale10000.txt`](explain/armE_scale10000.txt)

## Re-run

```bash
cd recall-backend   # DATABASE_URL comes from .env; scripts refuse non-local hosts
bun run bench/rigor/seed.ts --scale=1000  && bun run bench/rigor/run.ts --scale=1000  --arms=A,C
bun run bench/rigor/seed.ts --scale=10000 && bun run bench/rigor/run.ts --scale=10000
bun run bench/rigor/seed.ts --scale=50000 && bun run bench/rigor/run.ts --scale=50000 --arms=A,C
bun run bench/rigor/report.ts
```

Raw per-query samples: [`raw/`](raw/) (one JSON per scale, includes full sample arrays and arm-E phase timings).
