# Wave 1 live check

Status: prepared, not run. This procedure tests P03 and the GitHub portion of P05. It uses the [local write proof](wave1-write-proof.md) and records limits against the [acceptance plan](../product/acceptance-plan.md).

## Select resources

The user must select the disposable GitHub repository, disposable Telegram chat, and total model spend cap. Once selected, existing authorization covers setup, test messages, one reviewed issue, revocation, and restart of the owned disposable pilot. Manager approval of the exact issue remains a product requirement.

| User choice | Pending value |
| --- | --- |
| Disposable repository | `<OWNER/REPOSITORY>` |
| Disposable Telegram chat | `<TEST_CHAT>` |
| Total model spend, integer USD microdollars | `<RUN_CAP_MICROS>` |

The operator fills or discovers the remaining identifiers: source commit, isolated build/run paths, fresh workspace/scope IDs, bot username/ID, chat ID, consenting owner/manager/member/steering-member IDs, installation/connection/grant IDs and versions, dedicated port/ingress/Mini App route, owned process PID, and unique `<RUN_ID>`. Record model ID, configured prices, reservation, task budgets, token/turn limits, and retention owner/date. Do not infer that `Asmo Tag Dev`, `olllayor/asmo-tag`, or an existing database is disposable.

## Setup

1. Verify the source commit with local checks. Build into isolated paths. Preserve daily-driver `dist`, previews, processes, and databases.
2. Create a separate SQLite file containing only this pilot. Live discovery can dispatch every workspace in its database. Use an owned run directory without an unrelated `.env`, since the CLI loads that file too.
3. Store credentials in the selected owner-only configuration file. Set live mode, database path, host, port, model, and budgets explicitly. Workspace/group budgets must not exceed the total cap. Task limits and the model reservation must satisfy `readConfig`.
4. Follow [first-pilot setup](first-live-pilot.md) using these selected resources for bootstrap, collection notice, dedicated webhook, HTTPS health check, and Mini App. Verify current bot/owner administrator membership and consenting participants. Connect only the selected GitHub repository. Record actual installation, connection/version, and grant/revision values. Create no routines or other connections.
5. Record the owned pilot process and launch configuration. Inspect GitHub independently for all run markers before starting. A bounded connector listing cannot prove absence. If a marker exists, choose a fresh run ID before drafting.

Freeze substitutions in the messages below before use. Never save credentials, webhook secrets, or signed Mini App authentication in evidence.

## P03: read, steer, approve once

Post these synthetic evidence messages after collection activation:

```text
Wave 1 <RUN_ID> synthetic evidence A. A test checkout returned HTTP 422 when two test coupons were supplied. One test coupon succeeded. No repository code was inspected.
```

```text
Wave 1 <RUN_ID> synthetic evidence B. The cause is unconfirmed. This check exercises Telegram task routing and exact manager-reviewed issue creation only.
```

The requesting member posts:

```text
@<BOT_USERNAME> Read the available issues in <OWNER/REPOSITORY> and summarize the two Wave 1 <RUN_ID> synthetic evidence messages. Cite the captured sources. State the uncertain cause and the bounded issue-list coverage. Do not draft or create an issue yet.
```

Wait for the cited answer. Check actual retrieved sources and tool records for the selected scope/repository. Record its task and answer message IDs. The steering member replies to that answer:

```text
Draft one GitHub issue in <OWNER/REPOSITORY> for manager review. Use the exact title and body below, with an empty labels array. Keep citations in your explanation outside the issue body. Do not change the body or create the issue before approval.

Title: [ASMO-W1-<RUN_ID>-P03] Synthetic checkout investigation
Body:
Disposable Asmo Wave 1 live check. Run ID: <RUN_ID>.

Synthetic observation: a test checkout returned HTTP 422 when two test coupons were supplied. One test coupon succeeded.

The cause is unconfirmed. No repository code was inspected. The issue-list check is bounded and does not prove that no duplicate exists.

Purpose: verify one exact manager-reviewed issue creation and its durable receipt. No production incident or customer data is involved.
```

Require the same task, higher revision, and ordered steering history. Inspect the full saved repository, exact title, four-paragraph body without `Body:`, labels `[]`, effect ID, approval ID, hash, and connection/version binding. Do not approve truncated, mismatched, or expired content. Approval expires after 15 minutes.

| Actor/action on this approval | Expected receipt and saved result |
| --- | --- |
| Non-manager taps Approve | `denied`; approval stays pending; no issue |
| Manager taps Approve once | `accepted`; exact write dispatches |
| Manager repeats Approve | `duplicate`; no additional write |
| Manager then taps Deny | `duplicate`; approval stays approved |

