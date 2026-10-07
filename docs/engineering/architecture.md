# Selected architecture

The user selected SQLite for the current build on October 6, 2026. The earlier PostgreSQL selection below is historical and superseded. The user selected OpenAI Responses on October 7. Asmo retains its local task/tool/approval loop. DeepSeek uses a separate capability profile; GLM Responses remains unverified and disabled. GitHub App and Notion OAuth connections use an encrypted SQLite vault and exact connection/version-bound grants. See [the current milestone](responses-connectors-report.md).

Two independent candidates compared an explicit SQLite-only port against a shared SQL dialect or dual-backend design. The selected port preserves one task lifecycle and the `Store` contract. SQL and persistence primitives are replaced directly. There is no generic PostgreSQL SQL translator and no automatic conversion of existing fixture records.

Native `node:sqlite` owns local storage. The verified development runtime is Node 22.22.0 with SQLite 3.50.4. Use foreign keys, full synchronization, a busy timeout, and short `BEGIN IMMEDIATE` transactions. A process-wide file gate serializes complete async transactions across Store instances. External provider calls happen outside database transactions.

The embedded SQLite version is affected by a documented WAL-reset race. This build uses rollback journaling. WAL requires a verified patched engine before reconsideration. SQLite documents fixes in 3.51.3 and later, with backports including 3.50.7 and 3.44.6. [SQLite advisory](https://www.sqlite.org/wal.html#walresetbug).

SQLite has no row-level security or separate runtime database role. Each tenant operation carries an explicit workspace ID through its reads and writes. Membership, scope, DM ownership, grants, exact approvals, and composite foreign keys remain required. Global discovery returns location identities before entering scoped operations. Direct filesystem access can bypass application controls.

Tests use owned temporary SQLite files by default. They must preserve restart, competing claims, budget reservations, workspace isolation, exact approvals, dependency invalidation, and process-death recovery. One local passing suite does not establish connected Telegram, model, or GitHub behavior.

Model the Domain preserves separate task and effect states. Exhaust the Design Space led to two storage sketches before the port. Prove It Works requires actual SQLite lifecycle and recovery checks. See [provider choices and credentials](ai-provider-and-keys.md) for the discussion of model APIs and managed runtimes.

## Historical PostgreSQL selection

Use one TypeScript application and PostgreSQL 17 as the product database. Use application-owned, bounded Anthropic Messages API turns. Tasks own durable transcripts, scoped evidence, ordered instructions, approvals, budget reservations, effects, and delivery records. Telegram and the Mini App are adapters to the same task operations.

The lead read both complete candidate packages. The independent judge selected the PostgreSQL candidate at 26/30 against 21/30 for Convex. The lead's scores were 28/30 and 24/30. Both favor the same base. Scores assess proposals, not tested implementation. [Judge report](../../work/judge/report.md) records criterion-level reasoning.

The deciding differences are explicit dispatch fencing, stale-steering invalidation, preservation of late effect receipts, database constraints, and a ready local PostgreSQL test environment. Convex fits the user's preferences and remains a sound alternative. Its scheduling and workflow journal would reduce platform work, but external effects would still need the same application-owned authorization and recovery records. Do not add a second product database.

Adopt three strengths from the AI candidate. Preserve complete assistant content and matching tool-result blocks before another model turn. Review provider retention independently from Asmo retention. Keep personal connector work in a private owner-controlled branch before reviewed group sharing. These rules belong in the initial data model, even where expanded features are not enabled yet.

Reject a thin backend that delegates permission decisions to a managed agent session. Managed runtime custom tools still require application authorization. Do not add Temporal before the bounded worker model fails a concrete requirement. Do not claim that a local directory is an isolated coding sandbox.

The first verifiable unit is durable intake, authorization, routing, and Stop. The second adds the model and issue tool loop. The third proves approvals, ambiguous effects, budgets, and restart. Memory, text artifacts, routines, and authenticated UI follow the same boundaries. Test against a disposable PostgreSQL database, never the user's existing services.

The public contracts live in `src/core.ts`. The lead owns contracts, composition, transport, CLI, and package files. The backend worker owns `src/store/` and its focused database checks. The AI worker owns `src/providers/` and `src/connectors/`. The UI worker owns `web/` after the contract is issued. A separate reviewer checks behavior, comments, and the decision trail after implementation.

Model the Domain gives task and effect states separate representations. Make Operations Idempotent gives updates, commands, scheduled occurrences, and tool effects stable identities. Separate Before Serializing Shared State gives workers different files and tasks different transcripts. Boundary Discipline keeps external wire formats outside product operations. Redesign From First Principles puts private connector branches and provider message preservation into the core rather than adding an incompatible later path.

No live Telegram, model, or GitHub call has been tested at this selection point. Actual database roles, Stop/revoke races, current delivery authorization, lost receipts, and complete Messages tool history are implementation proof gates.
