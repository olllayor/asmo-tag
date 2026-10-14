import type { Delivery, IssueConnector, Job, Messenger, ModelProvider, Store } from "../core.js";
import { Worker } from "../worker.js";
import { getEdgeStore } from "./gateway.js";
import type { EdgeEnv, ExecutionContext } from "./gateway.js";
import { createFixtureModel } from "../providers/fixture.js";

export function createInMemoryConnector(): IssueConnector {
  return {
    simulated: true,
    async invoke(effect, signal) {
      signal?.throwIfAborted();
      const id = Math.floor(Math.random() * 100_000) + 1;
      const repo = "repository" in effect.call.input ? (effect.call.input as any).repository : "default/repo";
      // Fail honest: the URL must never look like a real GitHub issue. Callers record
      // this receipt, so a github.com URL here would present an uncreated issue as live.
      return {
        providerId: `simulated-issue-${id}`,
        url: `https://asmo-simulated.invalid/issues/${id}`,
        content: JSON.stringify({ simulated: true, repository: repo, number: id, limitation: "Simulated issue recorded in memory only. No GitHub issue exists." }),
      };
    },
    async reconcile(effect, signal) {
      signal?.throwIfAborted();
      return { kind: "absent", proof: "Reconciled with no existing remote issue." };
    },
  };
}

import { createResponsesModel } from "../providers/responses.js";
import { createGitHubConnector } from "../connectors/github.js";

export interface QueueMessage {
  type: "drain" | "step";
  workspaceId?: string;
  kind?: Job["kind"];
  limit?: number;
  timestamp: number;
}

export interface Queue<T = unknown> {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: { body: T; delaySeconds?: number }[]): Promise<void>;
}

export interface Message<T = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  ack(): void;
  retry(): void;
}

export interface MessageBatch<T = unknown> {
  readonly queue: string;
  readonly messages: readonly Message<T>[];
  ackAll(): void;
  retryAll(): void;
}

export interface ScheduledEvent {
  readonly cron: string;
  readonly type: string;
  readonly scheduledTime: number;
}

// A deploy missing credentials silently falls back to a fixture model, messenger, or
// connector. Those fixtures report simulated: true, but the store's `simulated` flag comes
// from the SIMULATED env var alone, so the ledger claimed real usage for work that never
// called a provider. This lists which parts are simulated so the caller can set the flag
// honestly.
export function edgeSimulationGaps(env: EdgeEnv): string[] {
  const gaps: string[] = [];
  if (!env.MODEL_API_KEY || !env.MODEL_NAME) gaps.push("model");
  if (!env.TELEGRAM_BOT_TOKEN?.trim() || env.TELEGRAM_BOT_TOKEN.startsWith("fixture-")) gaps.push("messenger");
  if (!env.GITHUB_TOKEN || !env.ALLOWED_REPOSITORIES?.split(",").map(repo => repo.trim()).filter(Boolean).length) gaps.push("connector");
  return gaps;
}

export function createEdgeMessenger(token?: string): Messenger {
  if (token && !token.startsWith("fixture-")) {
    return createEdgeTelegramMessenger(token);
  }
  return {
    simulated: true,
    async send(delivery) {
      return { messageId: delivery.messageId ?? 100_000 + Math.floor(Math.random() * 900_000) };
    },
  };
}

// The Node messenger (src/telegram/messenger.ts) persists an fs-backed outbox and drives
// grammy, neither of which exists on Workers. The edge messenger calls the Bot API
// directly: stateless, no filesystem, same edit-or-send semantics.
function createEdgeTelegramMessenger(token: string): Messenger {
  const call = async (method: string, payload: unknown, signal: AbortSignal): Promise<{ message_id: number }> => {
    signal.throwIfAborted();
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Telegram API ${method} failed with HTTP status ${response.status}`);
    }
    const json = (await response.json()) as { ok: boolean; result: { message_id: number }; description?: string };
    if (!json.ok) {
      throw new Error(`Telegram API ${method} failed: ${json.description ?? "unknown error"}`);
    }
    return json.result;
  };

  return {
    simulated: false,
    async send(delivery: Delivery, signal: AbortSignal) {
      const replyMarkup = delivery.buttons.length
        ? { inline_keyboard: delivery.buttons.map(button => [{ text: button.text, callback_data: button.data }]) }
        : undefined;
      if (delivery.messageId !== null) {
        try {
          await call("editMessageText", {
            chat_id: delivery.chatId,
            message_id: delivery.messageId,
            text: delivery.text,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          }, signal);
        } catch (error) {
          // The Node messenger swallows "message is not modified" the same way: the
          // desired end state (this exact text shown) already holds.
          if (!(error instanceof Error && error.message.includes("message is not modified"))) throw error;
        }
        return { messageId: delivery.messageId };
      }
      const result = await call("sendMessage", {
        chat_id: delivery.chatId,
        text: delivery.text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(delivery.topicId !== null ? { message_thread_id: delivery.topicId } : {}),
        ...(delivery.replyTo !== undefined ? { reply_parameters: { message_id: delivery.replyTo, allow_sending_without_reply: true } } : {}),
      }, signal);
      return { messageId: result.message_id };
    },
  };
}

export function createEdgeModel(env: EdgeEnv): ModelProvider {
  if (env.MODEL_API_KEY && env.MODEL_NAME) {
    // GLM Responses compatibility is unverified (see resolveProviderProfile): mapping it
    // silently onto the OpenAI profile would send a GLM key to an OpenAI endpoint shape,
    // so it fails loudly instead.
    if (env.MODEL_PROVIDER === "glm") {
      throw new Error("GLM Responses compatibility is unverified. Choose openai or deepseek.");
    }
    if (env.MODEL_PROVIDER && env.MODEL_PROVIDER !== "openai" && env.MODEL_PROVIDER !== "deepseek") {
      throw new Error(`Configuration error: MODEL_PROVIDER must be openai or deepseek`);
    }
    const provider = (env.MODEL_PROVIDER === "deepseek" ? "deepseek" : "openai") as "openai" | "deepseek";
    const prices = resolveEdgeModelPrices(env);
    return createResponsesModel({
      provider,
      apiKey: env.MODEL_API_KEY,
      model: env.MODEL_NAME,
      inputUsdPerMillion: prices.inputUsdPerMillion,
      cachedInputUsdPerMillion: prices.cachedInputUsdPerMillion,
      outputUsdPerMillion: prices.outputUsdPerMillion,
    });
  }
  return createFixtureModel();
}

export interface EdgeModelPrices {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

// Hardcoded prices cover the OpenAI profile only. DeepSeek bills on its own schedule,
// so applying OpenAI rates to it would misstate spend in the usage ledger. A DeepSeek
// deploy must set explicit MODEL_*_USD_PER_MILLION values and fails loudly without them.
const OPENAI_DEFAULT_PRICES: EdgeModelPrices = {
  inputUsdPerMillion: 0.15,
  cachedInputUsdPerMillion: 0.075,
  outputUsdPerMillion: 0.60,
};

function edgePrice(env: EdgeEnv, key: "MODEL_INPUT_USD_PER_MILLION" | "MODEL_CACHED_INPUT_USD_PER_MILLION" | "MODEL_OUTPUT_USD_PER_MILLION"): number | null {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Configuration error: ${key} must be a finite nonnegative USD price per million tokens.`);
  }
  return value;
}

