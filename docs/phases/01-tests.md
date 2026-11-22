# Phase 1: Tests

**The ask:**
- **API tests:** Vitest + Supertest for the HTTP API, covering happy paths, validation errors and auth.
- **Unit tests:** for fusion and ranking, and for the ingestion worker with the embedding call mocked.
- **Integration tests:** against local Postgres, checking vector, FTS and hybrid ordering.
- **Script:** a `test` script, with every test passing.

**Commit:** `e0599e2` "Add Vitest + Supertest suite and real-Postgres integration tests", on branch `eval-and-tests`. It builds on three earlier commits that made the app testable:
- `1999c67`: injection seams for the database, queue and AI clients
- `3cb7d77`: re-indented code moved into `createApp`
- `57d920e`: `bun test` on PGlite

## Layout (`recall-backend/`)
| Path | What it covers |
|---|---|
| `test/*.test.ts` | The 62 existing `bun:test` characterization tests: auth, content, search, share, worker, AI, link detector, metadata fetcher. Kept rather than rewritten. |
| `test-vitest/api.vitest.ts` | Supertest against `createApp()`: happy paths, validation errors, auth |
| `test-vitest/fusion.vitest.ts` | Unit tests for `reciprocalRankFusion` |
| `test-vitest/worker.vitest.ts` | `processContent` with the summarizer and embedding call injected as mocks |
| `test-vitest/integration.vitest.ts` | Real Postgres + pgvector: inserts documents, runs vector, FTS and hybrid queries, checks ordering |
| `test-vitest/metrics.vitest.ts` | Eval metric functions. Added in phase 2. |
| `test-vitest/queue.vitest.ts` | Real BullMQ on local Redis: failed-embedding retry. Added in phase 4. |

New tests are named `*.vitest.ts` so that `bun test` doesn't pick them up. `package.json` has `test` (both runners), `test:bun` and `test:vitest`.

## Safety
- **Pinned environment:** `test-vitest/setup.ts` sets `DATABASE_URL` and `REDIS_URL` to dead loopback addresses and blanks the API keys before any app module loads, so `dotenv` can't bring in the real values.
- **Network guard:** any fetch to a non-loopback address throws unless a test stubs it (`test/helpers/network.ts`).
- **Database check:** `test-vitest/pg.ts` refuses a `TEST_DATABASE_URL` unless the host is loopback and the database name contains `test`. It rebuilds the schema from `db/schema.ts` for each file.
- **Local services:** `eval/local-services.sh start` runs Postgres 17.10 with pgvector 0.8.2 on `127.0.0.1:54329` and Redis on `127.0.0.1:63799`, with data in `recall-backend/eval/.services/`. They ran on the Mac via Homebrew, not in a container.

## Count
At the phase 2 stop: **149 passing**, 62 `bun test` and 87 Vitest. How the count grew later:

| Point | Total | bun test | Vitest |
|---|---|---|---|
| Phase 2 stop | 149 | 62 | 87 |
| Phase 4, PR #3 opened | 163 | 62 | 101 |
| Phase 5 | 179 | 62 | 117 |
| Phase 6, after merging `main` | 217 | 100 | 117 |

## Bugs found by the tests
Tests recording these behaviours are labelled `KNOWN BUG` or `KNOWN LIMITATION`. Phase 3 lists them all.
