# Claude Tag interaction research

Reviewed on 2026-10-08. This note summarizes opened Anthropic sources. It does not claim hands-on access to Claude Tag or describe Asmo features as implemented.

## What the official material establishes

### A mention does not always create a visible task

[Control when Claude Tag responds](https://claude.com/docs/claude-tag/users/when-claude-responds) says a mention receives a reaction within a few seconds. The channel session can answer directly in a thread. It creates a working session when the request needs investigation, tools, or a longer exchange. Only that working session gets the working indicator with Stop. A reaction without an indicator can mean Claude is deciding or answering directly.

For untagged channel messages, the documented choices are to do nothing, answer briefly from existing knowledge, start authorized work, or pass new information to an existing task. Silence is the usual choice. The current docs say automatic replies are enabled by default, but substantial untagged work requires instructions covering that work.

### Progress fits the size of the work

[How Claude Tag works](https://claude.com/docs/claude-tag/concepts/how-it-works) distinguishes direct answers for questions and one-off requests from checklists for longer work. The checklist updates in place. The illustrated longer task starts with a brief acknowledgement, then goes quiet while the work proceeds. A blocked task usually gets an explanatory reply.

Anyone in the channel can steer an active task by replying in its thread without another mention. Stop preserves the session context and names who stopped the task. Mentioning Claude again can resume or redirect it. Each task thread keeps its conversation when its temporary working environment ends.

### Settings links are part of Claude Tag itself

[Get started](https://claude.com/docs/claude-tag/users/getting-started) says channel replies have a model footer and Configure link. DMs and organization-shared channels do not have Configure. When a person first adds Claude to an eligible channel, Claude introduces itself and suggests work based on channel context.

The [first Academy lesson](https://academy.claude.com/courses/introduction-to-claude-tag/tag-claude-and-see-what-happens) also explicitly places Configure under each reply. Therefore removing permanent Configure buttons from Asmo is a Telegram design decision, not a behavior proven absent from Claude Tag. A large Telegram inline keyboard is also a different visual treatment from a Slack footer link.

### It owns outcomes and accepts correction

[Best practices for using Claude Tag](https://academy.claude.com/tutorials/best-practices-using-claude-tag) describes shared work that continues while people are away. Teammates can add context and redirect it. Channel corrections and preferences influence later work. Admin-managed channel connections are separate from personal DM connections.

[Tasks to try](https://academy.claude.com/tutorials/tasks-to-try-with-claude-tag-in-your-workspace) says most questions finish in seconds. Bigger work needs an immediate acknowledgement, background execution, and progress. Output takes the form that fits the task, including an ordinary reply, file, chart, page, or completed action in a connected tool. The result returns to the same thread. Source-backed answers identify the messages, documents, accounts, or queries behind them.

### Uncertainty should support review

[Write a request Claude can work with](https://academy.claude.com/courses/introduction-to-claude-tag/write-a-request-claude-can-work-with) recommends asking for verification, source links, and separation between verified findings and inferences. Longer tasks update one progress message. New replies announce decisions, blockers, or results. Claude waits when it asks a question.

[Good habits](https://claude.com/docs/claude-tag/users/good-habits) recommends observable completion criteria and evidence such as source links, charts, test results, or diffs. Constraints in conversation guide behavior but do not enforce permissions. Important restrictions need external controls.

### Proactivity needs a defined job

The [Academy proactivity lesson](https://academy.claude.com/courses/introduction-to-claude-tag/proactivity-let-claude-reply-without-being-tagged) teaches channel-specific rules about which messages to answer and which to ignore. Examples exclude scheduling and social chatter. A standing responsibility can last for days or weeks. Channel instructions take precedence over remembered preferences.

The [best-practices tutorial](https://academy.claude.com/tutorials/best-practices-using-claude-tag) describes mention-only behavior as the default. This conflicts with the current response-control documentation's default-on automatic replies. Treat defaults as version-sensitive. Do not silently import one into Asmo.

### Memory belongs to the conversation's scope

[What Claude Tag remembers](https://claude.com/docs/claude-tag/users/memory) describes curated channel notes, separate workspace notes learned from public channels, and separate private conversation notes. People can ask what Claude remembers, correct it, or request deletion. Private channel notes do not become workspace notes. Stable preferences and facts belong in memory; a running event log does not.

## Proposed Asmo adaptation

These are recommendations derived from the sources and the user's goal. They are not claims about Claude Tag internals or shipped Asmo behavior.

| Situation | Proposed Asmo behavior |
| --- | --- |
| Greeting, capability question, short rewrite | Reply naturally to the message. Keep internal task IDs out of chat. No acceptance or completion banner. |
| Work lasts long enough to need feedback | Send typing or a reaction if supported. Add a short acknowledgement only when useful. Avoid duplicate notifications for a fast result. |
| Investigation or substantial tool work | Acknowledge the concrete outcome. Show one progress message edited in place. Show Stop only while work is active. |
| Finished work | Lead with the result and evidence. Remove active controls. Keep settings reachable through a deliberate command or menu. |
| Relevant missing context | State the specific gap only when it affects the answer. Ask for the missing source if required. Avoid a generic capture timestamp on every answer. |
| Reply to Asmo or an active task | Continue the existing work with shared context. Do not require another mention or start over. |
| Social chatter and unrelated group messages | Stay quiet. Enable untagged help only under an explicit group policy. |
| Existing authorization | Complete the authorized work. Ask only for decisions or access that are actually missing. Enforce consequential permissions outside the model. |
| Connector question | Report actual enabled capabilities and missing connections. Do not imply access from the owner's personal permissions. |

An intelligent coworker needs continuity, useful judgment, evidence, and clear boundaries. Removing buttons alone does not provide those capabilities. The first visible improvement should be proportionate responses. The later implementation should preserve cancellation, auditability, and authorization internally.

## Limits of this research

Some Academy sections contain interactive content that the web reader reports as loading. The concrete rules above come from readable prose and the official product documentation. I did not inspect the rendered Slack UI or exercise a live Claude Tag workspace. The sources do not specify a universal acknowledgement delay, a request-complexity classifier, or the exact internal prompt. Asmo must choose and test those mechanisms itself.
