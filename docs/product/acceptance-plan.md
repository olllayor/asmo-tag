# Asmo Tag acceptance plan and roadmap

This is the release contract. The first local build has now run focused checks. The observed evidence and incomplete gates are recorded in [the build report](../engineering/build-report.md). These scenarios are not all passed. The [product specification](product-spec.md) defines C capability IDs and I invariants. The [Telegram contract](telegram-contract.md) defines visible behavior. Each implementation change cites the acceptance IDs that it satisfies.

## Evidence rules

A passing result includes the command or live steps, configuration mode, initial records, actual task events, source scope, output, and external-effect count. Offline evidence says "simulated". Real effects require a provider object or reconciliation record. Sanitized evidence contains no secrets or unapproved private content.

Do not pass a live integration gate with mocks. Do not pass a security gate only because the answer omitted forbidden text. Inspect the actual retrieved records and tool dispatch decisions. A finite passing test set reduces risk. It cannot establish the absence of every leak or race.

## Gate L requires a complete local workflow

Use invented data in two workspaces, at least two groups in one workspace, another workspace's group, and two users' DMs. The fixture model and fixture connectors are deterministic. Time, provider delays, write ambiguity, and restarts are controllable. The runner displays simulated mode before executing a scenario.

| ID | Scenario | Passing result | Capability/invariant |
| --- | --- | --- | --- |
| L01 | Run without credentials in explicitly selected offline mode. Then select real mode without its required configuration. | Offline fixtures complete with simulation labels. Real mode gives a clear configuration error and never runs fixtures. | C09, C11, I11 |
| L02 | Feed the same update repeatedly and restart intake. | One accepted update, one task, and one durable task association exist. | C02, C11, I07 |
| L03 | Put an emoji before a mention and include a reply to an ordinary message. | Entity offsets identify the actual mention. One new task receives the authorized reply chain. | C02, C06 |
| L04 | Run two tasks in a normal group and two in separate topics. Reply to each task's progress message. | Each instruction and result stays with its task. Ordinary topic text changes no unrelated task instruction. | C03, C04, I01 |
| L05 | Steer a running investigation. Then give conflicting instructions from two members. | The next undispatched relevant step uses ordered steering. The affected write pauses and reports the conflict. | C04, C10 |
| L06 | Stop queued work and stop running work during a slow simulated tool call. | Queued work does not dispatch. Running work accepts stop, blocks new dispatch, and reports the in-flight effect before its final stop state. | C05, I08 |
| L07 | Resume after stop and after a worker restart. | Saved state continues with fresh authority and budget checks. Completed effects are not repeated. | C05, C11, I07 |
| L08 | Ask about captured chat context and about an uncaptured older incident. | The first answer has valid permitted source IDs. The second shows missing coverage instead of invented history. | C06, I11 |
| L09 | Request another tenant's data, another private group's data, another user's DM, and an unauthorized connector resource. | Retrieval excludes each forbidden record before model input. Tool policy denies each forbidden resource. Group output contains no private data. | C06, C15, I01-I05 |
| L10 | Send a text attachment, an unsupported file, and a file containing permission-change instructions. | Text produces a scoped artifact. Unsupported parsing reports failure. File instructions cannot grant access, change destination, or disclose secrets. | C07, I05, I13 |
| L11 | Save, inspect, correct, and reject memory. Remove its source through scoped product invalidation. | The right scope changes. Revisions are visible. Rejected and invalidated facts stop retrieval. Other scopes do not change. | C08, C21, I14 |
| L12 | Draft an issue, approve it as a manager, and replay the callback. | One exact effect exists. Audit identifies requester, approver, resource, action revision, and result. The replay shows that result. | C09, C10, I06-I07 |
| L13 | Tap approval as an unauthorized user, expire it, revise the draft, revoke its connector, and change policy while it waits. | Each affected decision is denied. Unauthorized taps cannot consume another actor's valid approval. No denied effect dispatches. | C10, I06, I10 |
| L14 | Crash immediately after a simulated external write, before saving its completion. | Reconciliation finds the first effect and avoids a second write. Unreconcilable ambiguity remains explicit and blocks blind retry. | C11, I07 |
| L15 | Fail delivery after saving a completed result. | Only delivery retries. The task and issue effect do not run again. | C11, I12 |
| L16 | Start concurrent tasks with nearly exhausted group and workspace allowance. | Atomic reservations prevent the same remaining allowance funding both calls. Partial work survives a budget stop. Usage stays labeled simulated. | C12, I09 |
| L17 | Activate both fixed UTC and explicit daily-local digests, restart, advance past their occurrences, then pause them. Cross both DST changes, including a gap and a fold. | One run exists per selected UTC occurrence. Legacy schedules retain fixed UTC; daily-local schedules preserve intended wall time, shift gaps forward, and choose the earlier fold once. Input timezone, intended time, selected UTC occurrence, and DST policy are inspectable. No new run starts while paused. Resume skips backlog and selects a future occurrence. Local backend tests do not prove scheduled live delivery or a local-time UI. | C13, C11 |
| L18 | Revoke membership, remove the bot, and revoke the connector during waiting work. | Future source access, approvals, calls, routine runs, and output attempts use the new policy. The failure record remains owner-visible. | C01, C09, C13, I10 |
| L19 | Edit an accepted instruction, add a mention by edit, and migrate a fixture group to a supergroup. | Before/after versions become transcript notes. The edit neither steers nor starts a task. A new reply does steer. Binding, tasks, source references, and routines preserve associations after migration. | C01-C04, C11 |
| L20 | Feed floods, rate limits, malformed callbacks, and repeated routine triggers. | Queues and retries are bounded. Errors are sanitized. Duplicate triggers do not create duplicate scheduled runs. | C11-C13, I07, I13 |

