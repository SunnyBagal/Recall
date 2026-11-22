# Phase 3: First stop and bug list

**The ask:** open the PR, then report what was tested, the test count, every bug found (listed, not silently fixed), the results table, and anything that looks off.

## Stopped on a missing credential
Work stopped in phase 2 because **`ANTHROPIC_API_KEY` in `recall-backend/.env` was invalid**: Anthropic returned `401 invalid x-api-key`. The OpenAI key passed. At that point there were no eval numbers, no `RESULTS.md` and no PR.

I didn't work around it. The worker writes each document's summary with Haiku, and the summary is part of the FTS index. Without it, FTS and hybrid would search titles only and the results wouldn't reflect Recall's real path. Once the key was fixed, the PR and results came in phase 4.

## State at the stop
| Item | Status |
|---|---|
| Phase 1 tests | Committed as `e0599e2`, not pushed |
| Tests | 149 passing: 62 `bun test`, 87 Vitest |
| Local services | Postgres 17.10 + pgvector 0.8.2 and Redis working |
| SciFact | Downloaded: 5,183 documents, 300 test queries, 339 labels |
| Eval scripts | `ingest.ts`, `run.ts`, `lib.ts`, `metrics.ts` written but uncommitted; `report.ts` not yet written |

## Bugs found, none fixed at this point
**Most serious**
1. **Search could hide a user's own results.** The vector search filtered by user only after HNSW had picked its 40 candidates. In a test, a user with 5 matching rows got fewer than 5 back when another user had 300 closer rows. Fixed in phase 4.
2. **Public share links leaked private data.** `GET /brain/:hash` needs no login, and it returned `userId`, `extractedText` and raw embeddings. Fixed in phase 4.
3. **Failed embeddings looked successful.** The row was marked `done` with no vector and never retried. Fixed in phase 4.

**Lower severity.** Phase 4 listed these as follow-ups and didn't fix them.
- **Status codes:**
  - A duplicate email returned 500, because the 409 branch was unreachable.
  - Sign-in with no password returned 500.
  - A malformed `contentId` on delete returned 500.
  - `?q=a&q=b` on search returned 500.
- **Account discovery:** an unknown user got 403 but a wrong password got 401, revealing which accounts exist.
- **FTS quality:**
  - Every term had to match, so one unmatched word returned nothing.
  - `extracted_text` wasn't searched.
  - Stopword-only queries returned arbitrary rows.
- **Unreachable HNSW rows:** the HNSW path skipped rows when the graph was badly connected.

## Choices flagged for review
- **Two test runners:** the 62 existing tests use `bun:test`, so I kept them rather than rewriting them in Vitest.
- **Production code change:** `searchService.ts` gained an optional `mode` argument and an exported `reciprocalRankFusion`. Default behaviour didn't change.
- **Not a container:** this ran on the Mac with Homebrew services, not inside a container.
