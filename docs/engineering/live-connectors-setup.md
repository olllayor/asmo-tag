# Connect GitHub and Notion to Asmo Tag

This guide targets `@asmo_ai_bot` and the `Asmo Tag Dev` group at `https://asmo.ollayor.uz`. It describes the connector code inspected on 2026-10-08. On 2026-10-09, read-only verification confirmed the saved GitHub connection, active repository grant, current setup actor authority, and a live adapter read for `olllayor/asmo-tag`. GitHub writes and Notion live reads remain unverified. See [the pilot evidence and pending external writes](connector-pilot-review.md).

Asmo already implements GitHub App authorization and Notion public OAuth. Group members do not need personal access tokens. The deployment operator registers the provider applications once. A group owner or manager then connects accounts and chooses resources through the Telegram Mini App.

## What works in this build

| Connector | Available work | Required provider access |
| --- | --- | --- |
| GitHub | Read issues and create an issue after approval | Repository Issues read and write; Metadata read |
| Notion | Search page titles and read page text | Read content on pages selected during OAuth |
| MCP and plugins | Unavailable | Separate implementation required |

GitHub code browsing, repository cloning, commits, pull requests, and Notion writes are not implemented. Registering broader provider permissions will not add those tools. The current tool names are `github_read_issues`, `github_create_issue`, `notion_search`, and `notion_read_page`.

The implementation lives in [the catalog](../../src/integrations/catalog.ts), [the GitHub adapter](../../src/integrations/github.ts), [the Notion adapter](../../src/integrations/notion.ts), and [the tool dispatcher](../../src/integrations/tool-connector.ts). See [the connector design](connector-design.md) for the authorization model.

## Prepare the deployment

1. Confirm that the public HTTPS origin routes `/connectors/github/callback` and `/connectors/notion/callback` to the same Asmo process that serves Telegram and the Mini App. These routes must accept provider redirects without a Cloudflare login challenge. Do not exempt unrelated routes from existing access rules.
2. Keep the existing `ASMO_CONNECTOR_VAULT_KEY` if one is configured. Only if it is absent, generate one random 32-byte value and save its base64 encoding in the deployment's secret configuration. Use a secret manager or write directly to a protected file. Do not print the key in terminal output or paste it into chat.
3. Preserve that key across restarts and keep a separate protected backup. Asmo encrypts provider credentials in SQLite with this key. Changing or losing the key prevents existing credentials from decrypting. No key-rotation migration exists.
4. Check that the Telegram Mini App opens for a current group manager. Its configuration page must identify `Asmo Tag Dev`. Opening the website in a regular browser does not supply verified Telegram Mini App identity.

The server validates callback URLs in [config.ts](../../src/integrations/config.ts). Public callbacks require HTTPS and cannot include credentials, query parameters, or fragments. A bare callback request without valid OAuth state is expected to fail. That failure alone does not establish that the callback is misconfigured.

## Register the GitHub App once

