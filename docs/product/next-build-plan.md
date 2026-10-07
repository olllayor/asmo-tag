# Asmo Tag next build plan

Prepared October 7, 2026, Asia/Tashkent.

Status: proposed delivery plan. This document records research, source inspection, and the roadmap discussed with the user. It does not mark future features as implemented or authorize live deployment.

## Product direction

Build a Telegram teammate that carries bounded work through to an outcome. A member tags Asmo, the team steers the task, Asmo gathers permitted evidence, and a person reviews consequential actions. The conversation retains the result, supporting evidence, and follow-up.

Use Asmo Tag as the working product name under Asmo AI. Name, domain, and trademark availability are unverified. Asmo Missions is the proposed name for persistent goals. Asmo Djinn remains an optional character idea, not a naming decision.

The first useful workflow is a Telegram discussion followed by a cited investigation using selected Notion pages and GitHub issues. A manager reviews an exact issue proposal. Asmo creates it once and reports the confirmed result. Later, the same workflow should produce a tested patch, a reviewable PR, and meaningful follow-up.

Match Claude Tag's publicly observable behavior where it helps users. Public documentation cannot establish its private prompts, infrastructure, or evaluation methods. Independent extensions below are proposals for Asmo.

## Decisions already made

| Decision | Consequence |
| --- | --- |
| SQLite is the product database for now. | Keep tasks, grants, approvals, budgets, and recovery state durable in SQLite. Separate execution compute when code jobs need it. |
| OpenAI Responses is the initial model API. | Keep application-owned orchestration, canonical history, authorization, retries, and effect recovery. Do not introduce a second task-state owner without a demonstrated need. |
| Future providers should use Responses where supported. | Use provider profiles and protocol tests. API shape alone does not establish equivalent tools, reasoning state, usage, or cancellation behavior. |
| Nontechnical users should connect tools easily. | Users authorize accounts and select resources. Operators register provider apps and manage service credentials once. |
| Telegram is the main place to work. | Keep requests, steering, progress, approval, Stop, Resume, and results in conversation. Use the Mini App for account linking and detailed administration. |
| Broad ambition is welcome. | Sequence expansion around demonstrated user outcomes. Do not turn the first pilot into an arbitrary plugin runtime or a general autonomous engineering platform. |

The original [research plan](../../telegram-tag-build-plan.md) remains historical context. This plan supersedes its initial Claude-provider assumption and unresolved working name. The [acceptance plan](acceptance-plan.md) remains the release contract. This roadmap does not silently pass or weaken its gates.

## Current evidence and limits

The [Responses and connector report](../engineering/responses-connectors-report.md) records a historical milestone with 123 passing tests, strict checks, production builds, a synthetic workflow, and browser inspection. That verification used mocked external services. It did not establish real Telegram delivery, OAuth handoff, model billing, or GitHub issue creation.

A fresh check during this planning task ran `node node_modules/typescript/bin/tsc --noEmit` and exited with code 1. Current contracts disagree across these areas:

- [Core tool types](../../src/core.ts) declare GitHub tools while callers also use Notion tools.
- `StoreOptions` declares `databaseUrl` while SQLite callers use `databasePath`.
- Transcript callers use `providerState`, which the current core type omits.
- Connector callers use connection identity, credential versions, and grant methods absent from the current core contracts.

The cause of this mismatch is unknown. Reconcile the contracts from intended behavior and existing callers. Do not discard unrelated work or assume an older file is authoritative. Historical green results are not evidence that the current source passes.

Other known limits from the report and inspection:

- The real connected pilot and model-quality evaluation remain unrun.
- Worker execution and delivery need current Telegram membership checks.
- Long approval messages can truncate the proposed content.
- Passive ingestion needs retention and flood limits. Restore and deletion reapplication need proof.
- Connector refresh coordination is in-process. Keep one active application/connector worker until database fencing supports concurrent refresh.
- The connector catalog is display metadata. It is not an executable plugin registry.
- Scheduled routines exist, but event-watch intake and isolated code work remain planned.
- Notion retrieval is bounded. Existing direct-block and search limits must remain visible until expanded retrieval is implemented and verified.

