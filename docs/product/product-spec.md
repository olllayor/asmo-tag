# Asmo Tag product specification

Status is a proposed product contract for implementation review. Nothing in this document claims deployed or tested behavior. Product owner is the PM role. The lead owns delivery against this contract.

The source brief authorizes a broad Telegram equivalent of Claude Tag. The working name is Asmo Tag under Asmo AI. Asmo Djinn is the playful naming option. "Asmo" below is shorthand for Asmo Tag. Username availability remains unverified. This is an independent product. The target is observable shared-agent behavior, not Anthropic's private implementation. The [research plan](../../telegram-tag-build-plan.md) supplies prior research. The [design brief](../../work/design-brief.md) supplies build constraints. The parity register below includes fresh official research checked October 6, 2026. Live platform and runtime behavior still require testing.

## Product promise

A teammate tags Asmo in a Telegram group. Asmo uses approved context and tools to complete the work, shows progress, accepts authorized steering, and returns results to that group. The task retains its evidence, actions, memory changes, and follow-ups.

The first target audience is product and engineering teams of 5 to 30 people. This is a planning assumption. The first task is a group bug report that becomes a cited investigation, an approved issue, and a scheduled follow-up. The full target also covers catch-up, preparation, documents, analytics, operations, and code work when the required tools are configured.

## Product objects

| Object | Meaning |
| --- | --- |
| Workspace | A customer boundary with members, resource grants, policy, and budget. |
| Chat binding | A verified association between one Telegram chat and one workspace. |
| Task | Shared work with one output destination, ordered instructions, state, evidence, and effects. |
| Context | Authorized messages, files, tool results, and coverage information used for a task. |
| Memory | A scoped, inspectable fact with evidence, revisions, and optional expiry. |
| Connector | A service identity with named resources and permitted operations. |
| Approval | A single-use decision for the exact action shown to an authorized approver. |
| Routine | Standing work with a trigger, sources, destination, owner policy, and limits. |
| Artifact | An answer attachment or external result with scope, provenance, and retention. |
| Audit event | A record of the actor, policy, decision, action, and outcome without credentials. |

Telegram topics organize task context. A topic is not a private access boundary. Usernames are display text. Stable Telegram IDs identify users and chats.

## Full target capabilities

Stages below are delivery gates, not estimates of completion. L is the first local build. P is the connected pilot. B is expanded beta. G is general availability preparation.

| ID | Capability | Required target behavior | Earliest stage |
| --- | --- | --- | --- |
| C01 | Setup and identity | Create a workspace, verify a group binding and manager, disclose collection, and list enabled capabilities. | L fixtures, P live |
| C02 | Shared tasks | Mentions and explicit commands start tasks. Replies continue a named task. Normal groups and forum topics work. | L |
| C03 | Concurrent work | Multiple tasks retain separate instructions, sources, progress, effects, and results. | L |
| C04 | Team steering | Eligible teammates add instructions in order. Conflicts pause affected external actions. | L |
| C05 | Visible lifecycle | Show queued, running, waiting, paused, completed, failed, and canceled states. Stop and resume have explicit semantics. | L |
| C06 | Authorized context | Retrieve captured relevant context and reply chains. Show collection start, missing history, source citations, and inaccessible evidence. | L |
| C07 | Files | Understand approved text, documents, and images. Reject unsafe or unsupported input with a clear reason. Return scoped attachments. | L text, P broader parsing |
| C08 | Memory | Save useful notes automatically and by explicit request. Members inspect, correct, and forget them. Workspace sharing follows the group's explicit public/private product scope. | L explicit, B automatic |
| C09 | Tools | Use scoped service accounts, named resources, read/write classification, revocation, and action audit. | L fixture tool, P real connector |
| C10 | Exact approvals | Preview the concrete write, recheck actor and policy, execute it once, and invalidate it when the action changes. | L |
| C11 | Durable work | Recover after restart, retain partial work, reconcile uncertain writes, and deliver saved results without rerunning actions. | L |
| C12 | Spend control | Bound each task, group, and workspace. Reserve before dispatch. Show limits, usage source, and partial results after exhaustion. | L |
| C13 | Scheduled routines | Create, inspect, pause, resume, and revoke schedules with timezone input and a displayed UTC occurrence. Work sleeps between triggers. | L |
| C14 | Event watches | Watch approved issue, repository, and alert events. Notify on meaningful change and explain the trigger. | P issue watch, B broader sources |
| C15 | Personal work and channel connectors | Separate workspace-bound DM notes and personal results. A user's own request can use that user's connector in a group after permission, with review or screened auto-posting. Teammates and unattended work cannot reuse it. | L read-only DMs, B personal tools |
| C16 | Code work | Reproduce, edit, test, and return a diff or draft PR in an isolated environment. Report unrun checks and human review requirements. | B |
| C17 | Documents and analysis | Produce cited documents, reports, charts, summaries, and updateable hosted pages with approved sources and audience access. | P basic artifacts, B richer formats |
| C18 | Task branches | Fork with a fresh authorized context snapshot. Restart preserves the old task's audit and does not replay its writes. | B |
| C19 | Ambient help | Match Tag's configurable automatic replies, with a per-group setting on by default at the full target. Pilot posting stays off until shadow evaluation passes. | B |
| C20 | Administration | Mini App manages groups, tools, tasks, memory, routines, spend, audit, retention, and export. Chat controls remain usable. | P after UI pick |
| C21 | Data controls | Revoke access, export authorized records, and delete scoped content with dependent-copy handling and stated backup expiry. | L denial/invalidation, P full lifecycle |
| C22 | Connector extension | Add a connector through a typed contract, policy checks, failure reconciliation, and shared evaluation cases. | P one connector, B more |
| C23 | Commerce and support | Display usage, support payment disputes and refunds, and use the applicable Telegram payment route for digital services. | G if paid |
| C24 | Operator controls | Inspect delayed work, stop execution, rotate credentials, reconcile usage, restore backups, and audit access. | P |

