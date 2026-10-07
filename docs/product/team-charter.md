# Asmo Tag team charter

This is a proposed delivery model for the broad target in the [product specification](product-spec.md). The user asked for a team before implementation. Roles are responsibilities, not a promise to hire people or create nine simultaneous agents. The lead coordinates three worker slots. One person or agent may hold different roles in successive stages.

## Authority and ownership

The human user owns product preference, irreversible release approval, and external resource authorization. The user delegated the UI pick to the researched Claude Tag method. The lead selected the conversation-first flow recorded in the UI decision. The PM proposes defaults and owns scope, user behavior, acceptance criteria, and priority. The lead makes technical delivery decisions after reviewing architecture evidence. Security/QA can block a release for a demonstrated permission, secret-handling, duplicate-write, or honesty failure.

Workers can make reversible implementation choices within their assigned contract. They report material deviations before another owner builds on them. No role can infer permission to deploy, contact customers, access production, or acquire secrets from this charter. Existing session authorization remains authoritative.

| Role | Accountable result | Boundaries and handoff |
| --- | --- | --- |
| PM and product owner | Concrete target, first-build scope, Telegram behavior, evaluation rubric, and roadmap. | Owns `docs/product/`. Decides proposed product defaults. Reviews customer-visible deviations and acceptance evidence. |
| Lead and integrator | One coherent architecture, stable interfaces, sequencing, integration, and final evidence. | Assigns exclusive module/file ownership. Reviews diffs and actual results. Keeps the decision trail and does not relay a worker's PASS without checking it. |
| Architect | Competing designs with caller usage, domain model, scope boundaries, recovery, provider tradeoffs, and failure risks. | Owns non-executable design artifacts. Lead selects one design and records rejected tradeoffs. |
| Backend | Durable product state, updates, tasks, events, policy, approvals, budgets, memory storage, and schedules. | Owns policy authority. Exposes narrow interfaces to Telegram, runtime, and UI. Does not trust client-supplied workspace or role data. |
| AI/runtime | Real provider integration, offline fixture contract, scoped context, streaming/events, steering, stop, resume, and task evaluation. | Cannot grant tool permissions. Requests actions through the gateway. Reports provider limitations and model quality separately from application correctness. |
| Telegram integration | Platform normalization, setup, group/topic/DM routing, callback identity, message association, baseline rendering, and delivery. | Proves minimum rights and current platform behavior. Passes resolved actor and chat context to backend policy. Does not decide authorization from display identity. |
| UI and product design | Published static alternatives, selected Mini App, responsive/accessibility behavior, and failure/empty states. | No real components before the user's mock pick. Uses true black, white text, dense rows, minimal copy, and no decorative motion or card/pill chrome. |
| Security/QA | Independent behavior checks for source boundaries, exact approvals, concurrency, revocation, injection, and failure recovery. | Inspects records and dispatches, not just model text. Owns acceptance evidence and can report BLOCKED with the precise failing gate. |
| Ops | Local startup, secure configuration contract, bounded workers, observability, backups/deletion reapplication, recovery drills, and runbooks. | Separates fixture mode from live mode. Does not claim deployed behavior without a verified release. Identifies every environment touched. |

## Three-slot staffing plan

The lead remains the coordinator. At most three workers execute at once. Rotate roles after a stage exits. Do not run an architect, PM, UI, and four implementers together under a three-slot limit.

| Stage | Worker slot 1 | Worker slot 2 | Worker slot 3 | Lead integration gate |
| --- | --- | --- | --- | --- |
| Design, before code | PM/product owner and static review artifact. | Architect candidate A. | Architect candidate B. | Read actual artifacts. Select stack and contract. Record product defaults and genuine unknowns. |
| Behavior proofs | Telegram owner proves routing and membership requirements. | AI/runtime owner proves real-provider steering, cancellation, and restart boundaries. | Security/QA reviews policy and failure model. | Stop weak assumptions before they enter shared interfaces. |
| Local foundations | Backend owns scope, durable tasks, approvals, and budgets. | Telegram owner owns normalization, message links, and fixture input/output. | AI/runtime owner owns context and selected runtime/fixture adapters. | Stable call contracts. L scope/routing/lifecycle checks pass before adding writes. |
| Local complete workflow | Backend completes memory, issue gateway, schedules, and invalidation. | AI/runtime completes investigation and context/artifact behavior. | Security/QA runs adversarial and crash cases. | All L evidence passes. The real path still fails clearly when unconfigured. |
| Connected pilot | Telegram/backend integration owner connects authorized test bot and GitHub. | AI/runtime owner proves connected tasks and evaluation. | Ops/security owner proves revocation, usage, deletion, delivery, and recovery. | P backend gates pass. All touched external resources are named. |
| Selected Mini App | UI owner implements the picked variant and accessible failure states. | Backend owner supplies signed auth, group authority, and settings/task APIs. | Security/QA checks live UI permissions and behavior. | User pick exists. UI acceptance is separate from backend readiness. |
| Expanded beta | Backend/tools owner adds demanded connectors and event watches. | Runtime owner adds actual isolated code work and draft PRs. | Security/QA/ops owner proves isolation, recovery, and ambient shadow quality. | Seeded code workflow passes; no auto-merge or production deployment assumed. |

PM remains a responsibility during implementation. The lead can hold routine scope triage. Reactivate a PM worker only for a consequential product choice, pilot review, or substantial contract change. Reassign a slot instead of adding a fourth worker.

## Work assignment contract

Each assignment contains the goal, owned files/modules, caller contract, dependencies, acceptance IDs, allowed environments, prohibited actions, and expected evidence. The lead prevents simultaneous edits to the same contract or source file. If ownership must change, finish or interrupt the current assignment and hand off its actual state.

Changes to shared types or contracts go through the lead. The owner updates the contract, dependent owners acknowledge it, then implementation proceeds. Do not create parallel compatibility layers to avoid coordination. The architect consults on cross-cutting changes without reopening a settled design by default.

## Stage completion reports

Every worker reports one verdict and evidence:

- PASS means the assigned artifact or behavior meets its explicit gate. The report links the actual file and observed check.
- ISSUES means a reviewable deliverable exists with a known gap. The report names the affected acceptance ID and next action.
- BLOCKED means required work cannot proceed under the available authority or configuration. The report names the exact blocker and useful work already completed.

Fixture checks cannot produce a live-provider PASS. A typecheck cannot produce a runtime-recovery PASS. Security/QA reviews another owner's implementation after the build stage. Where slot limits prevent fully independent review, report that limitation and rotate the reviewer before release.

## Definition of a team-ready plan

The planning stage is complete when the product contract, architecture selection, module ownership, first assignments, and release gates are explicit. The user sees a concrete product and the static UI choices before real UI work starts. Missing credentials and live platform proof remain visible next-stage prerequisites. They do not turn the plan into an unfinished local prototype.
