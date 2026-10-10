# Connector pilot verification and pending writes

Verified on 2026-10-09, Asia/Tashkent. No external writes in this packet have been submitted.

## Verified state

- One Asmo listener serves port 8788, PID 64017, from this repository. No application process was started or restarted.
- Local and public health endpoints returned HTTP 200 in live mode. The public Mini App page, bot identity, Configure menu, and configured named-app link passed `node --env-file=.env.live work/verify-miniapp-launch.mjs`.
- Telegram's `has_main_web_app` flag was false. The named app is separate. Native Configure launch was not verified in this run.
- A read-only SQLite inspection found GitHub connected to `Asmo Tag Dev` as `olllayor`, credential version 1. Its sole repository is `olllayor/asmo-tag`. The active read/write grant references that connection and version.
- Telegram `getChatMember` confirmed that the connection's setup actor is still the group's creator.
- The existing vault key decrypted the saved GitHub credential. Both installation and user access tokens were unexpired during verification. No tokens were refreshed or replaced.
- GitHub App and installation GETs returned HTTP 200. The installation is not suspended and uses selected repositories. The user-accessible installation repository list contains only `olllayor/asmo-tag`.
- A direct open-issue GET returned zero issues. The existing Asmo GitHub adapter also returned zero issues. Its receipt limits coverage to the first page of at most 100 issues and pull requests. These checks exercised provider access and the adapter, not the group model/approval/delivery path.
- The adapter rejected the synthetic repository `asmo-verification-denied/not-authorized` before any provider request. No outside repository content was requested.
- Both app registration and installation currently have Issues write, Metadata read, and unused Pull requests write permissions.
- All three Notion operator fields are absent from `.env.live`. No Notion connection exists in the live database. This does not prove no provider-side registration exists.
- The Notion developer portal opened but remained on loading placeholders. Its existing connection inventory and available workspace names could not be verified. Do not create a duplicate connection without inspecting that inventory.

The live database was opened read-only. Credentials, the vault key, Cloudflare processes, the running application, and existing uncommitted code were not changed. No group messages, issues, pages, registrations, or permission changes were submitted. MCP and plugins remain a separate follow-up.

## Checks

### Notion configuration and approved restart

On 2026-10-09, the user supplied the existing Notion OAuth credentials and authorized saving them. The three operator fields were appended to ignored `.env.live`. Existing file contents were preserved, file permissions were set to `0600`, and configuration validation passed without displaying credentials.

The user then authorized a live service restart. The old detached Node process, PID 64017, exited after SIGTERM. Its replacement, PID 82439, runs the same existing compiled command, `node --env-file=.env.live dist/main.js serve`, from this repository. No rebuild occurred. No launchd supervisor was found for Asmo. Logs remain in private `work/asmo-live.log`.

The replacement was the sole listener on `127.0.0.1:8788`. Local and public health, the public Mini App page, bot identity, Configure menu, and configured named-app link passed again at 12:01 Asia/Tashkent. The GitHub connection remained connected at credential version 1 with the same repository. Cloudflare processes were not changed. The new process loads the Notion operator settings, but Notion group OAuth and a live read still remain pending. GitHub permission reduction and pilot messages have not been approved.

These commands passed using the installed project dependencies:

```sh
./node_modules/.bin/vitest run tests/integrations.test.ts tests/recovery.test.ts tests/telegram.test.ts
./node_modules/.bin/vitest run tests/providers.test.ts tests/store.test.ts
./node_modules/.bin/tsc --noEmit
```

The five test files passed 99 tests. They cover mocked OAuth/refresh failures, scope and credential fencing, exact and expired approvals, recovery, and connector behavior. They do not establish live GitHub writes or live Notion reads.

## Approval A: GitHub permission reduction

Destination: GitHub App `asmo-tag`, repository permissions.

| Permission | Current | Proposed |
| --- | --- | --- |
| Issues | Read and write | Read and write |
| Metadata | Read-only | Read-only |
| Pull requests | Read and write | No access |

Save this permission reduction only. Leave repository selection, OAuth settings, keys, webhooks, and visibility unchanged. GitHub says removal takes effect immediately. Asmo's installation-token requests already request only Issues write and Metadata read, so the implemented issue tools should continue working. Recheck installation permissions and issue reads after saving. Do not disconnect or reinstall as part of this action.

