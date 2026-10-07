# Responses and connector milestone

The live default is OpenAI Responses. Asmo retains its own durable tasks, scoped context, exact approvals, spending reservations, and effect recovery. GitHub App and Notion public OAuth connections now replace manual end-user credential instructions. SQLite remains the only product database.

## Observed verification

On October 7, 2026, all 123 tests passed across eight files. Both strict TypeScript checks and both production builds exited successfully. The suite uses temporary SQLite files, synthetic Telegram identities, mocked model/provider HTTP responses, and synthetic issue ledgers. No paid model call, real OAuth account connection, Telegram delivery, or external issue creation occurred.

Evidence: [tests](../../work/evidence/responses-connectors-tests.txt), [server check](../../work/evidence/responses-connectors-server-check.txt), [web check](../../work/evidence/responses-connectors-web-check.txt), [server build](../../work/evidence/responses-connectors-server-build.txt), and [web build](../../work/evidence/responses-connectors-web-build.txt).

The fresh compiled fixture demo completed a task with both synthetic issue-read and issue-create effects succeeded. [Demo evidence](../../work/evidence/responses-connectors-demo.txt). This is simulated and creates no real GitHub issue.

Actual browser inspection confirmed Configure → Tools and access for a member and manager. Members see the catalog; managers see Connect controls. Fixture mode disables external authorization and reports missing operator configuration. MCP and plugins display Planned. The persisted synthetic issue result remains visible. [Screenshot](../../work/ui/connector-catalog.jpg) records the current SQLite UI. Earlier browser reports describe the historical PostgreSQL build.

## Provider behavior

[src/providers/responses.ts](../../src/providers/responses.ts) makes stateless Responses requests with fixed provider endpoints and explicit credentials. OpenAI uses store:false, encrypted reasoning replay, strict function schemas, and parallel_tool_calls:false. SDK retries are disabled; Asmo owns retry decisions. Refused, incomplete, malformed, or parallel-tool responses cannot dispatch effects.

DeepSeek has a separate native Responses profile. It omits unsupported store/include fields and rejects parallel calls locally because DeepSeek ignores the serial-tool flag. Provider continuation state is bound to provider, endpoint, and model; foreign state is rebuilt from canonical transcript content. GLM is disabled until native Responses support is verified. OpenAI Agents API and the in-process Agents SDK are deferred because either would add another loop/state owner; the SDK's model adapters do not establish third-party support in the hosted API.

Cached input tokens are priced separately. Output totals already include reasoning tokens and are charged once. Operators supply a model ID and all three current prices. Startup enforces the request reservation and 4096 output-token ceiling. No model quality benchmark has run.

## Connector behavior

The operator registers Asmo's GitHub App or Notion public connection once. End users use Connect → authorize → choose access → return. GitHub installation is followed by user OAuth/PKCE proof; installation_id alone grants nothing. Minted tokens are limited to the repository intersection proved by that user. GitHub issue writes still require exact current manager approval. OAuth repository grants are bounded to at most 500 repositories.

Notion searches page titles and reads up to 100 direct page blocks. Notion's OAuth page picker bounds the provider-visible corpus. Nested blocks, attachments, linked pages, and additional search pages are excluded and disclosed. In shared Telegram scopes, members can use all pages selected for that connection. This is a typed shared Notion corpus grant, not an app-side per-page allowlist. Private connections remain owner-bound with no broader fallback.

Credentials are AES-256-GCM encrypted in SQLite. Runtime integration SQL shares the task store's per-file transaction gate; external HTTP occurs outside transactions. The vault key is separate from the database and must be retained for restore. Read-only views exclude tokens and operator secrets. OAuth states are random, hashed, expiring, one-use, and bound to actor/provider/scope. Current manager authority is checked before authorization and persistence. Selected connection identity and credential version bind every queued effect.

GitHub tokens refresh before expiration. Notion refresh rotates access/refresh tokens atomically after an unauthorized read, with one bounded retry. Disconnect invalidates pending authorization, erases local credential ciphertext, and fences grants. Reconnecting invalidates old exact approvals. Read recovery performs no remote fetch until the store has rechecked current access. Revoking a grant during an in-flight read suppresses returned content and page links before source/history persistence.

Evidence removal replaces affected transcript rows with text markers and drops every tool pair and native continuation item. A regression resumes an actual mocked Responses turn after invalidating tool-derived reasoning state. Internal exact write records remain restricted to recovery, and already-created provider copies remain external.

## Remaining connected and release work

The real end-to-end pilot is still unrun. It requires the user's Telegram bot, an OpenAI project key, a chosen model/current prices/spend allowance, HTTPS ingress, the Mini App link, and registered provider apps. [Operator guide](ai-provider-and-keys.md) explains each key and where to obtain it. [First pilot](first-live-pilot.md) gives the bounded issue workflow. Account linking needs the Mini App; tasks and exact approval can remain in Telegram.

Run one active application/connector worker process. Token-refresh coalescing is in-process; multiple active processes need database-level refresh coordination. Shared connections currently depend on the setup manager retaining Asmo authority. Disconnect does not uninstall the provider app; the user can revoke it in provider settings. Provider revocation webhooks are not implemented. Live worker membership checks, token-revocation races, real billing, mobile callback handoff, backup/restore, data expiry, passive-ingestion flood/retention limits, and approval-message truncation remain release work. A provider request already sent cannot be recalled. This milestone does not pass full local/connected/expanded/release gates.

Custom MCP execution, downloadable plugins, sandboxed code work, and draft PRs are planned catalog entries, not enabled tools. The current typed catalog provides the extension point without pretending those integrations work.

## Design and review

Model the Domain led to separate provider profiles, typed GitHub repository/Notion corpus grants, and connection-version identity on effects. Boundary Discipline kept model credentials and connector credentials out of UI/tool evidence and separated operator app setup from user OAuth. Prove It Works required mocked protocol checks, real SQLite races, signed HTTP callback tests, and browser inspection instead of a live-success claim.

A separate gpt-6-luna architecture reviewer checked provider portability and implementation boundaries. Accepted findings include nonempty bounded Notion search, read-only retry recovery, source-invalidation continuation removal, and late-read suppression after grant revocation. See the [review record](../../work/responses-connectors-review.md) and [decision trail](../../work/decisions.tsv). This finite review does not certify production safety or full Claude Tag parity.
