# Phase 6: Merge conflict with `main`

**The ask:**
- **Merge, don't rebase:** fetch and merge `origin/main` into `eval-and-tests`, with no force-push.
- **Keep both sides' intent:** don't change behaviour beyond resolving the conflict.
- **Test, then push:** run the full suite, push, and report.

**Result:** merge commit `b4db6d9`, with no rebase or force-push. GitHub showed PR #3 as `MERGEABLE` / `CLEAN`, and it was later merged as `9cec078`. **217 tests pass**: 100 `bun test` and 117 Vitest.

## Conflicted file: `recall-backend/index.ts`
Our branch had moved the routes inside `createApp()`, while `main` edited them in their old positions. I kept our structure and moved `main`'s changes into it.

| Region | Our side | `main`'s side | Resolution |
|---|---|---|---|
| Public share route | Route inside `createApp()` with an inline field allowlist | Old-position route using the new `sharedContentColumns` | Kept our route and used `main`'s `sharedContentColumns`. Both list the same 13 fields. |
| Search route and start of chat | `hybridSearch(db, …)` and `nearestContents` for chat | Old `hybridSearch(userId, …)`, plus `message` must be a string of at most 4,000 characters | Kept our search code and added `main`'s two checks |
| Chat history | Context block plus the old history loop | Last 20 entries, non-string content skipped, a leading assistant message dropped, each entry capped at 8,000 characters | Kept our context block and used `main`'s loop, adding one closing brace the conflict region was missing |

## Merged without conflict
- **Added from `main`:** `services/urlGuard.ts` and `db/sharedContent.ts`, with their tests
- **Changed by `main`:** the SSRF check in `metadataFetcher.ts` and `maxLength` in `AskAIPanel.tsx`
- **Deleted by `main`:** `Usecontent.tsx` and `SidebarToggle.tsx`

## Test-only changes the merge needed
Six of our existing Bun tests hit `main`'s new SSRF guard. The guard was right, so I changed only test code and the test script:
- **`test/setup.ts`:** fakes DNS, because the guard resolves each host and the made-up test hosts don't exist. `localhost` still resolves to loopback, so `main`'s SSRF test still proves local targets are refused.
- **`test/metadataFetcher.test.ts`:** the expected redirect mode is now `"manual"`, matching `main`.
- **`package.json`:** `test:bun` runs `bun test` instead of `bun test ./test`, which would have skipped `main`'s two new test files.

## Gaps
- **Chat checks untested:** `main`'s new chat limits came through the merge, but no test covers them.
- **Results not rerun:** `RESULTS.md` reflects `124a8c9`, from before the merge. The search code didn't change.
- **pgvector:** unchecked at the time. On 2026-11-17 the owner checked production: **0.8.6**.
