# Phase 4: Fixes, before/after eval, PR #3

**The ask, in order:**
1. **Share link:** fix the leak, with a regression test, as a separate commit.
2. **Failed embeddings:** mark them failed and make them retryable, with a test, as a separate commit.
3. **Ingest and "before" eval:** dry-run 100 documents and project the full cost, then run the full ingest and the eval on the search code as it was.
4. **Search fixes:** fix the HNSW user filter and skipped rows with pgvector 0.8 iterative scan, keeping the planner override only if it's still needed. Fix FTS so one unmatched term doesn't empty the results.
5. **"After" eval:** rerun and re-measure seq scan against HNSW with correct results.
6. **PR:** push, open PR #3 against `main`, and leave the status-code and account-discovery bugs as follow-ups.

## Commits
| Commit | Change |
|---|---|
| `d3c314e` | Share link returns only the fields the share page renders |
| `f838c85` | Failed embeddings mark the row `failed` and the job retries |
| `e76d974`, `ec53f1c` | Eval harness and before results |
| `4dbbd83` | HNSW filtering no longer hides a user's own results |
| `16d8f23` | One unmatched term no longer empties FTS results |
| `33283cf` | After results |

## Fixes
- **Share link:**
  - **Fix:** an allowlist of 13 public fields; `userId`, `extractedText` and embeddings never leave.
  - **Test:** `test/share.test.ts` checks the exact key list.
  - **Duplication:** the same fix also landed on `main` separately in PR #2 (`784e850`).
- **Failed embeddings:**
  - **Fix:** a `null` embedding marks the row `failed` and throws, so BullMQ retries the job. A retry reuses the stored summary.
  - **Test:** `test-vitest/queue.vitest.ts` runs a real BullMQ worker on local Redis.
  - **Recovery:** `scripts/backfill-embeddings.ts` recovers rows after retries run out.
- **HNSW filtering:**
  - **Iterative scan:** `hnsw.iterative_scan = relaxed_order`. At about the same latency, `strict_order` returned fewer correct rows: 98.22% against 99.96% of the exact top 10 for the 68-row user.
  - **Exact fallback:** iterative scan alone couldn't reach rows with no incoming graph links. One full walk reached 5,127 to 5,179 of 5,183 rows depending on the query (`eval/hnsw-reachability.ts`). If fewer than 10 rows come back, the search reruns as an exact scan. A missed row can still stay missed when 10 do come back.
  - **Planner override kept:** without it, the planner chose a seq scan for all four test users even with iterative scan on.
- **FTS:** plain OR, with implicit ANDs rewritten to OR. On the 809-query train split, it matched the best variant to within 0.001 and needs one query instead of two. Quoted phrases and an explicit `or` still work, and a query with a `-negation` keeps AND.

## Results
5,183 documents, 300 test queries, k=10, from `eval/RESULTS.md`. Quality is from the last timed pass, and latency is warm p50 / p95 over 2 pooled passes.

| Mode | nDCG@10 before → after | Recall@10 before → after | MRR@10 before → after | No results before → after | Warm p50 / p95 before (ms) | Warm p50 / p95 after (ms) |
|---|---|---|---|---|---|---|
| FTS only | 0.0420 → 0.4583 | 0.0417 → 0.5683 | 0.0433 → 0.4328 | 285 → 2 of 300 | 0.35 / 0.48 | 5.35 / 9.56 |
| Vector only | 0.7201 → 0.7201 | 0.8549 → 0.8549 | 0.6856 → 0.6856 | 0 → 0 | 2.69 / 3.24 | 2.65 / 3.40 |
| Hybrid | 0.7209 → **0.6742** | 0.8549 → 0.8423 | 0.6866 → 0.6298 | 0 → 0 | 2.81 / 3.32 | 8.38 / 13.96 |

**Something looked off: hybrid got worse.** Against vector only it was better on 38 queries and worse on 89. The likely cause is equal-weight RRF letting weaker FTS rows push out good vector rows, but that wasn't tested separately here. Phase 5 addressed it.

## Seq scan against HNSW, with correct results
Warm p50, 300 queries × 3 passes, round 1 commit `16d8f23`:

| User owns | Seq scan | Production path | Ratio | Exact top 10 returned, before → after |
|---|---|---|---|---|
| All 5,183 rows | 44.60 ms | 2.65 ms | HNSW 16.8x faster | 99.43% → 99.43% |
| 1,041 rows | 9.16 ms | 3.41 ms | HNSW 2.7x faster | 75.04% → 98.42% |
| 68 rows | 1.55 ms | 11.33 ms | HNSW 7.3x slower | 14.18% → 99.96% |
| 8 rows | 1.04 ms | 24.15 ms | HNSW 23.2x slower | not measured → 100.00% |

The earlier "~64x" figure fits only a user who owns nearly the whole table.

## Cost
Calculated from token counts and list prices, not taken from a bill.

| | Haiku input | Haiku output | Embedding | Cost |
|---|---|---|---|---|
| Dry run, 100 documents | 60,215 | 10,950 | 39,459 | $0.12 |
| Projection, 5,183 documents | 3,120,943 | 567,539 | 2,045,160 | $6.00 |
| Actual, 5,183 documents + 300 queries | 3,118,121 | 569,130 | 2,017,337 | $6.00 |

Full run: 5,183 of 5,183 done, 0 failed jobs, 897.2 s at concurrency 12.

## Corrections
- **Commit with failing tests:** one script committed the vector fix while tests were failing. I amended it before pushing, so that state never reached the PR.
- **Untested at scale:** about 5,000 rows can't trigger `hnsw.max_scan_tuples` (default 20,000), so larger tables are unmeasured.

## Follow-ups listed in the PR, not fixed
- **Status codes:** duplicate email 500, sign-in with no password 500, malformed `contentId` 500, `?q=a&q=b` 500.
- **Account discovery:** 403 for an unknown user against 401 for a wrong password.
- **FTS coverage:** FTS doesn't search `extracted_text`, and stopword-only queries return arbitrary rows.
- **Chat:** the chat route had its own vector query. Phase 5 fixed this.
- **Pre-deploy check:** production's pgvector version (needs 0.8 or newer) wasn't checked here, because I don't connect to production. The owner checked it on 2026-11-17: **0.8.6**.

**Tests:** 163 passing, 62 `bun test` and 101 Vitest.
