# Phase 0: Recon

**The ask:** read the repo and report the retrieval path (vector, FTS, hybrid fusion), the embedding provider, model and dimensions, the ingestion flow, and the existing tests. No code changes.

This describes the code **as it was before any of this work**. Later phases changed most of it.

| Area | What the code did |
|---|---|
| **Vector arm** | `hybridSearch` in `services/searchService.ts` ran `ORDER BY embedding <=> $vec LIMIT 10` in a transaction with `SET LOCAL enable_seqscan = off`, the HNSW planner override. A `similarity > 0.3` filter was applied afterwards in JS. Index: HNSW, `m=16`, `ef_construction=64`, default `ef_search` 40. |
| **FTS arm** | `websearch_to_tsquery('english', q)` against a generated `search_vector`: title A, og_title B, summary C, og_description D. Ranked by `ts_rank`, `LIMIT 10`. `extracted_text` was not indexed, and an empty tsquery returned arbitrary rows. |
| **Fusion** | RRF in application code, scoring `1/(idx+60)` with a 0-based `idx`, so not the textbook `rank+60`. Top 10 kept. |
| **Embeddings** | OpenAI `text-embedding-3-small`, 1536 dimensions, one input per call. Returned `null` on any failure. |
| **Ingestion** | `POST /content` fetches metadata, inserts the row and adds a BullMQ job. The worker's `processContent` runs `extractText`, then Claude Haiku for summary and tags, then embeds `title + summary + text[:2000]`. |
| **Chat** | Didn't use `hybridSearch`. It had its own vector-only query with a 0.25 cutoff, ordered by `desc(similarity)`. |
| **Existing tests** | 62 `bun test` tests on PGlite, all passing. No Vitest, Supertest or real-Postgres tests. |

## What shaped the next phases
- **No search modes:** `hybridSearch` had no vector-only or FTS-only mode. The eval needed an optional `mode` argument that keeps the default behaviour.
- **Production credentials risk:** Bun auto-loads `.env`, and `worker.ts` imports `dotenv/config`, so any script could pick up the real `DATABASE_URL` and `REDIS_URL`. Tests and eval use their own `TEST_*` and `EVAL_*` variables, restricted to loopback.
- **Likely weak FTS:** `websearch_to_tsquery` ANDs every term, and SciFact queries are long sentences, so FTS might match very little. Phase 4 measured it at 285 of 300 test queries returning nothing.
