# Phase 7: Resume audit

**The ask:** on `main`, with no code changes, check every number and technical claim in the four Recall resume bullets against the merged code and recorded results. Then give:
- **(A)** a claim table
- **(B)** strong true numbers the resume doesn't use
- **(C)** at most 4 rewritten bullets, every number traceable, not rounded in the resume's favour

**Checked at:** `9cec078`, which has the same tree as the PR's last commit. Nothing new needed measuring.

> **Note:** PR #4 later deleted `recall-backend/bench/`. The `bench/…` sources below now exist only in history, e.g. `git show 9cec078:recall-backend/bench/results/75e6473/report.md`.

## Original bullets
1. "Moved link ingestion off the request path: BullMQ workers fetch each saved URL, summarize it with the Claude API, and embed it into pgvector."
2. "Built hybrid search in SQL: pgvector HNSW plus weighted tsvector full-text search on a GIN index, merged with reciprocal rank fusion. Replacing ILIKE with the GIN-indexed search cut hybrid end-to-end p50 latency from 28.4 to 7.9 ms at 10k rows."
3. "Benchmarked query plans at 1k–50k rows (synthetic 1536-dim vectors): EXPLAIN ANALYZE showed Postgres skipping HNSW for a seq scan at 10k rows; a transaction-scoped SET LOCAL enable_seqscan = off cut vector latency from 74.9 to 3.7 ms. The override is now a safeguard, since the planner picks HNSW on its own."
4. "Streamed RAG chat answers over SSE, grounded in saved links, with citations."

## A) Claim check

### Bullet 1: ingestion
| Claim | Status | Current number and conditions | Source |
|---|---|---|---|
| "Moved ingestion off the request path" | **No recorded source** for "moved" | The queue has existed since the initial commit (2026-05-29); nothing was moved. Summarizing and embedding do run off the request path. | `git log -S contentQueue.add` |
| "Workers fetch each saved URL" | **False** | `POST /content` fetches the URL during the request (`await fetchMetadata`) before queuing. The worker fetches only YouTube transcripts and GitHub READMEs. | `index.ts` (`POST /content`), `services/textExtractor.ts` |
| "Summarize with the Claude API" | Still true | `claude-haiku-4-5-20251001` | `services/aiProcessor.ts` |
| "Embed into pgvector" | Still true | OpenAI `text-embedding-3-small`, 1536 dimensions | `services/embeddings.ts`, `db/schema.ts` |

### Bullet 2: hybrid search
| Claim | Status | Current number and conditions | Source |
|---|---|---|---|
| pgvector HNSW | Stale: system changed | HNSW (m=16, ef_construction=64) only for users with more than 450 rows; smaller users get an exact scan | `services/searchService.ts` |
| Weighted tsvector on GIN | Still true | Weights A/B/C/D over title, og_title, summary, og_description; terms now ORed | `db/schema.ts`, `drizzle/0002…` |
| Merged with RRF | Stale: system changed | Weighted RRF: FTS weight 0.3, k=3, tuned on train | `eval/RESULTS.md` |
| "In SQL" | **False** | Both arms are SQL; the fusion runs in TypeScript | `reciprocalRankFusion()` |
| p50 28.4 → 7.9 ms at 10k rows | True as recorded; system has changed since | Commits `7943212` → `75e6473`: 10k synthetic random 1536-dim vectors, 1 user, warm, 3×200 queries, local Docker Postgres 18 on M1 Pro. **Excludes the OpenAI embedding call**, so "end-to-end" overstates it. The closest current figure is hybrid warm p50 8.20 ms on 5,183 SciFact documents. | `bench/results/75e6473/` (history), `eval/RESULTS.md` |

### Bullet 3: query-plan benchmark
| Claim | Status | Current number and conditions | Source |
|---|---|---|---|
| 1k–50k synthetic 1536-dim rows | Still true | Scales 1k, 10k, 50k at commit `75e6473` | `bench/results/75e6473/report.md` (history) |
| "EXPLAIN ANALYZE showed a seq scan at 10k" | **Weak source** | ILIKE-era run `7943212`: the default planner returned exact results (recall@10 1.000) at p50 77.4 ms, about the forced seq scan's 76.3 ms, but no plan was saved. `docs/explain` has a 10k seq-scan EXPLAIN ANALYZE (75.1 ms) that doesn't record whether the planner chose it. | `bench/results/7943212-ilike-baseline/raw/scale10000.json` (history), `docs/explain/` |
| "SET LOCAL cut vector latency 74.9 → 3.7 ms" | **Misattributed** | At `75e6473`, 74.9 ms is a *forced* seq scan, and the planner already chose HNSW unaided (2.8 ms). The run where the override mattered is `7943212`: **77.4 → 3.9 ms p50**. Both had **21.5% recall@10** at 10k synthetic. | Raw files for both commits (history) |
| "Override is now a safeguard; planner picks HNSW on its own" | **False now** | Without the override, the planner skips HNSW: 41.53 ms against 2.74 ms for a user owning all 5,183 rows. With the btree present, three planner settings are needed to get HNSW. | `eval/RESULTS.md` (round 2) |

