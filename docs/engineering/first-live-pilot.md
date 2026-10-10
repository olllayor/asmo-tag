# Run the first connected pilot

This pilot targets P03 in the acceptance plan. One real Telegram request uses captured group evidence and GitHub issue reads to propose an issue. A current manager reviews its exact content in Telegram. GitHub receives one issue, and Asmo reports its confirmed identity in the originating conversation.

The pilot has not run. The earlier 73-test PostgreSQL milestone is the pre-migration baseline. The [SQLite migration](sqlite-migration-report.md) passed 80 tests. The [current Responses and connector report](responses-connectors-report.md) supersedes it for the current build. Neither result establishes connected success. Repository code inspection and fixes are outside this pilot because the connector currently supports issue reads and issue creation only.

## Supply the dedicated resources

Use a dedicated test bot, a private test group, and an approved test repository. Do not use a daily-driver bot, production group, or production database. Supply the owner Telegram user ID, group chat ID, repository name, and maximum model spend. Confirm that the test group contains only consenting participants and synthetic task data. Automatic data expiry remains unimplemented.

Store credentials in the gitignored `.env.live` file with owner-only permissions. Required model/Telegram credentials are `TELEGRAM_BOT_TOKEN` and `OPENAI_API_KEY`. Configure the GitHub App operator settings in [the setup guide](ai-provider-and-keys.md), including the generated connector vault key. Managers authorize the app and select the test repository through the Mini App. Do not paste an installation token into Asmo. Never paste credentials into chat or evidence files.

Choose a current model ID and its verified uncached-input, cached-input, and output prices. Set task, group, and workspace budgets in integer USD microdollars. One dollar is 1,000,000 microdollars. The model reservation must cover the configured maximum request. `readConfig` checks this bound. The pilot cannot start until the spend limit is supplied.

## Prepare the isolated setup

1. Set `ASMO_DATABASE_PATH` to a separate SQLite file, such as `work/asmo-pilot.sqlite`. Do not point live mode at the fixture file. Live worker discovery is not restricted to the fixture workspace IDs, so sharing that database could dispatch existing synthetic jobs through real providers. SQLite needs no database password or privileged migration account.
2. Initialize the pilot file with `node --env-file=.env.live dist/main.js migrate`. Store startup also applies the SQLite schema migrations.
3. Verify the bot identity, repository access, and owner and bot administrator membership. Do not create an issue during these checks.
4. Record the reviewed workspace seed. It contains one active group scope, no workspace sharing, the owner's membership, empty connector grants, and the approved budgets. Use fresh UUIDs for scope IDs to avoid collisions. The schema accepts nonempty string IDs.
5. Run `node --env-file=.env.live dist/main.js bootstrap /absolute/path/reviewed-seed.json`. Bootstrap posts the collection notice before saving active bindings. If bootstrap fails after posting the notice, inspect saved bindings before retrying. A retry can post the notice again.
6. Set `ASMO_PORT=8788` and `ASMO_HOST=127.0.0.1` in `.env.live`. Start the pilot with `node --env-file=.env.live dist/main.js serve`. This preserves the local preview on port 8787. Without the explicit port setting, the application defaults to 8787.
7. Provide dedicated HTTPS ingress to `/telegram/webhook`. Register the dedicated bot webhook with the configured secret and explicit `message`, `edited_message`, `callback_query`, `my_chat_member`, and `chat_member` updates. Do not drop pending updates silently.
8. Check `/health` through the ingress. It must report `live`. Configure the Mini App client URL and direct link for OAuth account setup. In Configure → Tools and access, choose Connect GitHub, select the test repository, authorize, then return and refresh. Confirm the active repository grant. Subsequent task review and approval can stay in Telegram.

The CLI also reads `.env` if present. Explicit values loaded by Node's `--env-file=.env.live` take precedence. Keep the pilot database and port explicit.

After building, `npm run start:live` runs the same live command without the global pnpm launcher. Blank numeric settings are invalid, including the task budget and model reservation. Set the approved task budget and a reservation that meets the configured request bound. Set all three token prices from the selected provider's current model documentation. Startup reports invalid numeric setting names without printing their values.

## Run one bounded task

Post synthetic evidence in the test group after activation. Mention the actual bot username with this request, replacing the repository and pilot marker:

> @BOT_USERNAME Read the available issues in OWNER/REPOSITORY and the evidence in this conversation. Summarize what is supported and what remains uncertain. Propose one issue titled "[ASMO-PILOT-MARKER] Investigation findings". Keep its body below 1,500 characters, use no labels, and cite your evidence. Do not claim to have inspected repository code or proven that no duplicate exists. Wait for review before creation.

The connector reads a bounded issue page. A missing match does not establish absence. Choose a unique pilot marker and inspect the repository directly before approval.

Inspect the proposed repository, title, full body, labels, and action hash. If Telegram truncates the approval message, do not approve unseen content. Shorten the proposal or inspect the authenticated task view. A current manager then presses Approve once. Do not bypass review using a fixture actor or direct database edits.

## Record the result

Save only redacted evidence. Record the Telegram request and task IDs, approval identity and hash, GitHub issue URL and number, installation identity, final Telegram result, actual token usage and configured cost, and any uncertainty. Inspect GitHub independently and confirm that the approved title/body arrived exactly once.

Mark P03 verified only after the real workflow succeeds. Record other P gates separately. One success does not pass revocation races, Stop during live calls, token renewal, billing reconciliation, retention, or production recovery.

If a write outcome is unknown, hold it for reconciliation. Do not approve a second issue to guess around the failure. At the end, stop the owned pilot process and remove only its dedicated webhook when authorized. Keep pending-update and data-retention decisions explicit.

Primary references: [Telegram webhook registration](https://core.telegram.org/bots/api#setwebhook) and [GitHub issue endpoints](https://docs.github.com/en/rest/issues/issues).
