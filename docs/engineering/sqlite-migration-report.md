# SQLite implementation evidence

The lead independently ran the final 80-test suite, the backend strict check and build after the shutdown fix. Both browser checks and builds also passed during this migration; no browser source changed afterward. Saved evidence is in `work/evidence/sqlite-tests.txt`, `sqlite-server-check.txt`, `sqlite-server-build.txt`, `sqlite-web-check.txt`, and `sqlite-web-build.txt`.

The owned local preview restarted on SQLite at `http://127.0.0.1:8787/?fixture=1`. The lead ran the compiled fixture demo and inspected the actual HTTP view afterward. It returned one completed task, five citations, successful synthetic read/write receipts, and zero held usage. The pilot file initialized separately. Both new database files and `.env.live` have owner-only permissions. The previous disposable PostgreSQL daemon was stopped; its data directory remains in place and was not imported.

The independent gpt-6-luna reviewer found a shutdown cleanup bug. `close()` now closes the handle in `finally` when a lock prevents its queued transaction. A real-lock test verifies the failure and closed handle. The reviewer found no remaining storage correctness blocker by inspection. Stale database-role and daemon instructions were removed from README. Concurrent-process writer contention has not been directly tested; the two-connection tests exercise the in-process gate, and the SIGKILL test exercises process-death recovery.

SQLite is the only storage backend. `StoreOptions.databasePath` replaces `databaseUrl`; `ASMO_DATABASE_PATH` defaults to `work/asmo-fixture.sqlite` in fixture mode and `work/asmo-pilot.sqlite` in live mode. Legacy-only database URL configuration fails explicitly. Provider configuration and provider behavior are unchanged.

The native `node:sqlite` connection binds prepared parameters, decodes JSON and integer flags, and exposes a typed workspace transaction context. SQL is written directly for SQLite. There is no SQL translation layer. All tenant reads and updates explicitly bind workspace IDs. Global discovery returns only identifiers. Composite foreign keys preserve workspace and scope ownership. Schema version 1 initializes automatically; repeated migration is idempotent; future versions are rejected.

The gate uses the real database file path and serializes complete async transactions across Store connections in one process. `BEGIN IMMEDIATE` reserves the write lock before claim selection. Job selection, lease tokens, attempts, model scope limits, authority checks and budget reservations commit atomically. Other processes use SQLite locking with a five-second busy timeout. No external call occurs inside a database transaction.

Connections use `journal_mode=DELETE`, `synchronous=FULL`, and `foreign_keys=ON`. WAL is deliberately disabled because the verified local Node 22.22.0 runtime embeds SQLite 3.50.4, affected by SQLite's published WAL-reset corruption race. New database files are created with mode 0600. Existing file permissions are preserved. Node's SQLite module still prints its experimental warning. The package engine now requires Node >=22.22.

Validation completed on Node v22.22.0:

- `./node_modules/.bin/tsc --noEmit`: passed.
- `./node_modules/.bin/tsc -p tsconfig.build.json`: passed.
- `./node_modules/.bin/tsc -p web/tsconfig.json`: passed.
- `./node_modules/.bin/vite build --config web/vite.config.ts`: passed, 112 modules transformed.
- `./node_modules/.bin/vitest run`: 6 files passed, 80 tests passed, no skips. Final shutdown-fix run took 4.27 seconds.
- `npm exec --yes --package=pnpm@12.9.1 -- pnpm install --lockfile-only`: passed. PostgreSQL dependencies and types removed from manifest and lockfile.
- `node --import tsx scripts/local-db.ts stop`: passed and reported SQLite has no daemon.

All original 73 behavior tests remain active against temporary SQLite files. New tests cover two connections claiming distinct jobs from the same file, two-model scope capacity, shared budget reservation without overspend, duplicate task/source/job/reservation IDs across workspaces, composite foreign-key rejection, transaction rollback, migration idempotency, private file mode, future-schema data retention, legacy configuration rejection and handle cleanup when shutdown encounters an actual SQLite write lock. The real child-process SIGKILL test preserves its external receipt ledger and proves recovery after provider application and before database receipt.

Limits: local SQLite serializes writers. Multi-process high-throughput performance and filesystem failure simulation were not measured. Existing PostgreSQL data was not read, altered or imported. No provider API, live service, credential file, deployment or commit was used. Root owns documentation review, final independent checks and the local preview restart.

Independent review fix: `SQLiteStore.close()` now closes its handle in `finally` even if `BEGIN IMMEDIATE` fails during shutdown. The focused test uses a one-millisecond busy timeout on the owned connection and a second real write transaction. It checks both the lock error and the closed database handle. Strict TypeScript, backend build and the full 80-test suite pass after the fix.