The denied callback toast is `Action denied. Refresh the task.` Other callbacks acknowledge `Decision received. Check saved task state.` Verify persisted state, not just the toast. Fresh repeated taps test decision deduplication. Exact replay of the same update remains unrun unless the selected ingress already supports secure capture/replay. Do not fabricate identities or authentication.

Require one P03 GitHub issue, one successful write effect/event, and one write tool source. Confirm actual provider ID, issue number/URL, originating Telegram result, permitted citations, and live usage. Compare GitHub's raw body with the exact reviewed body plus two newlines and `<!-- asmo-effect:<EFFECT_KEY>:<EFFECT_FINGERPRINT> -->`, calculated from the saved effect by `correlationMarker`. Labels must be empty. Independent repository inspection must find exactly one matching title and marker.

## Negative controls

Start each draft as a new mentioned task. Inspect its exact payload; none may create an issue.

```text
@<BOT_USERNAME> Draft one GitHub issue in <OWNER/REPOSITORY> for manager review only. Use title "[ASMO-W1-<RUN_ID>-D01] Denied write control", body "Disposable Asmo Wave 1 denied-write control. Run ID: <RUN_ID>. This draft must never create a GitHub issue.", and labels []. Do not create it before approval.
```

Manager taps Deny, repeats Deny, then taps Approve. Expect `accepted`, `duplicate`, `duplicate`. Approval/effect stay denied, with zero write dispatches and zero D01 issues.

```text
@<BOT_USERNAME> Draft one GitHub issue in <OWNER/REPOSITORY> for manager review only. Use title "[ASMO-W1-<RUN_ID>-R01] Revoked grant control", body "Disposable Asmo Wave 1 grant-revocation control. Run ID: <RUN_ID>. This draft must never create a GitHub issue.", and labels []. Do not create it before approval.
```

Keep approval pending. Manager uses Configure's Revoke grant and confirms that exact grant. Require an accepted command, inactive grant with increased revision, `grant_revoked`, invalidated approval, and denied undispatched effect. Stale Approve must return `denied`. Require zero R01 issues and no subsequent GitHub dispatch through that grant. This tests pending revocation, not the narrower approved-before-HTTP race.

Reconnect only the same disposable repository after R01 settles. Record fresh authorization/version values; do not revive an old approval.

```text
@<BOT_USERNAME> Draft one GitHub issue in <OWNER/REPOSITORY> for manager review only. Use title "[ASMO-W1-<RUN_ID>-R02] Disconnected connection control", body "Disposable Asmo Wave 1 connection-disconnect control. Run ID: <RUN_ID>. This draft must never create a GitHub issue.", and labels []. Do not create it before approval.
```

Keep approval pending. Manager disconnects the exact connection through Tools and access. Require disconnected status, increased credential version, inactive grants, `connector_grants_disconnected`, invalidated approval, and denied undispatched effect. Stale Approve returns `denied`. Require zero R02 issues and no credential-backed calls after disconnect. A partial disconnect stops the run.

## Restart and evidence

Wait for tasks to settle with no in-flight calls. Record P03's known receipt. SIGTERM only the recorded owned PID, wait for exit, then restart the same build/configuration/database. Do not bootstrap again or reconnect.

Require P03's successful effect/provider identity to survive and revoked/disconnected states to remain fenced. Fresh P03 Approve and Deny callbacks now return `denied`, because grant changes invalidate approved approvals even after successful effects. Stale R02 Approve also returns `denied`. Reply `/status` to P03's answer; it must stay on that task without model work or another write. Total issues across all four titles must remain one.

| Record | Required evidence |
| --- | --- |
| Execution | Commit, live mode, selected IDs, owned process/build, exact messages |
| Authority | Task revisions, approval/effect hashes, grant revisions, connection versions, relevant receipts/events |
| Result | Provider identity, raw-body/labels comparison, independent issue counts, Telegram timing |
| Cost | Token usage, configured cost, estimates separated from final usage |

Stop on wrong destinations, unseen/mismatched payloads, unauthorized decisions, denied-action dispatch, duplicates, stale access, lost receipts, unknown outcomes, unverifiable scope, or budget exhaustion. Preserve records; do not blindly retry, edit database state, remove markers, reconnect around failure, or raise limits.

A normal restart proves known-receipt persistence. Live lost-receipt fault injection, member/bot removal, routines, output revocation, client coverage, and billing remain unrun. Pass P03 only with all its evidence. Do not mark all P05/P04/P02/P10 passed. Stop the owned process afterward. Apply the recorded cleanup/retention choice only to selected resources; preserve unresolved effects.
