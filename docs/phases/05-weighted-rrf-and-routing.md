# Phase 5: Weighted RRF and routing by user size

**The ask, on the same PR:**
1. **Weighted RRF:** add per-arm weights and expose k. Tune on the SciFact **train** split only and report test once. The goal is hybrid at or above vector only. If nothing gets there, say so, and don't drop FTS.
2. **Route by user size:** measure seq scan against HNSW at about 150, 300 and 600 rows per user, find the crossover, and use an exact scan below it (with a `user_id` btree) and HNSW with iterative scan above it. Get the row count cheaply.
3. **Chat:** route chat's vector query through the fixed search function and add a test.
4. **Comment and `docs/`:** replace "~64x" in the `searchService.ts` comment with the measured number and its conditions, and commit `docs/`.
5. **Results:** rerun and keep before, round 1 and round 2 in `RESULTS.md`.

## Commits
- `026d0eb`: measured comment and `docs/explain`
- `780b154`: weights and routing, which rewrote the same code
- `124a8c9`: chat on `nearestContents`
- `3f5a69f`: round 2 results

## 1. Weighted RRF: goal narrowly missed
`eval/tune-fusion.ts` tried 150 settings on the 809 train queries. The vector weight was fixed at 1, and the setting with the highest nDCG@10 was chosen: **FTS weight 0.3, k=3**. It was run on test once.

| Round | Hybrid nDCG@10 | Recall@10 | MRR@10 | Against vector only (better / worse / tied) |
|---|---|---|---|---|
| Before | 0.7209 | 0.8549 | 0.6866 | 1 / 1 / 298 |
| Round 1, equal weights | 0.6742 | 0.8423 | 0.6298 | 38 / 89 / 173 |
| **Round 2, weighted** | **0.7192** | **0.8549** | **0.6848** | **16 / 20 / 264** |
| Vector only, all rounds | 0.7201 | 0.8549 | 0.6856 | n/a |

- **A statistical tie:** the gap is -0.0009, with a paired bootstrap 95% interval of -0.0070 to +0.0050 and a sign test p of 0.62.
- **Train margin didn't carry over:** on train the chosen setting beat vector only by 0.0015.
- **Only one setting on test:** other settings were never run on test, so this doesn't show that no setting could reach the goal.
- **Recommendation:**
  - Keep FTS with these weights, which recover nearly all of round 1's drop.
  - Test on a keyword query set before tuning further, because SciFact's natural-language claims can't show what FTS adds.
  - FTS still returns results when the embedding call fails.
- **Latency cost of FTS:** hybrid warm p50 is 8.20 ms, against 2.74 ms for vector only.

## 2. Routing by user size
Warm p50 / p95 in ms, 300 queries × 3 passes, commit `124a8c9`:

| User owns | Route | Exact via btree | HNSW | Production | Exact top 10 returned | Routing count |
|---|---|---|---|---|---|---|
| 8 rows | Exact | 0.39 / 0.42 | 20.15 / 23.65 | 1.11 / 1.39 | 100.00% | 0.06 / 0.07 |
| 68 rows | Exact | 0.98 / 1.03 | 10.24 / 12.95 | 1.58 / 1.89 | 100.00% | 0.06 / 0.11 |
| 150 rows | Exact | 1.61 / 1.76 | 6.90 / 8.87 | 2.20 / 2.40 | 100.00% | 0.07 / 0.11 |
| 300 rows | Exact | 2.89 / 3.11 | 4.84 / 6.31 | 3.41 / 4.00 | 100.00% | 0.07 / 0.13 |
| 450 rows | Exact | 4.06 / 4.86 | 4.12 / 5.67 | 4.80 / 5.30 | 100.00% | 0.08 / 0.13 |
| 600 rows | HNSW | 5.25 / 5.84 | 3.51 / 4.69 | 4.14 / 5.37 | 98.97% | 0.08 / 0.13 |
| 1,041 rows | HNSW | 8.64 / 9.98 | 2.90 / 3.74 | 3.55 / 4.58 | 98.42% | 0.08 / 0.14 |
| All 5,183 rows | HNSW | 41.55 / 44.89 | 2.13 / 2.61 | 2.74 / 3.26 | 99.43% | 0.08 / 0.14 |

- **Crossover:** about 450 rows, so `EXACT_SCAN_MAX_ROWS = 450`. The 8-row user went from 24.15 to 1.11 ms, and the 68-row user from 11.33 to 1.58 ms.
- **Row count:** `count(*)` over `select 1 … where user_id = $1 limit 451`. It's an index-only scan on the btree in every plan measured, at most 0.14 ms at p95, with no counter column to keep in sync.
- **Btree trap caught by tests:** with the btree present, `enable_seqscan = off` alone made the planner read the user's rows through the btree and sort them, about 19x slower for the whole-table user. The HNSW route now also turns off bitmap scans and sorts.
- **The override is still needed above the threshold.** Left alone, the planner gives the whole-table user 41.53 ms against 2.74 ms.
- **The limit:** the crossover was measured on one table size. On larger tables it's probably higher, but that's reasoning, not a measurement.

## 3. Chat
Chat never had the filter bug. It ordered by `1 - distance`, which HNSW can't serve, so it was exact and correct but read all of the user's rows. It now uses `nearestContents`, keeping its limit of 5 and 0.25 cutoff, with tests for a small and a large user.

## 4. Comment and `docs/`
- **Comment:** now reads **~15.1x**: one user owning all 5,183 rows, 300 queries × 3 warm passes, 2.74 ms against 41.57 ms.
- **`docs/`:** committed unchanged. `docs/explain/compare.html` and the PNG headline 63.8×, which holds only for their one-query, one-user setup.

## Deploy order given
1. **Check pgvector:** confirm production's pgvector is 0.8 or newer. **Done 2026-11-17:** production reports **0.8.6**, checked by the owner. I don't connect to production.
2. **Deploy the code.** Done, per the owner.
3. **Then apply the index:** run `drizzle/0003_contents_user_id_index.sql`. If the index lands while the old code runs, HNSW stops being used and large users get about 19x slower.

## Other
- **Train embeddings:** 807 calls, 15,637 tokens, about $0.0003 at list price.
- **Tests:** 179 passing, 62 `bun test` and 117 Vitest.