## Milestone sequence

| ID | User outcome | Primary owners | Exit evidence |
| --- | --- | --- | --- |
| M0 | A coherent, reproducible current build. | Lead, backend, AI/runtime, QA. | Current source passes applicable checks, tests, builds, and the synthetic workflow. Evidence identifies the exact source snapshot. |
| M1 | A manager connects a team and completes one real cited issue workflow. | Telegram, backend/connectors, product/UI, ops/QA. | Real mobile setup, OAuth, model usage, exact approval, one external issue, and confirmed Telegram result. Related failure cases have separate evidence. |
| M2 | Asmo investigates a bug and proposes a tested code change. | Runtime/sandbox, GitHub/backend, QA. | Seeded bug reproduction, isolated execution, actual test results, exact patch review, and a reconciled PR result. |
| M3 | The team gets useful catch-up and quiet event watches. | Backend/events, AI/retrieval, Telegram/QA. | Cited briefings, deduplicated events, permission-aware subscriptions, and no repeated unchanged notices. |
| M4 | Decisions and commitments remain useful across tasks. | Product, memory/backend, AI/QA. | Evidence-backed records, confirmed ownership, correction and expiry behavior, and deletion propagation. |
| M5 | Asmo completes bounded persistent Missions. | Lead, runtime, backend/ops, QA. | Dependency-aware progress, budget limits, restart recovery, cancellation, and explicit completion criteria. |
| M6 | New connectors and curated plugins install easily. | Architect, connector/backend, product/QA. | A new connector passes the same authorization, approval, recovery, redaction, and usage checks without special bypasses. |

M0 blocks connected implementation proof. M1 is the next product milestone. After M1, M2 and M3 can progress in separate work streams. M4 and M5 require stable evidence identity, invalidation, and recovery. M6 should generalize proven connector behavior; it should not delay the first live workflow.

## M0: reconcile and verify the baseline

1. Compare core schemas with SQLite, provider, connector, server, and test callers. Record the intended contracts before changing shared interfaces.
2. Restore typed Notion tools, SQLite options, provider continuation state, and connection-bound grants/effects where the intended implementation requires them.
3. Keep one owner for shared contracts. Assign implementation files exclusively to prevent competing edits.
4. Run the server and web checks, focused tests, production builds, and synthetic workflow against the same source. Inspect failures rather than weakening types to satisfy callers.
5. Save sanitized evidence and record a coherent source snapshot through the repository's normal workflow. Keep secrets, local databases, and generated evidence out of an accidental bulk commit.

M0 completes when the current source is reproducible and its evidence distinguishes simulated behavior from connected behavior. This planning task does not repair the source.

## M1: guided setup and the first real win

### User experience

1. The manager starts Asmo and adds the bot to a dedicated test group.
2. Asmo verifies the actor, group binding, and required bot rights. Setup explains what conversation data it captures and when coverage begins.
3. The manager opens Tools and access, chooses Connect GitHub, authorizes access, and selects the approved repository.
4. The manager connects Notion and selects the pages available to that shared scope. The interface explains who can use the selected content.
5. The manager sets a task allowance and workspace spending limit. Provider credentials remain operator configuration.
6. Asmo offers a guided investigation using synthetic discussion data and the selected external resources.
7. The team sees cited findings, missing coverage, and a complete issue proposal. A current manager approves that exact action.
8. Asmo reports the confirmed issue URL, task result, and measured usage. Uncertain external outcomes remain unresolved until reconciliation establishes what happened.

### Implementation work

- Add actionable setup readiness checks for Telegram identity/rights, HTTPS callback configuration, provider configuration, resource access, and budget settings. Never expose secret values.
- Replace routine operator JSON editing with a guided configuration path. Keep a documented advanced path for operators.
- Verify authority again at execution and delivery, not only when the request enters Asmo.
- Prevent approval of unseen truncated content. Offer the complete authenticated proposal and bind approval to its exact content and destination.
- Bound collection volume and retention. Make coverage gaps explicit.
- Prove backup/restore with the separate connector vault key. Reapply deletion state after restore.
- Exercise disconnect, reconnect, stale approvals, expired authorization, restart, and ambiguous write outcomes.

