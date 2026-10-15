# The Cloudflare edge path is experimental

Status recorded 2026-10-15. The Workers gateway and the D1 storage backend stay in the repository and in the test suite. They are not the supported deployment, and new features do not target them.

## What the path contains

- `src/edge/gateway.ts` handles the Telegram webhook, the queue consumer, and the cron trigger on Workers.
- `src/store/d1.ts` is the D1 storage backend, selected through `StoreOptions.d1`.
- `src/edge/r2.ts`, `src/edge/kv.ts`, and `src/edge/vault.ts` hold artifacts, caching, and the connector vault.
- `wrangler.jsonc` binds D1, KV, R2, and the job queue.
- `migrations/` holds the edge migration statements.

## Why it is parked

Three gaps make it unsafe to call supported.

1. D1 cannot roll back a command callback. D1 has no interactive transactions. The D1 branch of `inDatabaseTransaction` in `src/store/connection.ts` serializes callbacks inside one isolate and lets each statement commit on its own, so a failure in the middle of a store callback leaves the earlier statements committed. Local SQLite runs the same callback inside `BEGIN IMMEDIATE` and rolls it back. Approval fencing, the one-write guarantee, and budget reservations were proven under the SQLite behavior.
2. Stop cannot reach a call dispatched by a previous invocation. `Worker.interrupt` in `src/worker.ts` aborts through an in-memory map, and that map ends with the process. Each Workers request gets a fresh isolate, so a model call started by an earlier invocation keeps running.
3. Real D1 behavior is untested. `tests/d1.test.ts` runs against `createMockD1`, which wraps `node:sqlite` in memory. That checks the SQL translation and the store lifecycle, not D1's cross-isolate consistency, statement limits, or batch behavior.

## The supported deployment

One Node process with the SQLite file described in the README. Keep one application and connector worker because OAuth token refresh is not coordinated across processes.

## When to reopen

Reopen the path when the product has real multi-process demand or a measured single-node limit. Treat it as a store redesign, not a port. Each command becomes one conditional statement or one `batch()`, unique constraints and idempotency keys carry the guarantees, and the tests run against real D1 through `wrangler dev`.

## Rule while parked

Do not add features or refactors on this path. Keep it compiling and keep its tests passing. Deletion remains a valid later decision. Parking is cheap and reversible.
