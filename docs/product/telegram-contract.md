# Asmo Tag Telegram interaction contract

This proposed reference defines user-visible behavior. It implements C01 through C15 of the [product specification](product-spec.md). Its parity register records fresh official Claude Tag evidence. Platform behavior remains untested here. A live test bot must verify the client and Bot API assumptions at gate P.

## Setup and collection

1. An owner starts the bot in a DM and creates a workspace.
2. The owner adds the bot to a selected group through a one-time binding flow.
3. Asmo verifies the actor's group authority and prevents a second workspace binding.
4. Asmo shows collection mode, retention, enabled resources, approved actors, and a member notice.
5. A manager activates collection. Asmo records the context start time.
6. The bot posts the enabled capabilities and the context start date to the group.

The installed pilot requires the bot setup needed for reliable membership checks and conversation ingestion. The Telegram integration owner must prove the minimum rights in a test group. Delete and ban rights are not product requirements.

Conversation collection and proactive responses are separate settings. L/P collects approved group context after activation and answers mentions, commands, and task replies. The full target matches Tag's per-group automatic-response setting on by default after ambient gates pass. A notice states that ordinary captured messages may be stored even when Asmo does not reply. Application filtering cannot claim per-group platform privacy that the bot-wide privacy setting does not provide.

An inactive or removed binding cannot start private-tool work. Guest or unverified use gets general assistance only. It cannot attach to a workspace through a supplied chat ID, username, or Mini App field.

## Message routing

Routing uses Telegram entities, chat IDs, message IDs, reply relationships, and topic IDs. It never relies on the most recently active task or a username string alone.

| Input | Required behavior |
| --- | --- |
| Fresh mention in an activated group | Start a new task in that group and topic. Include the relevant authorized context. |
| Mention that replies to a bot task message | Continue that task. The explicit reply takes precedence over a fresh-task interpretation. |
| Eligible member replies to a bot progress, approval, or result message | Attach the message to the linked task. Record actor and order. |
| Reply to a completed task result | Start a new run on that task with a fresh authority check. Preserve the previous result and effects. |
| Reply to a canceled task | Show that the task is canceled and offer a new task. Do not resurrect canceled effects. |
| Mention that replies to a normal teammate message | Start a new task with that reply chain as context. |
| Ordinary group or topic message | Store only under the collection policy. Treat it as context, not an instruction to every active task. |
| Explicit task ID in a command | Resolve that task within the actor's authorized current context. Deny inaccessible IDs without revealing their content. |
| Several possible task references | Show task choices before any affected external action. |
| Two explicit task IDs with a command intended for one task | Ask for one task choice. Do not send the command to both. |
| Reply chain crosses a forbidden source | Use the authorized portion and show that evidence is unavailable. |
| Anonymous administrator or `sender_chat` requests a sensitive action | Require an identified authorized person. Anonymous display identity cannot approve a write. |
| Bot-authored input | Ignore by default. Later allowed bot integrations require dedupe, depth, and cooldown rules. |

Long-running tasks retain one stable task message where practical. Edits reduce chat noise. New messages carry an important wait, result, or failure. If the original message cannot be edited, a replacement retains the task ID and task association.

## Shared task lifecycle

| State | What the user sees | Allowed next step |
| --- | --- | --- |
| `queued` | Task accepted and waiting for a bounded worker slot. | Stop or inspect. |
| `running` | Current stage, completed steps, and Stop. | Steer or stop. |
| `waiting_for_input` | One concrete missing fact or task choice. | An eligible member supplies it. |
| `waiting_for_approval` | Exact action, approver policy, expiry, and Approve/Revise/Cancel controls. | An authorized actor decides. |
| `blocked` | Access, capability, or budget reason and preserved partial work. | Restore the prerequisite, then resume. |
| `retry_wait` | Temporary failure and next retry policy. | Stop, inspect, or wait. |
| `stopping` | New dispatch blocked, cancellation pending, and any operation in flight. | Inspect or wait. |
| `paused` | Stop acknowledged and completed effects retained. | Resume or cancel. |
| `completed` | Result, accessible sources, artifacts, effects, and actual limitations. | Continue, watch, or start new work. |
| `failed` | Actionable failure, known effects, partial work, and unrun steps. | Retry after fixing the cause or start a new task. |
| `canceled` | Task ended. Completed effects remain visible. | Start a new task. |

Any eligible member in the task's group can steer or stop ordinary shared work. Any eligible member may resume it after current policy and budget checks. Group managers and workspace owners manage grants, collection, and scoped data deletion. L/P also restricts routine activation to managers. Full-target routine controls are defined below. Workspace ownership alone does not bypass a group's source policy.

Stop prevents new model and tool dispatch after the stop event is accepted. The runtime may already have a call in flight. Asmo reports that call and its outcome. It shows `paused` only after cancellation acknowledgment or a stated timeout with the unresolved operation disclosed. Stop does not reverse external effects.

Resume uses saved task state and current policy. It does not repeat a completed write. If an external effect is unknown, reconcile it first. If replay cannot be safe, show `blocked` and require a new reviewed action. Restart and fork are later explicit operations with new sessions, not aliases for resume.

## Steering and edits

Steering belongs to a task and has a durable order. Asmo acknowledges acceptance without promising that an already dispatched operation changed.

If two instructions conflict, Asmo presents the conflict and pauses the affected external action. A manager resolves it when member instructions remain incompatible. The model cannot choose an approver or upgrade an actor's authority.

