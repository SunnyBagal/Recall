# Phase 2: Eval harness

**The ask:** a `recall-backend/eval/` harness on BEIR SciFact. It ingests through Recall's real ingestion and embedding path, in batches with embeddings cached to disk. It compares FTS only, vector only and hybrid with Recall's actual query code, scoring nDCG@10, Recall@10 and MRR@10. Latency is p50 and p95 per mode over 3 runs, first run and warm reported separately, including the HNSW planner-override path. Output goes to `eval/RESULTS.md` with commands to reproduce.

**Commits:** harness `e76d974`, before results `ec53f1c`. The harness was first blocked on the Anthropic key (phase 3) and finished in phase 4.

## Dataset
BEIR SciFact: **5,183 documents, 300 test queries, 339 relevance labels**, binary. Downloaded by `eval/download.ts`. Queries that return nothing score 0 and stay in the averages. The 809-query **train** split is used only for tuning (FTS variants, RRF weights), never for test.

## Scripts
| Script | Job | Paid API calls |
|---|---|---|
| `eval/local-services.sh` | Start or stop local Postgres and Redis | No |
| `eval/download.ts` | Fetch SciFact | No |
| `eval/ingest.ts` | Insert rows as pending, send jobs through BullMQ, run the unmodified `processContent` with real Haiku and OpenAI calls, cache to `eval/cache/`. `--limit=100` is a dry run. | Yes, unless cached |
| `eval/run.ts` | Quality and latency for the three modes through `hybridSearch` | No |
| `eval/vector-latency.ts` | Seq scan against HNSW paths, with correctness against exact search | No |
| `eval/fts-variants.ts` | AND / OR / fallback variants on train | No |
| `eval/hnsw-reachability.ts` | How many rows one full index walk reaches | No |
| `eval/embed-train.ts`, `eval/tune-fusion.ts` | Train query embeddings and RRF grid search (phase 5) | embed-train only |
| `eval/report.ts` | Writes `RESULTS.md` from `eval/results/*.json` | No |

## Method
- **Ingestion:** `fetchMetadata` is skipped because the corpus has no URLs, so the title fills title and og_title, and the abstract is `extracted_text`. Worker concurrency 12, 6 attempts; production uses 3 and 3.
- **Search:** every mode calls `hybridSearch` from `services/searchService.ts`. FTS only passes a null embedding, and vector only skips the keyword arm. An optional `mode` argument was added; the default stays the same.
- **Latency:**
  - **Runs:** 3 sequential passes per mode. Postgres restarts and a fresh Bun process starts before each mode.
  - **Reporting:** pass 1 is reported as "first run", and passes 2 and 3 are pooled as "warm". p50 and p95 are nearest-rank, with the connection opened before timing.
  - **Not fully cold:** the macOS file cache survives a Postgres restart, and clearing it needs sudo.
- **Scope:** latency covers the database and fusion only. `/search` also makes one OpenAI embedding call per request, which isn't included.
- **Environment:** Postgres 17.10 (Homebrew), pgvector 0.8.2, shared_buffers 512MB, `hnsw.ef_search` 40, on an Apple M1 Pro with 10 cores and 16 GB, over loopback. It's a laptop, so compare numbers with each other, not with production.

## Reproduce
From `recall-backend/`. The full command list, including phase 5's steps, is under "Reproduce" in `eval/RESULTS.md`.

```bash
eval/local-services.sh start
bun --no-env-file run eval/download.ts
bun run eval/ingest.ts --limit=100   # dry run
bun run eval/ingest.ts               # full ingest, resets the local eval database
bun --no-env-file run eval/run.ts --label=<round>
bun --no-env-file run eval/vector-latency.ts --label=<round>
bun --no-env-file run eval/report.ts
```

`--no-env-file` keeps Bun from loading `.env`. Only `ingest.ts` and `embed-train.ts` need `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
