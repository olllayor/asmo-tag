# Connector handoff and next work

## Objective

Finish and verify GitHub and Notion connections for the `Asmo Tag Dev` Telegram group. Make tools useful in ordinary coworker conversation. Keep setup in Configure, reads direct, and writes subject to review of the exact action. Plan MCP and plugins after the built-in connectors pass live tests.

## Current state

- Repository: `/Users/ollayor/Code/Projects/asmo-tag`.
- Bot: `@asmo_ai_bot`. Pilot group: `Asmo Tag Dev`.
- Public origin: `https://asmo.ollayor.uz`. Local service: `http://localhost:8788`.
- The named Telegram Mini App `asmo` is registered. BotFather confirmed `https://t.me/asmo_ai_bot/asmo`, with website `https://asmo.ollayor.uz/`.
- Both health endpoints, the public Mini App page, and the Configure menu passed the latest recorded checks on 2026-10-09 Asia/Tashkent. Recheck them when resuming.
- The user reports completing GitHub connection. No live issue read or approved issue creation has been verified by this handoff.
- GitHub App credentials are saved privately in ignored `.env.live`. Its PEM is under ignored `work/private/`. Do not print either file or credential-bearing callback URLs.
- Preserve the existing connector vault key. Stored provider credentials depend on it.
- Notion OAuth is implemented. Its operator registration, secret configuration, and group authorization still require verification and setup where absent.
- MCP and plugins are catalog placeholders. They do not execute tools.
- There are existing uncommitted changes from startup and coworker behavior work. Inspect them before editing. Do not overwrite or commit unrelated work.

## Existing capability boundary

| Provider | Implemented tools | Not implemented |
| --- | --- | --- |
| GitHub | `github_read_issues`, `github_create_issue` with approval | Code browsing, cloning, commits, pull requests |
| Notion | `notion_search`, `notion_read_page` | Writes, database queries, nested-block traversal, attachments |
| MCP | None | Server connections, discovery, invocation |
| Plugins | None | Installation and execution |

Notion search matches titles and returns at most 100 matches. Page reads include at most 100 direct blocks and 100,000 text characters. Preserve partial-coverage reporting when it affects the answer.

## Phase 1. Establish the live baseline

1. Read `AGENTS.md`, `docs/engineering/live-connectors-setup.md`, and `docs/engineering/connector-design.md`.
2. Inspect Git status and the existing service supervisor or process. Run only one active worker against the live SQLite database. Do not start duplicate application processes or alter working Cloudflare tunnels.
3. Run `node --env-file=.env.live work/verify-miniapp-launch.mjs`. This checks service and launch configuration, not provider authorization.
4. Open Configure from the group and confirm that the selected scope is `Asmo Tag Dev`.
5. Inspect redacted connection status, selected GitHub repositories, and active tool grants. Record the actual selected repository for later prompts. Do not infer success from installation alone.

Completion: the live service is reachable and the group's actual connector state is known.

## Phase 2. Prove GitHub reads

1. Choose one repository already selected during GitHub installation and authorized in Asmo.
2. Ask the bot in the group to list up to five open issues with number, title, and link.
3. Compare the response with GitHub. An empty repository should produce an accurate empty result, not invented issues.
4. Confirm that a simple read does not require approval or show routine Configure and Stop controls.
5. Use a test repository outside the grant only if one is available and appropriate. Verify that Asmo refuses access without leaking its contents or silently widening permissions.
6. Inspect the GitHub App's requested permissions. Earlier inspection showed extra Pull requests write access. Verify the current setting and remove it if still present and unused. Required access is Issues write and Metadata read. Assess the effect on the active installation before applying the change.

Completion: a real tool read matches GitHub and respects the selected repository boundary.

## Phase 3. Prove GitHub writes and recovery

