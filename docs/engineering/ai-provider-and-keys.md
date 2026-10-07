# AI provider and operator setup

Asmo now uses OpenAI Responses for live model requests. Asmo owns its task loop, spending holds, approvals, and recovery. Telegram users do not create model API keys. The operator configures the bot once; users connect GitHub or Notion through the provider's authorization screen.

## Runtime choice

| Approach | Model/tool loop owner | Current choice |
| --- | --- | --- |
| Direct Responses adapter | Asmo | Implemented. Each model turn returns to Asmo before a tool runs. |
| OpenAI Agents SDK | SDK inside our application | Deferred. Its runner overlaps with Asmo's existing loop. |
| OpenAI Agents API | OpenAI's managed Codex harness | Deferred. Managed sessions, compaction, and recovery need separate policy integration. |

The overlap is an engineering judgment based on the existing worker and store. OpenAI documents the [runtime comparison](https://developers.openai.com/api/docs/guides/agents), [SDK runner](https://developers.openai.com/api/docs/guides/agents/running-agents), and [managed Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview).

## Provider compatibility

| Provider | Responses status in Asmo | Limits |
| --- | --- | --- |
| OpenAI | Default live provider | Official `/v1/responses`, strict functions, `store: false`, encrypted reasoning replay, `parallel_tool_calls: false`. |
| DeepSeek | Alternative profile implemented; no live verification | Native `/responses`. Stateless API. No `store`, `include`, or encrypted reasoning support. Ignores the parallel-call setting; Asmo rejects more than one call locally. |
| GLM through Z.AI | Disabled, unverified | Reviewed docs establish Chat Completions support. Responses compatibility remains unverified. Selecting `glm` fails clearly. |
| Anthropic | Legacy adapter and mock tests retained | Not selected by live configuration. |

Checked October 7, 2026 against [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning), [DeepSeek Responses compatibility](https://api-docs.deepseek.com/guides/responses_api/), and [Z.AI Chat Completions](https://docs.z.ai/api-reference/llm/chat-completion). No live quality, account-access, latency, or cost comparison ran.

Asmo sends complete local history without `previous_response_id` or a remote conversation. Provider items bind to the provider, endpoint, and configured model. A different identity rebuilds ordinary text/tool history and drops opaque reasoning. Incomplete responses and refusals expose no executable calls.

## Configure live requests

1. Configure API billing in the [OpenAI Platform](https://platform.openai.com/).
2. Create an Asmo project key at [API keys](https://platform.openai.com/api-keys), following [OpenAI key guidance](https://developers.openai.com/api/docs/guides/production-best-practices).
3. Store it as `OPENAI_API_KEY` in private server configuration or `.env.live`.
4. Set `ASMO_MODEL_PROVIDER=openai` and `ASMO_MODEL` to an available model.
5. Set all three prices from that provider's current pricing. Asmo does not infer prices from model names.
6. Configure the request reserve and task budget.

| Setting | Meaning |
| --- | --- |
| `ASMO_MODEL_PROVIDER` | `openai` by default, or `deepseek`. `glm` remains disabled. |
| `ASMO_MODEL` | Required operator-selected model identifier. |
| `OPENAI_API_KEY` | Required for OpenAI only. |
| `DEEPSEEK_API_KEY` | Required for DeepSeek only; never substitutes an OpenAI key. |
| `ASMO_INPUT_USD_PER_MILLION` | Required uncached input price. |
| `ASMO_CACHED_INPUT_USD_PER_MILLION` | Required cached input price. |
| `ASMO_OUTPUT_USD_PER_MILLION` | Required output price, including reasoning tokens. |
| `ASMO_MAX_OUTPUT_TOKENS` | Output cap, at most 4096. |
| `ASMO_MODEL_RESERVE_MICROS` | Hold for one request, in millionths of a US dollar. |
| `ASMO_TASK_BUDGET_MICROS` | Task spending ceiling in the same units. |

Prices must be finite and nonnegative. Input usage includes cached tokens; Asmo charges cached and uncached tokens separately. Output usage includes reasoning, so Asmo charges the output total once. See [OpenAI usage](https://developers.openai.com/api/docs/guides/reasoning) and [DeepSeek usage](https://api-docs.deepseek.com/guides/responses_api/).

The request body is capped at 100,000 UTF-8 bytes. Startup requires this conservative reserve:

```text
ceil(100000 * max(input_price, cached_input_price) + max_output_tokens * output_price)
```

`TELEGRAM_BOT_TOKEN` comes from BotFather. `TELEGRAM_WEBHOOK_SECRET` must contain 16 to 256 letters, digits, underscores, or hyphens. `ASMO_DATABASE_PATH` is a local SQLite file. `ASMO_MINIAPP_LINK` is optional and must be a Telegram Mini App direct link when set. Absent connector groups allow chat without GitHub or Notion.

## Register the GitHub App

Users install the App on selected repositories. These setup credentials belong to the operator.

1. Open GitHub Settings, Developer settings, GitHub Apps, then New GitHub App. Follow [GitHub registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
2. Grant repository Issues read and write permission. Choose the allowed installation accounts.
3. Set Setup URL and user authorization Callback URL to your public Asmo origin plus `/connectors/github/callback`. Leave automatic OAuth during installation disabled; Asmo starts that step after installation. Incoming GitHub webhooks are not required.
4. Copy the App ID, client ID, client secret, and slug into `ASMO_GITHUB_APP_ID`, `ASMO_GITHUB_CLIENT_ID`, `ASMO_GITHUB_CLIENT_SECRET`, and `ASMO_GITHUB_APP_SLUG`.
5. Generate a private key in the App's Private keys section. Set `ASMO_GITHUB_PRIVATE_KEY` to its PEM contents, with actual newlines or literal `\n`. The field takes contents, not a file path. See [private key setup](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).
6. Set `ASMO_GITHUB_CALLBACK_URL` to the registered callback URL.
7. Set the connector vault key below, then select Connect GitHub in Asmo and choose repositories.

Asmo obtains and refreshes credentials through its connector service. `GITHUB_INSTALLATION_TOKEN` and `ASMO_GITHUB_REPOSITORIES` are no longer live startup inputs. GitHub documents [installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

## Register Notion OAuth

1. Create a public connection in Notion's Developer portal and choose its installation scope.
2. Register your public Asmo origin plus `/connectors/notion/callback` as its OAuth redirect URI.
3. Copy the Configuration tab's OAuth client ID and secret into `ASMO_NOTION_CLIENT_ID` and `ASMO_NOTION_CLIENT_SECRET`.
4. Set `ASMO_NOTION_CALLBACK_URL` to the same redirect URI.
5. Set the connector vault key, then select Connect Notion in Asmo and choose pages in Notion's permission screen.

These steps follow [Notion public connection authorization](https://developers.notion.com/guides/get-started/authorization). Available task tools depend on the implemented tool catalogue and the scope's connector grant. Linking an account alone does not grant a model tool.

## Connector vault

Set `ASMO_CONNECTOR_VAULT_KEY` to a base64-encoded random 32-byte key. Generate it locally with `node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))'` and place it directly in private server configuration. Preserve it with database backups so saved credentials remain readable.

Hosted callbacks use HTTPS; local development can use loopback HTTP. Configure every field in an enabled connector group. A present blank field fails startup, so optional groups in `.env.example` remain commented out until configured.

Keep tokens, model keys, OAuth secrets, vault keys, and PEM contents out of chat and source control. MCP and plugin catalogue entries remain planned capabilities.
