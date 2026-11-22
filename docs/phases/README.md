# Recall: work log by phase

One file per phase of the test-and-eval work. Every number comes from a recorded result in the repo, mostly `recall-backend/eval/RESULTS.md` and `recall-backend/eval/results/*.json`, or from the reports given at the end of each phase.

| # | Phase | Outcome |
|---|---|---|
| 0 | [Recon](00-recon.md) | Mapped retrieval, embeddings, ingestion and tests. No code changed. |
| 1 | [Tests](01-tests.md) | Vitest + Supertest suite and real-Postgres integration tests, commit `e0599e2` |
| 2 | [Eval harness](02-eval-harness.md) | BEIR SciFact harness in `recall-backend/eval/` |
| 3 | [First stop and bug list](03-first-stop-and-bugs.md) | Stopped on an invalid `ANTHROPIC_API_KEY`; listed the bugs found |
| 4 | [Fixes, before/after eval, PR](04-fixes-and-before-after.md) | Share-link leak, failed embeddings, HNSW filtering, FTS. PR #3 opened. |
| 5 | [Weighted RRF and routing](05-weighted-rrf-and-routing.md) | RRF tuned on train, exact scan below 450 rows, chat on shared search |
| 6 | [Merge conflict](06-merge-conflict.md) | Merged `origin/main` into the branch (no force-push); 217 tests pass |
| 7 | [Resume audit](07-resume-audit.md) | Checked the resume's Recall bullets against recorded results |

## Ground rules for the whole project
- **No production access:** never connect to the production database, Redis, Railway or Neon. Everything runs on local Postgres with pgvector and local Redis.
- **No made-up numbers:** never invent or round up a number. Every metric comes from a script in the repo that can be rerun, with its method stated: dataset, k, runs, warm or cold.
- **Missing keys:** if an API key or environment variable is missing, stop and name the exact variable.

## Since these phases
PR #3 was merged as `9cec078`. PR #4 (`c1161f7`) then made these changes on `main`:
- **Benchmark removed:** deleted `recall-backend/bench/`, the synthetic ILIKE-era benchmark. Phase 7 cites files from it, which are now only in git history, e.g. `git show 9cec078:recall-backend/bench/results/75e6473/report.md`.
- **Sign-in follow-ups:** according to its commit titles, it also handled the status-code and account-discovery follow-ups from phase 4: `f6a332d` and `65f3a7f`. I haven't reviewed those changes.
- **Tests:** 219 pass on `main` at `c1161f7`: 100 `bun test` and 119 Vitest.

## Deploy status (2026-11-17)
| Step | Status |
|---|---|
| Production pgvector is 0.8 or newer | **Done:** 0.8.6, checked by the owner |
| Deploy the code | **Done,** per the owner |
| Apply `drizzle/0003_contents_user_id_index.sql` | Pending; must come after the code deploy |