1. Ask for a disposable test issue in the pilot repository. Specify its exact title and body.
2. Confirm that the review shows the repository, title, and body before execution. Verify that no issue appears before approval.
3. Obtain explicit approval for that exact live action. Submit it once and compare the resulting issue with the approved content.
4. Verify that the result links to the created issue. Check that retry or delivery behavior does not create duplicate issues.
5. Test denial or cancellation before execution. Do not claim Stop reverses an action already completed by GitHub.
6. Exercise expiry and refresh through focused automated tests. Do not wait hours or force expiry of the live connection merely to test it.
7. If reconnect or disconnect needs a live test, coordinate it because it interrupts group access. Verify safe handling of revoked access and a former setup manager's loss of authority.

Completion: one approved write succeeds exactly as reviewed, denial prevents execution, and failure/retry paths have evidence.

## Phase 4. Set up and prove Notion reads

1. Check whether all three Notion operator fields are configured without displaying their values.
2. If absent, register a Notion public OAuth connection using the detailed setup guide. Use callback `https://asmo.ollayor.uz/connectors/notion/callback`.
3. Request Read content only and no user information. Keep write and comment capabilities disabled.
4. Save the OAuth settings privately. Preserve the vault key. If a restart is necessary, restart the existing service once through its established process control.
5. Create or choose a disposable page named `ASMO_CONNECTOR_TEST` with known text. The user or an authorized Notion interface must do this because Asmo has no Notion write tool.
6. Start Connect Notion from the correct group's Mini App. Authorize only the intended page set, then return and refresh connections.
7. Ask Asmo to find the page and summarize its known text. Verify the page identity and content.
8. Verify an inaccessible page stays inaccessible. Check that nested or truncated content is reported honestly rather than presented as complete.
9. Cover refresh, expired state, denied authorization, and disconnect behavior with focused tests and controlled live checks where needed.

Completion: title search and page reading work in the group with the selected page boundary intact.

## Phase 5. Improve connector behavior from evidence

1. Keep normal reads conversational. Do not expose task UUIDs, routine configuration buttons, or irrelevant system limitations in simple replies.
2. Ask a short clarification when the repository or page cannot be determined safely. Use verified group context when it resolves the target.
3. Name the actual failure and useful recovery action for unavailable, unauthorized, expired, rate-limited, or partially read resources.
4. Keep exact-action approval for writes. Keep identity validation and current group membership checks.
5. Fix only failures found during the pilot. Run focused checks for each changed behavior and repeat its live trigger.
6. Update the setup guide with verified outcomes and remaining limits. Record evidence without credentials.

Completion: both connectors work through ordinary group requests, and supported capabilities match the bot's claims.

## Phase 6. Plan MCP and plugins separately

Do not implement these placeholders as part of the initial GitHub/Notion verification.

For MCP, first choose one useful server and a small read-only tool set. Design operator review, transport and authentication, group-scoped grants, tool discovery, schemas, timeouts, size limits, refresh/revocation, and exact approval for future writes. Treat tool descriptions and returned content as untrusted data. Prove one read end to end before expanding.

For plugins, first define the package format and whether a package contains instructions, tools, or both. Design reviewed installation, declared capabilities, pinned versions, scope attachment, disable/uninstall behavior, and execution isolation where code runs. Do not let plugin instructions bypass group authorization or write approval.

Choose the next provider from an actual group workflow. Candidate services need separate implementation and authorization; installing a connector in Codex does not automatically add it to Asmo.

## Working rules for the next agent

- Never print secrets, PEM contents, tokens, or full OAuth callback query strings.
- Inspect existing state before changing it. Do not repeat completed registrations.
- Keep scope and actor authorization checks intact.
- Use computer use for provider and Telegram UI when available. Native coordinate clicks previously failed with `noWindowsAvailable`; keyboard navigation worked. Report that limitation rather than claiming a launch passed.
- Do not create test issues, pages, or external messages without explicit authorization for those actions. Prepare the exact write for review first.
- Report user-confirmed setup separately from agent-verified tool execution.
- Finish with the verified capabilities, tests performed, remaining gaps, and the next concrete action.

## Simple GitHub read prompt

Replace `OWNER/REPO` with an installed, authorized repository.

```text
@asmo_ai_bot List up to 5 open issues in OWNER/REPO. Include each issue's number, title, and link. If there are none, say so.
```