## First local build

The first implementation is substantial enough to exercise the shared-agent model, without Telegram or model credentials. It uses explicit offline fixtures. Every simulated model answer, provider effect, cost, and Telegram delivery is labeled. Offline mode is selected by configuration. Missing real-provider configuration fails clearly and never selects fixtures automatically.

L includes all of the following behaviors:

- Durable normalized updates for mentions, replies, topics, edits, membership changes, and callbacks.
- Two fixture workspaces, three groups, two users' DMs, and intentionally forbidden sources.
- Task routing, ordered steering, task progress, stop, resume, failure, and cancellation.
- Context with source IDs, collection coverage, and scope filters before retrieval.
- Text attachments, a safe parsing failure, and a returned text artifact.
- Group memory, user DM memory, explicit saving, correction, candidate rejection, and invalidation.
- One issue tool with read, draft, exact approval, create, revoke, and uncertain-write reconciliation paths.
- Group, workspace, and task budgets with simulated usage and concurrent reservation checks.
- One daily digest routine with explicit timezone input and a fixed UTC schedule that survives restart and can be paused.
- An audit record for policy decisions, steering, effects, budget stops, and routine runs.
- A real Telegram and model adapter path that identifies missing configuration and sanitizes errors.
- A repeatable scenario runner with visible task state and effect history. It can be a CLI or developer endpoint. It cannot substitute for live Telegram acceptance.

The local build ends at gate L in the [acceptance plan](acceptance-plan.md). It does not claim live API compatibility, real model quality, actual cost, sandbox isolation, or an operational deletion service.

## Connected pilot

P connects the same behavior to a test bot, a selected real model/runtime, and one narrow GitHub installation. GitHub Issues is the proposed first issue tracker. A second issue-tracker integration is unnecessary until a pilot requires one.

The pilot must complete this real workflow:

1. A group discusses a bug and tags Asmo.
2. Asmo finds captured chat evidence and approved repository or issue context.
3. Another eligible member narrows the investigation by replying to its task message.
4. Asmo returns a cited investigation and an exact issue preview.
5. An authorized approver creates that issue in the selected repository.
6. The result links the created issue and records the actor, action, and evidence.
7. A scheduled digest or explicit issue watch resumes after a worker restart.
8. A manager revokes the connector. Its next call is denied without stale access.

P also requires live group binding, membership checks, practical file handling, full scoped deletion behavior, owner-facing usage and audit, recovery drills, and an operator runbook. The Mini App can ship only after the user selects a static mock. Backend work and deterministic chat controls can proceed before that pick.

## Product invariants

| ID | Invariant |
| --- | --- |
| I01 | Every task has one resolved workspace, source scope, and output destination. |
| I02 | Group output is safe for the entire verified audience, not only the requester. |
| I03 | A group cannot belong to two workspaces at once. Every Telegram group defaults to private product policy. |
| I04 | DM content never becomes group or workspace knowledge without an explicit authorized sharing action. |
| I05 | Retrieved content, tool output, and memory cannot grant permissions or change administrative policy. |
| I06 | Approval is valid only for the previewed action, current actor authority, current grant, current policy, and unexpired decision. |
| I07 | A repeated event or decision does not intentionally repeat a task or external write. Unknown effects reconcile before retry. |
| I08 | Stop blocks new dispatch after acceptance. Stop does not undo completed or already dispatched effects. |
| I09 | No new paid call starts without a valid reservation. Usage reports distinguish provisional, reconciled, and simulated totals. |
| I10 | Revocation applies to pending approvals, future calls, routine runs, and future access to retained sources. |
| I11 | A missing source or unsupported operation produces a visible limitation, not an invented result. |
| I12 | A completed task with failed delivery retries delivery. It does not rerun the task. |
| I13 | Secret values stay outside prompts, artifacts, routine instructions, ordinary logs, and code environments. |
| I14 | Deletion invalidates linked retrieval and active context before completion is reported. Backup expiry is a separate stated limit. |