### Bullet 4: chat
| Claim | Status | Current number and conditions | Source |
|---|---|---|---|
| Streamed over SSE | Still true | `text/event-stream`, streaming `claude-sonnet-4-6` | `index.ts` chat route |
| Grounded in saved links | Still true | Top 5 above 0.25 similarity via `nearestContents`, plus a selected card; falls back to the 5 most recent items | `index.ts` chat route |
| With citations | True, with a caveat | The source list is sent first and the model is told to cite `[n]`; the citations aren't checked against the answer | `index.ts` chat route |

**Report mismatch:** the `75e6473` report's text says the ILIKE-era default planner ran at "72.2 ms p50", but the raw samples give **77.4 ms** (nearest-rank, n=600). Don't quote 72.2.

## B) Strong true numbers the resume doesn't use
From `eval/RESULTS.md`: local laptop, 5,183 SciFact documents with real embeddings, 300 test queries, warm p50 over 3 passes.

| Result | Number and conditions |
|---|---|
| Multi-tenant recall fix | User owning 68 of 5,183 rows: **14.18% → 100.00%** of the exact top 10. User owning 1,041 rows: **75.04% → 98.42%**. |
| Routing by user size | Crossover about 450 rows. 8-row user **24.15 → 1.11 ms**, 68-row user **11.33 → 1.58 ms**. Routing count at most **0.14 ms** at p95. |
| HNSW vs seq scan, current code | **15.1x** for a user owning all 5,183 rows: 2.74 vs 41.57 ms. At 450 rows or fewer, exact is as fast or faster. |
| FTS fix | No-result queries **285 → 2 of 300**; FTS nDCG@10 **0.0420 → 0.4583** |
| Hybrid quality (careful) | Hybrid nDCG@10 **0.7192** against vector only **0.7201**, a statistical tie. Can't claim hybrid beats vector. |
| Ingestion at scale | **5,183 of 5,183** documents through real BullMQ, Haiku and embeddings, **0 failed jobs**, 897.2 s at concurrency 12 |
| Failed-embedding retry | A failure now marks the row `failed` and retries, reusing the summary; tested with real BullMQ on local Redis. No metric. |
| Share-link leak | An endpoint needing no login returned user IDs, page text and embeddings; now a 13-field allowlist. First on `main` in PR #2 (`784e850`, 2026-10-06); PR #3 fixed it independently. |
| Tests | **217 passing**: 100 `bun test`, 117 Vitest + Supertest, including real Postgres, pgvector and BullMQ. Run at `b4db6d9`, which has the same tree as `9cec078`. |

## C) Rewritten bullets
1. "Built async ingestion with BullMQ: workers summarize saved links with Claude Haiku and embed them into pgvector. Failed embeddings now retry instead of being saved silently (5,183/5,183 docs, 0 failed jobs, local)."
2. "Built hybrid search (pgvector HNSW + weighted GIN full-text, weighted RRF) and a BEIR SciFact eval (5.2k docs, 300 queries). Fixed FTS returning nothing for 285/300 queries, lifting its nDCG@10 from 0.042 to 0.458."
3. "Fixed HNSW filtering that hid small users' results (top-10 recall 14.18% → 100.00% for a 68-row user) with pgvector iterative scan, plus exact-scan routing below 450 rows (p50 11.33 → 1.58 ms, local, 5.2k rows)."
4. "Streamed RAG chat over SSE with source citations; closed a public share-link leak of user IDs, page text and embeddings; added 217 tests (Vitest, Supertest, bun test) against real Postgres and pgvector."

The 28.4 → 7.9 ms and 74.9 → 3.7 ms numbers are left out. Both came from synthetic vectors at 21.5% recall@10 and describe code that has since changed. For one seq-scan figure, use **15.1x** from (B).

> **Test count is now 219.** PR #4 added two tests after this audit. On `main` at `c1161f7`, `bun run test` gives **219 passing: 100 `bun test` + 119 Vitest** (measured 2026-11-17, local Postgres and Redis). Use 219 in bullet 4.