Use [the first pilot runbook](../engineering/first-live-pilot.md) for dedicated resources and execution evidence. Update it when guided setup replaces manual steps. Do not treat one successful task as proof that every connected gate passes.

M1 completes when a nontechnical manager can finish setup and the real cited issue workflow, with no duplicate issue after retry or restart. Record the observed setup completion rate, failure points, task usefulness, and actual cost. Numerical performance targets need an explicit baseline before becoming release claims.

## M2: investigation to tested PR

Add repository content access and isolated execution. A task should reproduce the issue, propose a plan, edit a separate checkout, run relevant checks, and return the diff and actual results.

Execution jobs need bounded time, CPU, disk, network access, cancellation, and recoverable checkpoints. Broker credentials through the tool gateway. Do not expose broad connector secrets inside the execution environment. Long jobs require renewable leases or separate compute rather than assuming the current effect deadline is sufficient.

Bind review to the repository, base commit, patch hash, target branch, and PR content. Reconcile branch pushes and PR creation separately. A changed patch or base invalidates an obsolete approval. Disclose skipped or failed checks.

The proposed product default is a draft PR for human review. That is distinct from this repository's rule to open real PRs when acting as its development agent. Do not auto-merge or deploy as part of M2.

## M3: catch-up and event watches

Build source-backed answers to questions such as "What changed while I was away?" and "What blocks the release?" Retrieval should show missing history, bounded connector coverage, and conflicting evidence.

Add a signed event inbox, provider-event deduplication, replay cursors, debounce, and revocation handling. Start with a selected issue or PR. Broader repository and document subscriptions follow actual demand and provider support.

Each watch has an owner, scope, sources, destination, spending limit, expiry, and pause control. Check current access before every run. Notify on a meaningful change. Support local-time schedules explicitly instead of treating fixed UTC intervals as equivalent.