export function resolveEdgeModelPrices(env: EdgeEnv): EdgeModelPrices {
  const input = edgePrice(env, "MODEL_INPUT_USD_PER_MILLION");
  const cached = edgePrice(env, "MODEL_CACHED_INPUT_USD_PER_MILLION");
  const output = edgePrice(env, "MODEL_OUTPUT_USD_PER_MILLION");
  if (input !== null && cached !== null && output !== null) {
    return { inputUsdPerMillion: input, cachedInputUsdPerMillion: cached, outputUsdPerMillion: output };
  }
  if (env.MODEL_PROVIDER === "deepseek") {
    throw new Error("Configuration error: DeepSeek prices are not defaulted. Set MODEL_INPUT_USD_PER_MILLION, MODEL_CACHED_INPUT_USD_PER_MILLION, and MODEL_OUTPUT_USD_PER_MILLION.");
  }
  if (input !== null || cached !== null || output !== null) {
    throw new Error("Configuration error: set all of MODEL_INPUT_USD_PER_MILLION, MODEL_CACHED_INPUT_USD_PER_MILLION, and MODEL_OUTPUT_USD_PER_MILLION together, or none for OpenAI defaults.");
  }
  return OPENAI_DEFAULT_PRICES;
}

export function createEdgeConnector(env: EdgeEnv): IssueConnector {
  if (env.GITHUB_TOKEN && env.ALLOWED_REPOSITORIES) {
    const allowed = env.ALLOWED_REPOSITORIES.split(",").map(repo => repo.trim()).filter(Boolean);
    if (allowed.length > 0) {
      return createGitHubConnector({
        token: env.GITHUB_TOKEN,
        allowedRepositories: allowed,
      });
    }
  }
  return createInMemoryConnector();
}

export interface EdgeWorkerOptions {
  model?: ModelProvider;
  connector?: IssueConnector;
  messenger?: Messenger;
}

export async function createEdgeWorker(
  env: EdgeEnv,
  options?: EdgeWorkerOptions
): Promise<{ store: Store; worker: Worker }> {
  const store = await getEdgeStore(env);
  const model = options?.model ?? createEdgeModel(env);
  const connector = options?.connector ?? createEdgeConnector(env);
  const messenger = options?.messenger ?? createEdgeMessenger(env.TELEGRAM_BOT_TOKEN);
  const worker = new Worker(store, model, connector, messenger);
  return { store, worker };
}

export async function drainJobs(
  env: EdgeEnv,
  limit = 20,
  options?: EdgeWorkerOptions,
  workerId = "edge-drain"
): Promise<number> {
  const { worker } = await createEdgeWorker(env, options);
  return worker.drain(limit, workerId);
}

export async function handleQueueBatch(
  batch: MessageBatch<QueueMessage>,
  env: EdgeEnv,
  ctx?: ExecutionContext,
  options?: EdgeWorkerOptions
): Promise<{ processed: number; acked: number }> {
  const { worker } = await createEdgeWorker(env, options);
  let totalLimit = 0;
  for (const message of batch.messages) {
    totalLimit += message.body.limit ?? 10;
  }
  let processed = 0;
  try {
    processed = await worker.drain(Math.min(totalLimit, 50), "edge-queue");
    for (const message of batch.messages) {
      message.ack();
    }
    return { processed, acked: batch.messages.length };
  } catch (error) {
    console.error("Queue job execution error:", error);
    for (const message of batch.messages) {
      message.retry();
    }
    return { processed: 0, acked: 0 };
  }
}

export async function handleScheduled(
  event: ScheduledEvent,
  env: EdgeEnv,
  ctx?: ExecutionContext,
  options?: EdgeWorkerOptions
): Promise<{ processed: number }> {
  // Routine advancement is triggered automatically inside claim()
  const { worker } = await createEdgeWorker(env, options);
  const processed = await worker.drain(20, "edge-scheduled");
  return { processed };
}