1. Open [GitHub App registration](https://github.com/settings/apps/new) under the account or organization that should own Asmo's application.
2. Choose a unique app name. Set its homepage to `https://asmo.ollayor.uz`.
3. Set the OAuth callback URL to `https://asmo.ollayor.uz/connectors/github/callback`.
4. Keep expiring user authorization tokens enabled. Asmo requires the access-token expiry and refresh-token fields returned by that mode.
5. Disable OAuth authorization during installation. Asmo starts its own OAuth step after installation.
6. Set the setup URL to `https://asmo.ollayor.uz/connectors/github/callback` too. Leave redirect-on-update disabled for this pilot. An unsolicited update redirect has no Asmo linking state.
7. Disable GitHub webhook delivery. Asmo has no GitHub event handler. `/telegram/webhook` accepts Telegram updates only.
8. Grant repository Issues read and write. Keep the automatically required Metadata read permission. Leave other repository, organization, and account permissions unrequested.
9. Choose visibility that allows the intended GitHub accounts to install the app. A private app is suitable only if its allowed installation accounts cover this pilot.
10. Create the app, generate a client secret, and generate an RSA private key. Store the values directly in deployment secrets using the table below. Record the app slug from its `github.com/apps/<slug>` URL.

These choices follow [GitHub's registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) and Asmo's existing two-stage flow. GitHub distinguishes the [setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url) from the OAuth callback. Asmo handles both stages on the same route.

| Environment variable | Value to save |
| --- | --- |
| `ASMO_GITHUB_APP_ID` | Numeric App ID, not the OAuth client ID |
| `ASMO_GITHUB_CLIENT_ID` | GitHub App client ID |
| `ASMO_GITHUB_CLIENT_SECRET` | Generated client secret |
| `ASMO_GITHUB_PRIVATE_KEY` | Generated RSA private key PEM |
| `ASMO_GITHUB_APP_SLUG` | Exact app URL slug |
| `ASMO_GITHUB_CALLBACK_URL` | `https://asmo.ollayor.uz/connectors/github/callback` |

The private-key setting accepts actual newlines or literal `\n` separators. Configure all six GitHub fields together. A partially configured provider prevents startup. A configured provider also requires the vault key.

Asmo verifies installation ownership through GitHub's user authorization flow before saving access. It restricts the installation token to verified repositories and requests only Issues write and Metadata read. Select a small pilot repository set. The implementation allows at most 500 repositories. See GitHub's [user-token flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) and [restricted installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

## Register the Notion public connection once

1. Open Notion's Developer portal and choose Public connections in the Build section.
2. Create a public connection with Asmo's name and the intended development workspace.
3. Choose installation scope. Selected workspaces only fits a restricted pilot. Any workspace fits later use across customer workspaces. Notion does not allow changing this choice after creation.
4. Add `https://asmo.ollayor.uz/connectors/notion/callback` as its OAuth redirect URI.
5. Enable Read content. Disable Update content, Insert content, and comment capabilities. Select No user information. Asmo's reader does not use user information.
6. Retrieve the OAuth client ID and client secret from Configuration. Save the following settings in deployment secrets.

| Environment variable | Value to save |
| --- | --- |
| `ASMO_NOTION_CLIENT_ID` | Public connection OAuth client ID |
| `ASMO_NOTION_CLIENT_SECRET` | Public connection OAuth client secret |
| `ASMO_NOTION_CALLBACK_URL` | `https://asmo.ollayor.uz/connectors/notion/callback` |

Configure all three Notion fields together. An internal connection token or personal access token does not replace this OAuth configuration.

Notion documents [public connection registration and installation scope](https://developers.notion.com/guides/get-started/public-connections), [capability choices](https://developers.notion.com/reference/capabilities), and [OAuth authorization with refresh tokens](https://developers.notion.com/guides/get-started/authorization). Asmo requires an access token, refresh token, bot ID, and workspace ID in the exchange response. It uses API version `2026-03-11`.

## Connect accounts to Asmo Tag Dev

The deployment operator must first add the settings and restart the existing Asmo service. This changes the live service and requires a planned restart. Use its existing process supervisor. Do not start a second worker against the same live SQLite database. The repository's `start:live` package script loads `.env.live`. On this workstation, `npm run start:live` bypasses the broken global pnpm launcher. Use it only after stopping the existing process.

After that restart, the group owner or manager completes these steps:

1. Open Asmo's Telegram Mini App and select `Asmo Tag Dev`.
2. Open Configure, then Tools and access.
3. Check that GitHub and Notion show Available rather than Operator setup needed.
4. Select Connect for GitHub. Choose the intended GitHub account or organization and select only the pilot repositories. Complete both installation and account authorization. An organization owner may need to approve installation.
5. Wait for Asmo's Connected page. Return to Telegram and select Refresh connections. Confirm the saved GitHub account and repository names.
6. Select Connect for Notion. Choose the workspace and a disposable pilot page. Select only pages the group should access. Selecting a parent page also grants its children.
7. Return from the Connected page and refresh again. Confirm the Notion workspace and active Notion selected-pages grant.

Start each connection from the Mini App. A provider installation opened directly from a saved GitHub or Notion link does not include Asmo's actor-bound, ten-minute OAuth state. If authorization expires or is denied, restart with Connect. Do not reuse a callback URL from browser history.

Owners and managers can connect, reconnect, or disconnect group tools. Members can inspect redacted connection status and use granted resources. A group connection shares the manager's selected resources with that group. Each DM or group has its own connections. No connection carries over automatically to another scope.

## Verify the connection

1. Check that `http://localhost:8788/health` and `https://asmo.ollayor.uz/health` return HTTP 200 with `{"mode":"live"}`. This checks service reachability only. It does not prove provider authorization works.
2. Verify Connected status and the expected account in Tools and access. Check that repository or Notion grants are active in Approved tools.
3. In the group, ask `@asmo_ai_bot List the open issues in OWNER/REPOSITORY.` Use a selected pilot repository and compare the answer with GitHub. This is a read test.
4. Ask `@asmo_ai_bot Find the Notion page titled ASMO_CONNECTOR_TEST and summarize it.` Use an accessible test page with known text. Check that the answer matches the page and identifies any partial coverage.
5. If issue creation needs a live test, explicitly request a disposable issue in the pilot repository. Review its exact repository, title, and body before approving. This step creates real provider data. Reading issues successfully does not establish that writes work.

The 2026-10-09 live GitHub adapter read returned zero issues, matching a direct open-issue API check. This did not exercise the group model and delivery path. Notion operator settings were absent, and unused Pull requests write permission remained on the GitHub App. Existing integration tests use mocked HTTPS responses. See [integrations.test.ts](../../tests/integrations.test.ts). The remaining live checks and exact proposed writes are in [the pilot review](connector-pilot-review.md).

## Troubleshooting and limits

| Observation | Check or next action |
| --- | --- |
| Operator setup needed | Supply every field for that provider plus the vault key, then restart the existing service. |
| Authorization fails immediately | Compare the registered callback with the exact URL above. Check the app ID versus client ID, app slug, permissions, and GitHub token-expiry mode. Do not copy secret values or full callback query strings into logs or chat. |
| Invalid or expired state | Start Connect again from the correct group. The state is single-use and lasts ten minutes. A newer attempt invalidates the previous one. |
| Notion returns no page | Check the selected workspace and page grant. Search matches page titles, not arbitrary body text. The connecting user needs enough Notion access to share the page. |
| GitHub omits a repository | Confirm installation selection and the authorizing user's access. For SAML organizations, establish the required SSO session before reconnecting. |
| Needs reconnect | A refresh failed or operator configuration is unavailable. Reconnect as a current manager after fixing that cause. |
| A former manager's connection stops working | Reconnect through a current owner or manager. Tool use checks the original setup actor's current Asmo authority. |

Notion search returns at most 100 title matches. Page reads include at most 100 direct blocks and 100,000 text characters. Nested blocks, attachments, linked pages, and database queries are not read. The adapter reports partial coverage. See [notion-reader.ts](../../src/integrations/notion-reader.ts).

Disconnect erases Asmo's stored credential and fences local grants. It does not uninstall the GitHub App or revoke the Notion connection at the provider. Provider-side removal remains a separate account-settings action. Provider webhook revocation handling is absent, so this build cannot promise immediate event-driven revocation. It refreshes and checks access during tool use.

Run one active application and connector worker process. OAuth refresh coordination is in-process only. Multi-process deployments need additional coordination before sharing rotating credentials.