An edit updates the captured source version and adds a before/after transcript note. Match Tag by requiring a new reply to steer. Adding a mention by edit does not start a task. A changed write proposal invalidates the old approval. An edit after a completed write cannot change that write retroactively. The task shows the completed effect and offers a fresh correction preview if the connector supports it.

Deleting a normal Telegram message is not a reliable request to delete backend copies. `/forget` starts an explicit scoped product workflow. The bot explains this limit in collection settings and deletion help.

## Context and evidence

Answers cite the specific messages, imported records, files, and tool results that support material claims. When a direct Telegram link is unavailable or inaccessible, provide an authorized source record rather than an invented link.

If a question depends on unavailable history, show the collection start or known gap. Ask for the missing message, file, or supported import. Do not claim to have scanned complete group history.

Topics restrict relevance, not security. Cross-topic retrieval within the same group may occur when needed and allowed. Cross-group material requires an explicit workspace sharing policy and permission for the output audience.

In a DM, use the user's workspace-bound private memory and currently authorized team sources only. L and P do not include personal connectors. At the full target, a user's own group request can use that user's connector after permission for the request. A teammate cannot steer the task into using somebody else's personal access. Personal execution context stays separate, and personal sources never enter group memory automatically.

Review mode sends the proposed group output privately to the connector owner, with the exact destination and audience shown. The owner can revise, approve, or cancel. Optional auto mode screens output and holds sensitive content for review. An administrator can require review for all personal-connector output. If private review delivery is unavailable, hold the output and provide a DM setup path. Group progress must not expose private input or tool results. Unattended routines cannot use personal connectors.

## Memory behavior

Match Tag with automatic curated notes and explicit save/correct/forget requests. Eligible group members can inspect and correct group memory. Explicitly product-public groups may save workspace notes. Product-private groups can read approved workspace notes but save only group notes. Individual DMs and small private-group scopes remain separate. L/P automatic notes remain reviewable candidates until the memory evaluation gate passes.

## Exact action review

The preview contains the connector, named resource, operation, full proposed content, visibility, destination, consequential parameters, expected effect, and approver policy. Long content can use a scoped attachment with a stable revision. The button does not approve a vague future action.

For example, an issue preview shows the repository, title, body, labels, assignee if set, and the issue's audience. Approval authorizes that revision of that issue only. Starting a task with "create an issue" authorizes drafting. Under the pilot default, it does not bypass manager review.

The decision expires after the proposed 15-minute lifetime. The backend validates current actor authority, binding, resource grant, policy, action revision, and single-use state. Unauthorized decisions cannot consume an approval. Changed content or revoked access invalidates it. Repeated valid taps show the existing result instead of another issue.

A provider timeout after a possible write produces an unknown effect. Asmo checks provider state before retry. If reconciliation fails, the task shows the uncertainty and does not claim success or issue a blind second write.

## Routines and watches

A routine preview shows its instruction, approved sources, allowed actions, output chat/topic, input timezone, UTC occurrence, owner policy, run budget, and notice policy. Ambiguous times require one concrete clarification. Use an IANA timezone to interpret the request, then match Tag's fixed UTC schedule. Disclose that daylight-saving changes shift its local time. Telegram has no assumed profile timezone. Neither the server timezone nor Asia/Tashkent is a universal product default.

Only a manager can activate group standing work in L/P. The full target matches Tag by allowing eligible members to manage permitted group routines. Shared routines survive creator departure. Schedule activation accepts the displayed interpretation. Each run rechecks current policy, resources, destination, and budget. Removing the bot pauses routines. An owner-visible record explains the failed delivery or lost access.

An unchanged watch stays quiet. A changed watch explains the triggering event and offers Pause. Quiet hours delay notices unless the manager explicitly authorizes urgent events. Resuming a paused schedule starts from the next occurrence by default. It does not post a backlog of missed digests. Issue watches may summarize missed changes once.

## Deterministic commands

Commands address the bot explicitly when Telegram requires it. A missing task ID may resolve from a direct reply to one linked task. Otherwise Asmo presents a task choice.

| Command | Contract |
| --- | --- |
| `/start`, `/help` | Show setup, available capabilities, and current limits. |
| `/settings` | Show authorized settings or an authorized Mini App link after that UI exists. |
| `/status T-184` | Show the permitted task state and effects. |
| `/stop T-184` | Accept stop with the lifecycle behavior above. |
| `/resume T-184` | Recheck policy and resume the saved task. |
| `/memory` | List memory visible in the current scope and its evidence. |
| `/routines` | List current-scope routines with inspection and manager controls. |
| `/forget` | Show scope and dependent content before a destructive deletion decision. |

Natural language remains the main task interface. Command authorization and administration use deterministic checks. The model does not decide whether an actor can administer a group.

## Output and failure copy

Text and inline buttons are the baseline. Rich or ephemeral features may improve the experience only after testing supported clients. Private settings have a DM fallback. Message-length limits use a linked continuation or scoped attachment, preserving task association.

Every incomplete task reports its state and next useful action. Errors exclude credential values and private source content. Budget stops retain partial work and distinguish estimated usage from reconciled charges. A failed Telegram delivery does not change a completed action into unfinished work.

The proposed live responsiveness target is accepted-task acknowledgment within three seconds at the 95th percentile. This is a pilot target, not a measured guarantee. Long work posts a meaningful state change. It does not emit repeated filler progress.