Claude Tag documents scheduled work and PR subscriptions. Its quiet-follow-up behavior informs this milestone. General document and repository watches remain Asmo proposals. [Routine behavior](https://claude.com/docs/claude-tag/users/proactivity)

## M4: shared decisions and commitments

Keep curated memory separate from raw conversation retention. Store provenance, scope, confirmation state, correction history, expiry, and supersession.

Clarify scope-level sharing approval versus per-fact approval before implementation. The existing acceptance plan allows useful automatic notes without per-note approval. Do not silently replace that contract. Ambiguous commitments should ask the named person to confirm ownership and the trigger before Asmo treats them as assigned work.

Private groups and personal conversations retain their boundaries. Corrections and deletion must invalidate affected task context and provider continuation state where applicable.

## M5: Asmo Missions

A Mission is a persistent goal with measurable completion conditions. Example: "Prepare Friday's release. Find blockers, propose fixes, and keep the team informed."

Represent child tasks, dependencies, blocked states, approved capabilities, budget reservations, retry limits, and completion checks durably. The model proposes next steps. Application policy determines whether they may execute.

A Mission should publish one consolidated progress record. It should pause when it needs authority or missing information, remain quiet when nothing changes, and stop future dispatch after cancellation. It must not keep spending because a goal is vague or unreachable.

## M6: connectors and curated plugins

Turn the current catalog into an executable connector contract only after the initial flows work. The contract should define schemas, authentication, resource selection, read/write classification, credential access, timeouts, redaction, cost limits, and effect reconciliation.

Installation should show what the connector can read, what it can change, and who can use it. Discovery through MCP does not grant execution permission. Version connector manifests and fence queued work when permissions or capabilities change.

Ship curated workflow packs before arbitrary downloadable code. Potential packs include bug triage, release preparation, and project catch-up. Add integrations such as Linear or Drive when pilot work demonstrates a need.

Personal connectors are a later track. Only the owner's authorized requests may use their access. Group posting needs a clear private-review policy, and unattended Missions must use explicitly shared connections. Verify the current provider and Claude Tag behavior again when implementing this track.

## Provider portability

Keep normalized model input/output separate from provider-specific transport and continuation state. Bind continuation state to provider, endpoint, and model. Rebuild from permitted canonical history when native state becomes invalid.

Before enabling a provider, test tool schemas, serial/parallel calls, incomplete responses, refusals, reasoning replay, token accounting, request limits, and failure recovery. Verify current documentation and prices. Do not advertise DeepSeek or GLM parity based only on a compatible endpoint.

The historical report describes a separate DeepSeek Responses profile and disabled GLM support. That is an implementation record, not proof of current connected compatibility or model quality. OpenAI remains the initial live target.

## Ambitious experiments

| Idea | Useful behavior | Prerequisite and proof |
| --- | --- | --- |
| Decision Time Machine | Reconstruct why the team made a decision and identify assumptions that changed. | M4 provenance and revision tracking. Distinguish documented alternatives from reconstructed inference. |
| Commitment tracker | Turn an agreed promise into a confirmed owner, trigger, and follow-up. | Person confirmation, correction, expiry, and quiet watches. Do not assign work from ambiguous chat alone. |
| Incident rehearsal | Replay a synthetic or approved anonymized incident in an isolated workspace and report missed signals and decisions. | Separate simulation identity and data. No production writes. Report measured outcomes rather than claiming operational readiness. |

## Team execution

Use the [team charter](team-charter.md). Roles are responsibilities, not simultaneous headcount. The lead coordinates at most three worker agents and owns final integration.

For M0 and M1, assign shared contracts and SQLite/policy to the backend owner, provider protocol and retrieval to the AI/runtime owner, and guided setup plus Telegram behavior to the integration owner. Rotate a slot to independent QA before milestone acceptance. PM and architecture review consequential choices without creating competing implementation owners.

Every assignment states owned files, caller contract, expected behavior, failure cases, and evidence required. Land shared contracts before dependent callers. The lead inspects actual changes and evidence before accepting a worker's result.

## Immediate implementation backlog

- [ ] Reconcile the current core contracts and restore a passing source baseline.
- [ ] Record fresh checks, tests, builds, and the synthetic workflow against that baseline.
- [ ] Define the guided operator setup and manager account-linking flow.
- [ ] Complete current-member checks, full-content approvals, bounded ingestion, and restore/deletion proof needed for the pilot.
- [ ] Prepare dedicated Telegram, GitHub, Notion, model, and HTTPS resources through the existing setup guide.
- [ ] Run the real cited investigation and exact issue approval workflow.
- [ ] Record usefulness, coverage gaps, usage, setup friction, and separately tested recovery cases.
- [ ] Select the first seeded bug for isolated code work and the first issue/PR watch.

Live execution requires the dedicated resources and spending allowance in [the provider and keys guide](../engineering/ai-provider-and-keys.md). This document creates no credentials, changes no service configuration, and passes no live gate. Dates and effort estimates should follow the M0 repair and M1 setup assessment; none are promised here.

## Research and related contracts

- [Claude Tag session model](https://claude.com/docs/claude-tag/concepts/how-it-works) supports the shared-session, steering, visible-progress, and ephemeral-sandbox direction.
- [Claude Tag routines](https://claude.com/docs/claude-tag/users/proactivity) informs scheduled work and meaningful-change follow-up.
- [Product specification](product-spec.md), [Telegram contract](telegram-contract.md), and [acceptance plan](acceptance-plan.md) define the existing behavior and release gates.
- [Architecture](../engineering/architecture.md), [connector design](../engineering/connector-design.md), and [Responses report](../engineering/responses-connectors-report.md) explain earlier technical decisions. Resolve differences against current source and the decisions recorded above.

Experience First prioritizes a manager completing useful work. Sequence Work into Verifiable Units requires each expansion to have its own evidence. Neither principle limits the eventual scope to the first pilot.