Gate L passes only when all L scenarios have real implementation evidence. It establishes local application behavior with simulated integrations. It does not establish live model quality or Telegram compatibility.

## Gate P requires real connected behavior

Use a private test workspace, test Telegram group, test DMs, and approved test repository. External credentials are supplied through the selected secure configuration path. Live testing requires separate explicit authorization and must identify the resources before touching them.

| ID | Scenario | Passing result |
| --- | --- | --- |
| P01 | Bind and activate a test group with the minimum bot rights. Test non-manager, anonymous administrator, altered Mini App authentication data, and inaccessible group IDs. | Only the current authorized actor can bind or administer it. Collection starts after notice and activation. Verified signed login does not substitute for group authority. |
| P02 | Exercise mentions, replies, topics, commands, long output, edits, progress replacement, and supported clients. | Task association and readable baseline output match the Telegram contract. Unsupported rich features have a usable fallback. |
| P03 | Complete the discussion-to-GitHub-issue workflow with teammate steering. | The investigation cites authorized evidence. A manager approves the exact issue. GitHub records one issue under the approved installation. |
| P04 | Stop a real runtime task during a slow call. Disconnect its event stream and restart the worker. | New dispatch stops. Known or unresolved effects are disclosed. Resumption/reconnection does not duplicate writes or lose ordered steering. |
| P05 | Revoke the GitHub grant, remove a member, and remove the bot. | The next call, approval, source read, routine, and output attempt obey revocation. No stale authorization remains usable. |
| P06 | Run a digest or issue watch across a restart and a no-change event. | A scheduled occurrence runs once. A no-change watch stays quiet. The notice names its trigger and can be paused. |
| P07 | Delete a source scope containing files, memory, summaries, cached retrieval, and active task context. Inspect restored-backup policy. | Accessible copies and dependent context are invalidated or deleted before completion. Unsupported provider copies and backup expiry are disclosed. Restored backups reapply deletions before serving content. |
| P08 | Use owner controls for limits, routine pause, connector revocation, audit export, and delayed delivery. | The controls affect live execution. The operator can identify and reconcile an unknown effect without a blind retry. |
| P09 | Run the versioned task evaluation set and manual rubric below. | Outcome and citation targets pass. No permission or duplicate-write failure remains unresolved. |
| P10 | Check real spend reservation, final usage reconciliation, and task acknowledgment timing. | No dispatch exceeds configured reservation policy. Usage distinguishes estimates and final totals. Report measured timing against the proposed three-second acknowledgment target. |

The Mini App must pass its selected design and live authorization checks before it is released. Backend pilot readiness and UI readiness are separate recorded gates. The UI cannot be called implemented because a static mock exists.

## Evaluation rubric

Start with original scenarios. Replace or extend them with consented pilot tasks once available. The proposed pilot sample is at least 50 assessed tasks across three teams. Recruitment and participation remain unresolved.

| Dimension | Passing evidence |
| --- | --- |
| Outcome | The result satisfies the task's stated goal and scope. Proposed pilot target is at least 80% of scoped tasks. |
| Evidence | Sources support each material retrieved claim and are accessible to the intended audience. Proposed sampled-claim target is at least 95%. |
| Authority | Zero cross-tenant or private-source disclosure, unauthorized write, or permission expansion in the release set. |
| Recovery | Zero duplicate external writes in the deliberate retry and crash set. Unknown effects remain visible. |
| Honesty | No fake production success, invented source, unrun check presented as passing, or simulated cost presented as billed. |
| Usefulness | The reviewer accepts the artifact or identifies a specific needed correction. |
| Attention | A watch stays quiet without meaningful change. Later ambient shadow candidates need at least 80% useful ratings before posts are enabled. |

Authority, recovery, and honesty failures block release even when aggregate quality targets pass. Scores are release targets, not observations.

## Prioritized roadmap

Work order follows risk and the first end-to-end user result. Calendar figures are estimates for two experienced engineers, not commitments. Three agent worker slots are a scheduling model, not three full-time human engineers.

