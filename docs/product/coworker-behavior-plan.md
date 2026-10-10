# Asmo coworker behavior adaptation

Status: option B selected and implemented for the current pilot. Each request receives a short acknowledgement. Simple asks get a separate plain answer. Work still active after eight seconds gets an editable progress message with Stop; tool calls can update its current stage. Final answers remain separate, and settled progress loses its controls. The checklist examples in the mocks are illustrative; this build reports observed stages rather than generating a completed-step checklist.

Research: [official Claude Tag findings](../engineering/claude-tag-behavior-research.md). Comparison: [conversation mocks](asmo-behavior-variants.html), published at https://ajyupbarrrvv.postplan.dev.

## First change

Make visible behavior proportional to the request. Keep durable tasks, scoped evidence, authorization, exact write approval, and recovery internally.

A greeting or short question gets one direct answer linked to its incoming Telegram message. It does not display an accepted receipt, task UUID, completed banner, Stop, Configure, or routine history warning. A capability answer reflects actual tools and grants in that group.

An investigation gets a concrete acknowledgement and truthful progress when those help the group follow the work. Show Stop while work is active. Remove active controls when it completes, pauses, fails, or waits for a separate decision. Avoid stale progress after a faster final answer. The selected mock determines whether the result edits the working message or arrives separately.

A teammate can reply to the answer or progress to continue the same work. Preserve order, prior results, and confirmed effects. Recheck current membership and tool grants. A fresh top-level mention remains a separate request; never attach work to the most recently active task merely because it is recent.

Use a deliberate settings entry, such as /settings, with an authorized Mini App link. Offer access setup when it blocks the requested outcome. Keep manager checks in the application rather than treating a natural-language claim as permission.

## What the current code does

- `src/store/index.ts`, `createTask`, sends an acceptance receipt with the task UUID and Stop for every request.
- `src/store/index.ts`, `finishModel`, prefixes the final answer with task state and appends all limitations.
- `src/providers/responses.ts` adds a generic context-coverage limitation to every response, including a greeting.
- `src/telegram/messenger.ts` adds Configure to every delivery when a Mini App link exists.
- `src/store/index.ts`, message routing and `finishDelivery`, already preserve task links for Telegram replies. Use that mechanism rather than creating a second conversation store.

## Implementation scope

1. Separate conversational presentation from durable task state. Do not introduce a second execution path that bypasses budgets, leases, authorization, or audit events.
2. Make the model's voice direct, proportionate, and aware of current capabilities. Require evidence for substantive claims and specific uncertainty when it affects the answer. Do not treat a friendly system prompt as a guarantee of reliable intelligence.
3. Add deliberate settings navigation. Remove the unconditional Configure footer from ordinary Telegram deliveries.
4. Show active-work controls based on observed work state. Avoid a keyword list that classifies greetings as safe or complex requests as dangerous; presentation does not decide permissions.
5. Deliver results without internal identifiers or state banners. Preserve useful limitations, incomplete output, unsupported attachments, denied access, failed calls, and unknown external outcomes. Keep detailed coverage and audit metadata inspectable.
6. Verify reply mapping, stop behavior, exact approvals, delivery retry, and restart recovery with focused tests. Build and check types before restarting the live bot. Name the live process before touching it.

## Acceptance cases

| Case | Observable result |
| --- | --- |
| Greeting | Exactly one natural answer, linked to the incoming message, with no task-management chrome. |
| Quick rewrite | Only the requested rewrite unless a fact or constraint is missing. |
| Capability question | Describe enabled capabilities. Do not claim GitHub, Notion, web search, repository editing, or unsupported file access. |
| Investigation | Acknowledgement names the intended outcome. Progress reflects completed work, and controls disappear when settled. |
| Correction from another member | Continue the linked work with fresh authority checks. Do not repeat a completed write. |
| Missing earlier history | State the specific unavailable period or source when needed for the answer. Ask for the missing input. |
| Exact external write | Show the destination and exact content. Current manager approval authorizes only that revision. |
| Stop during a provider call | Block further dispatch, preserve confirmed effects, and disclose unresolved in-flight work. |
| Delivery failure | Retry the saved output without rerunning the completed model turn or external write. |
| Unrelated group chatter | Remain quiet under the current mention/reply policy. |
| Fixture preview | Continue to label simulated providers and outcomes. |

## Later work

Coworker behavior needs useful judgment, continuity, and bounded ownership. Evaluate those with real tasks and evidence after the first adaptation. Priorities are scoped corrections that improve later work, broader authorized connector operations, and explicit standing responsibilities. Automatic group replies, automatic memory promotion, personal connector sharing, and broader code execution remain separate features with their own tests and policies.

The public sources do not expose Claude Tag's internal prompt, classifier, or timing threshold. They also disagree on the default for automatic replies. This plan does not enable ambient replies or claim feature parity.

## Verification

130 tests passed after implementation. Backend type checking and compilation passed. A disposable fixture server verified startup, plain acknowledgement delivery, and clean shutdown of the execution and outbox loops. The live process was restarted only after confirming no ready or leased work. A fresh Telegram user message is still needed to verify the new presentation through the full live request path.