## Scope boundaries

General availability does not require every available SaaS connector. Each new connector must have a customer workflow and pass the same policy and failure gates.

The first build excludes a connector marketplace, paid billing, ambient posts, personal connectors, merge and deployment tools, arbitrary network access, arbitrary code execution, and guessed old chat history. These remain explicit later capabilities where relevant. Guest bot summons are a later acquisition route with public general assistance only. Guest mode cannot receive a customer's private memory or tools.

A first local implementation may use one selected real runtime path. Competing runtime and persistence candidates are architecture work, not product requirements. A narrow direct model loop does not by itself satisfy later code execution or long-lived session requirements.

## Claude Tag parity and difference register

Research resolves behavior before treating it as a product preference. Match Tag where Telegram permits. A narrower pilot rule is a stage restriction, not a permanent target difference. The September 24 personal-connectors announcement supersedes the older service-account-only description on the general session page.

| Behavior | Official evidence | Asmo Tag target | Difference or pilot restriction |
| --- | --- | --- | --- |
| Shared sessions | Anyone in a channel can start and steer the thread's session. Stop retains context. [Session behavior](https://claude.com/docs/claude-tag/concepts/how-it-works). | Eligible group members start, steer, stop, and continue shared tasks. | Telegram replies and task-message links replace Slack threads. Explicit task selection resolves ambiguity. |
| Memory creation | Notes are automatic as well as explicitly requested. Members can inspect and correct them. [Memory](https://claude.com/docs/claude-tag/users/memory). | Automatic curated notes plus explicit save/correct/forget. | L/P keeps auto notes as reviewable candidates until memory evaluation passes. Manual review is not the permanent target. |
| Memory scope | Public channels can save workspace notes; private channels read them and save locally. DM and group-DM notes stay separate. [Memory scope](https://claude.com/docs/claude-tag/users/memory). | Explicit product-public groups can save workspace notes. Product-private groups save only group notes. DMs are workspace-bound and separate. | Every Telegram group starts product-private. A public Telegram username alone does not activate shared-memory policy. |
| Personal connectors in groups | The user's own connector can serve that user's request after permission. Review and screened auto modes control output. Unattended work uses shared connectors. [September 24 announcement](https://claude.com/blog/claude-tag-now-supports-personal-connectors-in-channels). | Per-request owner authority, separate personal execution context, review by default, optional screened auto mode, and admin-required review. | B capability. Telegram DM review replaces private Slack review. Never expose private input in group progress or memory. |
| Automatic replies | Tag's per-channel automatic-response setting starts on. Joined threads continue without repeated mentions. [Response controls](https://claude.com/docs/claude-tag/users/when-claude-responds). | Full target uses the same default and an explicit group/task quiet control. | L/P ambient posting stays off. Posting turns on only after usefulness and security gates pass. Telegram ingestion coverage is shown. |
| Routine management | Members manage standing work; group routines survive creator departure. Personal routines stop with user removal. [Routines](https://claude.com/docs/claude-tag/users/proactivity). | Eligible members manage permitted group routines. Shared ownership survives creator departure. Personal access removal stops personal work. | L/P requires manager activation. No personal connector is inherited by a routine. |
| Schedule interpretation | Tag schedules run at fixed UTC times; timezone input sets that time and local DST changes shift it. [Schedules](https://claude.com/docs/claude-tag/users/proactivity). | Existing schedules retain fixed UTC. The backend also accepts an explicit daily-local time with IANA timezone, gap-forward and earlier-fold policy, and a saved UTC cursor. [Local schedule contract](../engineering/local-routine-schedules.md). | Telegram lacks a reliable profile timezone. Ask when no workspace/user timezone exists. The Mini App remains a fixed-UTC client; local-time controls and live scheduled delivery remain unverified. |
| Repository events | Tag subscribes to individual PRs, not arbitrary repository events. [PR subscriptions](https://claude.com/docs/claude-tag/users/proactivity). | First event parity covers individual PR subscriptions. | P issue watches and later broader repository triggers are labeled Asmo extensions. |
| Edits and deletion | Edits become transcript notes and do not re-address Tag. Deleted replies do not remove stored transcripts. [Message changes](https://claude.com/docs/claude-tag/concepts/how-it-works). | Edits retain before/after evidence. New replies steer. Adding a mention by edit does not start a task. | Telegram lacks a general deletion event. Explicit product forget/delete controls replace inferred deletion behavior. |
| Spend | Organization/channel limits stop unfinished work visibly. Reading and short known-context responses do not bill Tag usage. [Spend controls](https://claude.com/docs/claude-tag/admins/set-spend-limit). | Workspace/group budgets, attribution, visible exhaustion, and preserved partial work. | Asmo adds per-task limits. Do not promise free model-backed monitoring or seat billing until Asmo's pricing supports it. |
| Artifacts and code | Sessions use real isolated sandboxes and return files, charts, hosted pages, or draft PRs. [Artifacts](https://claude.com/docs/claude-tag/concepts/how-it-works). | Same result classes and durable task context at the full target. | Isolation and hosted audience controls need separate proof. L does not simulate these as production success. |

The memory page timed out through the web tool. A direct public fetch of the same official page succeeded and supplied the memory facts above. The other register sources fetched through the web tool. No logged-in Claude Tag session was inspected.

## Remaining product choices and pilot defaults

These choices require preference or customer evidence. None blocks local implementation. Defaults are proposals and may be changed before connected activation.

| Choice | Proposed default | Why it matters | Revisit before |
| --- | --- | --- | --- |
| Initial customer | Engineering/product Telegram teams with 5 to 30 members. | Keeps evaluations and the first connector focused. | Pilot recruitment |
| Product identity | Asmo Tag under Asmo AI. Optional playful name is Asmo Djinn. One shared hosted bot; final username is unverified. | Branding is a genuine preference call. Per-customer bots add operations work. | Bot creation |
| First tracker | GitHub Issues on selected repositories. | Reuses one installation for read and write workflow. | Real connector implementation |
| Hosting | Hosted multi-workspace service. Local fixtures and future private deployments use the same boundaries. | Changes data and operational responsibility. | Pilot terms |
| Group collection | Notice, manager activation, then conversation collection with mention-only replies. | Full group context requires stored messages and clear consent. | Live activation |
| Raw content retention | 30 days of messages and files. Keep task metadata for 90 days. Workspace owner sees the exact policy. | Sensitive content and long-term retrieval have different needs. | Pilot activation |
| Memory retention | Retain saved memory until removal or stated expiry. Automatic saving is the target. L/P auto notes stay candidates temporarily. | A transcript expiry must not hide durable stored facts. | Pilot activation and B memory gate |
| Approval authority | Group manager or owner approves every external write in the pilot. Members can prepare and revise it. | Shared service identity requires clear write accountability. | Pilot activation |
| Approval lifetime | 15 minutes. Any changed action, policy, or grant invalidates it sooner. | Limits stale decisions without frequent approval churn. | Live UX check |
| Write autonomy | No standing write grants in L or P. Later managers can enable bounded action classes per resource. | The target supports autonomy without starting with broad writes. | B policy design |
| Concurrency | Two active model tasks per group and a bounded workspace queue. | Keeps chat behavior and costs understandable. | Load evaluation |
| Routine activation | Manager-only in L/P. Full target lets eligible members manage group standing work within policy. Group routines survive creator departure. | This is a temporary pilot restriction relative to Tag. | B routines |
| Ambient notifications | Off in L/P. Full target automatic replies start on per group after gates pass. Proposed cap is three unsolicited notices per group per day. | The default matches Tag; the cap is an Asmo attention control. | B shadow review |
| Spending | Owner supplies a hard task, group, and workspace allowance before live paid work. No unlimited pilot. | No observed usage yet supports a universal allowance. | Real provider activation |
| Monetization | Free, budgeted pilot. Decide paid plan after measured value and payment requirements. | Avoids billing work before useful delegation exists. | Paid launch |
| DM team access | A verified member may use only groups and resources that the member can currently access. | Workspace membership alone cannot unlock every group. | P DMs |
| Language | Preserve the group's language in replies. Setup copy starts in English. | Locale must come from user behavior, not paths or developer timezone. | Pilot feedback |

## Value measures

Track completed delegated tasks, accepted issues or artifacts, task correction rate, time to usable result, cost per accepted task, and groups returning in week four. Count false interruptions separately. Message count is not the success measure.

A proposed pilot target is 80% of scoped evaluation tasks meeting their expected outcome, with 95% of sampled evidence-based material claims supported by accessible sources. These are future targets. The acceptance plan defines the harder permission and failure gates.