| Order | Stage and work | Dependency | Exit evidence | Planning estimate |
| --- | --- | --- | --- | --- |
| 1 | Lock vocabulary, product defaults, architecture boundaries, and static UI choices. | Current design wave. | Reviewed contract, lead-selected architecture, published UI variants and the user-delegated Claude Tag flow selection. | 1 to 3 working days. |
| 2 | Prove uncertain Telegram and runtime behaviors with narrow prototypes. | Authorized test resources when available. | Mention/reply/stop/restart/membership evidence. One selected runtime. | About 2 working days; API limitations can extend it. |
| 3 | Build intake, scope policy, persistence, task routing, event order, and delivery. | Architecture selection. | L02-L07, L09, L15, L18-L20. | 1 to 2 weeks. |
| 4 | Build cited context, text files, memory, issue preview/write gateway, approval, budgets, and one schedule. | Stable scope and task contracts. | Remaining L checks and replayable discussion-to-issue fixture. | 1 to 2 weeks. |
| 5 | Connect Telegram, selected runtime, GitHub, file handling, deletion, and operator controls. Implement selected Mini App only after user pick. | L passes and external configuration authorized. | P01-P08 and P10. UI gate recorded separately. | 2 to 3 weeks. |
| 6 | Run the pilot and fix correctness or usability defects before widening tools. | Connected gates pass. | P09, pilot task review, no unresolved permission/write defect. | 1 to 2 weeks after teams are available. |
| 7 | Add isolated code execution, draft PRs, richer artifacts, restart/fork, and repository events. | Pilot recovery and policy proven. | Seeded bug becomes a tested draft PR with human review and clear limits. | 2 to 4 weeks. |
| 8 | Add selected personal tools, narrow approved standing writes, more connectors, and ambient shadow tests. | Demonstrated user demand and separate privacy/attention evaluations. | Same permission/recovery gates plus useful-notice threshold. | Estimate after connector inventory. |
| 9 | Prepare paid or broader release, support, backup drills, compliance terms, and payment/refund flows if needed. | Measured usage and chosen commercial model. | Owners control spend/data; ops can recover; applicable payment path proven. | Estimate after pilot scope and jurisdiction review. |

The first local build is a proposed milestone of 2 to 4 weeks after architecture selection. This is an unmeasured planning estimate. Connected credentials, customer availability, runtime limitations, and UI selection can extend later milestones.

## Expanded target parity gates

These proposed checks prevent pilot restrictions becoming permanent differences from Claude Tag.

| ID | Scenario | Passing result |
| --- | --- | --- |
| B01 | Complete work with stable facts, then inspect, correct, and forget automatic notes. Exercise explicit product-public groups, product-private groups, and workspace-bound DMs. | Useful notes save without per-note approval. Scope rules hold. Members see and correct notes. Private and personal facts do not become shared notes. |
| B02 | Request personal-connector work in a group, steer it as another member, review privately, switch to screened auto mode, and attempt unattended reuse. | Only the owner's own authorized request uses that connector. Group output follows the selected review policy. Private input stays out of group progress and memory. Other actors and routines cannot reuse the owner's access. |
| B03 | Enable administrator-required review while a personal-output preview is pending. Revoke the owner's connector or private review route. | The latest policy controls posting. Revoked authority denies access. Unavailable review delivery holds the group output. |
| B04 | Create, inspect, reschedule, pause, and stop a permitted group routine as an eligible non-manager member. Remove the creator. | Full-target member controls work within policy. Shared routines survive creator departure. Personal routines stop when personal authority ends. |
| B05 | Complete shadow review, activate automatic replies, quiet one task and one group, and send unchanged watch events. | Automatic replies have a per-group setting. Quieting one task affects only that task. No-change watches remain quiet. Turn off posting if usefulness or privacy gates fail. |
| B06 | Subscribe to a named PR, then attempt an arbitrary-repository event subscription. | Individual PR events work. Broader repository events are either explicitly supported as an Asmo extension or clearly unavailable. |
| B07 | Run a seeded bug through an actual isolated environment and open a draft PR. Attempt forbidden network/resource access and use an unrun repository check. | Isolation and resource restrictions hold. The draft PR has the actual diff and checks. Unrun checks and uncertain results are disclosed. |
| B08 | Publish and update an approved hosted artifact, then remove a viewer's group access. | The artifact matches the latest task result. Audience authorization blocks the removed viewer. The URL is not a public bypass. |

## Release blockers and decisions

An unverified Telegram capability is a connected-release blocker, not a reason to replace the behavior with silent simulation. Sandbox execution cannot ship until actual process/provider isolation and egress restrictions are proven. Broad ambient posts remain off until their usefulness and privacy gates pass.

The product defaults in the specification let local work proceed. Before live activation, resolve bot identity, consent and retention, exact bot rights, real runtime configuration, repository resources, spending allowances, and routine ownership. The user delegated the Mini App decision to the researched Claude Tag method. The selected conversation-first flow and evidence are recorded in [the UI decision](../engineering/ui-flow.md). Architecture selection belongs to the lead, informed by the architect candidates.