Source: [GitHub App modification guide](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration#changing-the-permissions-of-a-github-app).

## Approval B: Telegram GitHub pilot messages

Destination for each message: `Asmo Tag Dev`, addressed to `@asmo_ai_bot`.

First send this read request and compare the result with GitHub:

```text
@asmo_ai_bot List up to 5 open issues in olllayor/asmo-tag. Include each issue's number, title, and link. If there are none, say so.
```

Then prepare one issue through Asmo's review flow:

```text
@asmo_ai_bot Prepare one issue in olllayor/asmo-tag for approval. Use exactly this title: ASMO_CONNECTOR_TEST: approved issue creation. Use exactly this body: Disposable connector test for Asmo Tag Dev on 2026-10-09. This issue verifies exact-action approval and a single GitHub creation. Use no labels. Show the repository, title, and body before execution and wait for approval.
```

Desired issue fields:

```json
{
  "repository": "olllayor/asmo-tag",
  "title": "ASMO_CONNECTOR_TEST: approved issue creation",
  "body": "Disposable connector test for Asmo Tag Dev on 2026-10-09. This issue verifies exact-action approval and a single GitHub creation.",
  "labels": []
}
```

Approval B authorizes these Telegram messages only. Do not approve or create the GitHub issue yet. Inspect the actual prepared effect and review before asking for approval of that exact live issue. The connector appends two newlines and a generated HTML correlation comment to the body for recovery. Include that actual suffix in the final provider-payload review once the effect exists.

For denial testing, prepare this separate action and deny it in Asmo:

```text
@asmo_ai_bot Prepare one issue in olllayor/asmo-tag for approval. Use exactly this title: ASMO_CONNECTOR_TEST: denied issue must not exist. Use exactly this body: Disposable denial test for Asmo Tag Dev on 2026-10-09. This issue must not be created. Use no labels. Wait for approval.
```

Approval B also authorizes sending this denial-test message and denying its resulting approval. It never authorizes creating the denial-test issue. Confirm both test titles are absent before starting. After approval of the real write, verify its issue link and exact payload, then verify the denial title remains absent. Any cleanup is a separate write.

## Notion setup proposal, pending workspace selection

The workspace name and existing registration inventory must be resolved before this proposal is ready for final approval.

| Field | Proposed value |
| --- | --- |
| Connection name | Asmo Tag Dev |
| Authentication | Public OAuth |
| Installation scope | Selected workspaces only, limited to the user-selected pilot workspace |
| Redirect URI | `https://asmo.ollayor.uz/connectors/notion/callback` |
| Content | Read content only |
| Comments | All disabled |
| User information | No user information |
| Page title | `ASMO_CONNECTOR_TEST` |
| One paragraph of page text | `Asmo connector verification on 2026-10-09. The project codename is Copper Finch. The launch checklist has seven items. This page is disposable test content.` |
| Page sharing | Private workspace page, no public link |
| Asmo scope | Asmo Tag Dev |
| OAuth page selection | Only the test page, with no children |

Reuse an existing suitable registration if one exists. Do not rotate its secret. The selected-workspace installation scope is permanent for a newly created connection. Request a fresh approval if the form requires additional publication details, terms, or access. Notion setup and page authorization create access, so obtain action-time confirmation before submitting consent.

Sources: [Notion public connections](https://developers.notion.com/guides/get-started/public-connections) and [connection capabilities](https://developers.notion.com/reference/capabilities).

After approval, save only the three Notion operator fields privately while preserving all existing environment values and the vault key. Identify the established service supervisor, then name and obtain approval for one live restart before performing it. (In this pilot run, no launchd service supervisor was found; the live service was restarted as an approved detached Node process replacement from PID 64017 to PID 82439.)

After group authorization, seek approval to send this exact read-test message:

```text
@asmo_ai_bot Find the Notion page titled ASMO_CONNECTOR_TEST and summarize its text. Include the page link and report any partial coverage.
```

Expected content includes Copper Finch and seven checklist items. Also verify inaccessible-page refusal and partial-coverage handling. Live revocation, reconnect, and disconnect tests interrupt access and require a separately reviewed action. Do not claim these tests have passed yet.
