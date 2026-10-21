# Decision: third-party plugin runtime and execution boundary

**Status:** Decided (recorded 2026-10-20)  
**Owner:** Architect

## Decision

Asmo ingests third-party skill documentation. It does not execute third-party skill scripts. Execution stays in typed effects with a fixed host allowlist and connection-scoped credentials.

## Rejected option

The Claude Tag plugin runtime model (e.g., `anthropics/claude-tag-plugins`), which bundles bash, curl, and python scripts for local or sandbox shell execution.

Reasons for rejection:

1. **The approval artifact changes from a typed call to a command string.**  
   `effectFingerprint` at [`src/connectors/boundary.ts:24`](src/connectors/boundary.ts#L24) binds an approved write to `effect.hash` and the canonical typed input (`effect.call.name`, `effect.call.input`). Shell script invocation relies on string interpolation, which means the approved bytes and the executed bytes can differ.
2. **Read versus write has no machine-checkable signal.**  
   `SKILL.md` documents service behavior in prose. HTTP methods alone cannot distinguish actions: for example, GraphQL queries (reads) and mutations (writes) both use HTTP `POST`. A shell execution runner cannot structurally enforce that a turn was read-only without parsing arbitrary query strings or scripts.
3. **Credentials move into an untrusted execution environment.**  
   Upstream injects credentials at the network boundary and expects script environment variables to hold dummy placeholders. Passing live tokens in `options.env` exposes secrets to the execution context and contradicts the custody model in [`docs/engineering/connector-design.md:119`](docs/engineering/connector-design.md#L119) ("Credentials go directly from the vault into provider HTTP adapters. They are never tool results, model input, Mini App state, or sandbox environment values").
4. **The execution path is unbuilt and parked.**  
   `EphemeralHttpSandboxConnector` in [`src/edge/sandbox.ts`](src/edge/sandbox.ts) has no production callers, and [`docs/engineering/edge-experimental.md`](docs/engineering/edge-experimental.md) explicitly marks the edge and sandbox path as parked experimental work.

## Invariants for future adapters

Any future connector or plugin adapter must satisfy these invariants:

- **Active scope grant:** An active grant in [`src/store/index.ts:52`](src/store/index.ts#L52) must explicitly permit the exact tool name and target resource for that scope, re-checked at dispatch before execution.
- **Typed input schema:** Parsed and validated with Zod before admission.
- **Exact-body fingerprint:** Approved by an authorized manager via `effectFingerprint` before dispatch.
- **Host allowlist:** Fixed endpoint hosts enforced at the transport layer (e.g., [`src/integrations/http.ts:8`](src/integrations/http.ts#L8)).
- **Connection-bound credential lease:** Tokens decrypted on-demand from the vault, checked against connection ID and credential version, and never exposed to model or execution environments.
- **Durable receipt and reconciliation:** Positive receipt on success, proof of absence or unknown-outcome hold on failure.
- **Untrusted evidence:** Connector responses bounded by time and size (15 s, 2 MB), parsed against a strict schema, and labeled as untrusted evidence in context.

## Gate

M6 generalizes proven connector behavior and must not delay M1. Ship curated workflow packs before arbitrary downloadable or executable connector code.

## Cost unit

Per service: a declarative manifest target and typed schema, not a bespoke TypeScript module or execution script.  
**Yardstick:** [`src/connectors/github.ts`](src/connectors/github.ts) at 232 lines for the current typed effect and reconciliation path.

## Reopen condition

A service requires multi-step shell automation that a declarative manifest cannot express. In that event:
1. Run the task strictly read-only in the isolated sandbox.
2. Inject no credentials into the process environment.
3. Record why the declarative manifest was insufficient before any write capabilities are considered.
