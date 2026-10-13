import { createHash, timingSafeEqual } from "node:crypto";
import type { D1Database } from "../store/d1.js";
import { openStore } from "../store/index.js";
import type { NormalizedUpdate, Receipt, Store } from "../core.js";
import { normalizeUpdate, telegramUpdateSchema } from "../telegram/updates.js";
import {
  drainJobs,
  edgeSimulationGaps,
  handleQueueBatch,
  handleScheduled,
  resolveEdgeModelPrices,
} from "./executor.js";
import { EdgeKvCache } from "./kv.js";
import type { R2Bucket } from "./r2.js";
import type { KVNamespace } from "./kv.js";
import type {
  MessageBatch,
  Queue,
  QueueMessage,
  ScheduledEvent,
} from "./executor.js";

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface EdgeEnv {
  DB: D1Database;
  QUEUE?: Queue<QueueMessage>;
  KV?: KVNamespace;
  VAULT_KEY?: string;
  R2?: R2Bucket;
  SANDBOX_ENDPOINT?: string;
  SANDBOX_API_KEY?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_BOT_ID?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  MODEL_RESERVE_MICROS?: string | number;
  MAX_OUTPUT_TOKENS?: string | number;
  MAX_TURNS?: string | number;
  TASK_BUDGET_MICROS?: string | number;
  LEASE_MS?: string | number;
  SIMULATED?: string | boolean;
  MODEL_API_KEY?: string;
  MODEL_PROVIDER?: "openai" | "deepseek" | "glm";
  MODEL_ENDPOINT?: string;
  MODEL_NAME?: string;
  MODEL_INPUT_USD_PER_MILLION?: string | number;
  MODEL_CACHED_INPUT_USD_PER_MILLION?: string | number;
  MODEL_OUTPUT_USD_PER_MILLION?: string | number;
  GITHUB_TOKEN?: string;
  ALLOWED_REPOSITORIES?: string;
}

// Compares SHA-256 digests so the cost does not depend on where the inputs first differ,
// or on their length. A character loop bails out on a length mismatch, which leaks the
// secret's length before the constant-time part even runs.
export function timingSafeEqualStrings(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

const storeCache = new WeakMap<object, Promise<Store>>();

function envInteger(env: EdgeEnv, key: NumberKeys, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value)) throw new Error(`Configuration error: ${key} must be an integer`);
  return value;
}

type NumberKeys = "MODEL_RESERVE_MICROS" | "MAX_OUTPUT_TOKENS" | "MAX_TURNS" | "TASK_BUDGET_MICROS" | "LEASE_MS";

function envBoolean(env: EdgeEnv, key: keyof EdgeEnv, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`Configuration error: ${key} must be true or false`);
}

export function getEdgeStore(env: EdgeEnv): Promise<Store> {
  // A missing binding must read as a configuration error, not a WeakMap TypeError.
  if (!env.DB) return Promise.reject(new Error("Missing configuration: DB binding"));
  const cached = storeCache.get(env.DB);
  if (cached) return cached;
  const modelReserveMicros = envInteger(env, "MODEL_RESERVE_MICROS", 100_000);
  const maxOutputTokens = envInteger(env, "MAX_OUTPUT_TOKENS", 2000);
  const taskBudgetMicros = envInteger(env, "TASK_BUDGET_MICROS", 2_000_000);
  // Mirror the Node reserve floor (src/config.ts): a reserve below one worst-case
  // request lets concurrent tasks each fund the same remaining allowance. Skip the
  // check while simulated, where the ledger labels usage as unbilled.
  if (!edgeSimulationGaps(env).includes("model")) {
    const prices = resolveEdgeModelPrices(env);
    const upperBound = Math.ceil(100_000 * Math.max(prices.inputUsdPerMillion, prices.cachedInputUsdPerMillion) + maxOutputTokens * prices.outputUsdPerMillion);
    if (modelReserveMicros < upperBound) {
      return Promise.reject(new Error(`Configuration error: MODEL_RESERVE_MICROS must be at least ${upperBound} for the configured request bounds and prices.`));
    }
  }
  const pending = openStore({
    d1: env.DB,
    modelReserveMicros,
    maxOutputTokens,
    maxTurns: envInteger(env, "MAX_TURNS", 12),
    taskBudgetMicros,
    leaseMs: envInteger(env, "LEASE_MS", 10_000),
    simulated: envBoolean(env, "SIMULATED", false) || edgeSimulationGaps(env).length > 0,
  });
  if (edgeSimulationGaps(env).length > 0) {
    console.error(`Edge simulation active for: ${edgeSimulationGaps(env).join(", ")}. Set MODEL_API_KEY, MODEL_NAME, TELEGRAM_BOT_TOKEN, and GITHUB_TOKEN for live operation.`);
  }
  // A failed start must not poison the isolate: drop it so the next request retries and
  // reports the real error instead of replaying a stale one forever.
  const tracked = pending.catch((error: unknown) => {
    if (storeCache.get(env.DB) === tracked) storeCache.delete(env.DB);
    throw error;
  });
  storeCache.set(env.DB, tracked);
  return tracked;
}

// The Node server rejects a weak secret at startup (src/config.ts). The edge has no
// startup hook, so the rule is enforced per request: a worker comparing against a
// guessable secret is a configuration failure, not a silently accepted deploy.
const webhookSecretPattern = /^[A-Za-z0-9_-]{16,256}$/;

function edgeConfigProblem(env: EdgeEnv): string | null {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return "Missing configuration: TELEGRAM_WEBHOOK_SECRET";
  if (!webhookSecretPattern.test(env.TELEGRAM_WEBHOOK_SECRET)) return "TELEGRAM_WEBHOOK_SECRET must contain 16 to 256 safe characters.";
  if (!env.TELEGRAM_BOT_TOKEN?.trim()) return "Missing configuration: TELEGRAM_BOT_TOKEN";
  if (!env.TELEGRAM_BOT_USERNAME?.trim()) return "Missing configuration: TELEGRAM_BOT_USERNAME (required to match @mentions in groups)";
  return null;
}

// The bot id is the part of the token before the colon. Without it the worker cannot match
// @mentions or text_mention entities, so a missing or malformed token returns null instead
// of a placeholder identity that silently drops every group update.
// The bot username is required, not optional. normalizeUpdate matches a group @mention by
// comparing the entity text to `@${bot.username.toLowerCase()}`, so a placeholder value that
// differs from the real bot username makes every group mention fail to match and the bot
// goes silent in groups with no error anywhere. DMs do not need it, which is exactly why
// the failure would look unexplained.
const fallbackBotUsername = "asmo_bot";

export function resolveBotIdentity(env: EdgeEnv): { id: string; username: string } | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const separator = token.indexOf(":");
  if (separator <= 0 || separator === token.length - 1) return null;
  return {
    id: env.TELEGRAM_BOT_ID ?? token.slice(0, separator),
    username: env.TELEGRAM_BOT_USERNAME ?? fallbackBotUsername,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function acknowledgeCallback(token: string, callbackQueryId: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (error) {
    console.error("Callback acknowledgement failed:", error);
  }
}

export async function handleWebhookRequest(
  request: Request,
  env: EdgeEnv,
  ctx?: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
    // A health check that never touches the store reports ok while every update fails.
    try {
      await getEdgeStore(env);
      return jsonResponse({ status: "ok", time: Date.now() });
    } catch (error) {
      return jsonResponse({ status: "unavailable", error: String(error) }, 503);
    }
  }

  const isWebhookPath = url.pathname === "/telegram/webhook" || url.pathname === "/webhook" || url.pathname === "/";
  if (request.method === "POST" && isWebhookPath) {
    // Configuration problems are reported before anything else. A worker that cannot
    // identify its bot or compare its secret must fail loudly, not silently drop updates.
    const problem = edgeConfigProblem(env);
    if (problem) return jsonResponse({ error: problem }, 500);

    // Authenticate before rate limiting. The limiter writes to KV, so letting unauthenticated
    // callers through it lets them burn the legitimate bot's budget with random requests.
    const secretHeader = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!timingSafeEqualStrings(secretHeader, env.TELEGRAM_WEBHOOK_SECRET)) {
      return jsonResponse({ error: "Webhook authentication failed." }, 401);
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON payload." }, 400);
    }

    const bot = resolveBotIdentity(env);
    if (!bot) return jsonResponse({ error: "Missing configuration: TELEGRAM_BOT_TOKEN" }, 500);
    let update: NormalizedUpdate | null;
    try {
      update = normalizeUpdate(raw, bot);
    } catch {
      // normalizeUpdate parses with zod. A malformed update must answer 400, not throw an
      // unhandled ZodError out of the Worker.
      return jsonResponse({ error: "Update payload is not a Telegram update." }, 400);
    }
    if (!update) {
      return jsonResponse({ kind: "ignored" });
    }

    if (env.KV && update.chatId) {
      // Rate limit per chat, not per IP. Telegram delivers every webhook from a small set of
      // Cloudflare-visible addresses, so keying on cf-connecting-ip puts all legitimate
      // traffic in one bucket and a busy group 429s the whole bot.
      const rate = await new EdgeKvCache(env.KV).checkRateLimit("chat:" + update.chatId, 600, 60);
      if (!rate.allowed) {
        return jsonResponse({ error: "Rate limit exceeded." }, 429);
      }
    }

    const store = await getEdgeStore(env);
    const receipt: Receipt = await store.ingest(update);

    const parsed = telegramUpdateSchema.safeParse(raw);
    const callback = parsed.success ? parsed.data.callback_query : undefined;
    if (callback && env.TELEGRAM_BOT_TOKEN) {
      const ackText = receipt.kind === "denied" ? "Action denied. Refresh the task." : "Decision received. Check saved task state.";
      const ackPromise = acknowledgeCallback(env.TELEGRAM_BOT_TOKEN, callback.id, ackText);
      if (ctx?.waitUntil) {
        ctx.waitUntil(ackPromise);
      } else {
        await ackPromise;
      }
    }

    // Fast-path background drain & queue notification
    if (receipt.kind === "accepted") {
      // The queue message is the durable driver: it survives isolate shutdown and retries
      // on failure. The inline drain is the latency driver: it starts work within this
      // isolate immediately instead of waiting for queue delivery. Both are safe to run
      // because job leases are compare-and-swap (see claim()), so whichever drain loses
      // the race simply finds no claimable job.
      if (env.QUEUE) {
        try {
          await env.QUEUE.send({ type: "drain", timestamp: Date.now() });
        } catch (queueError) {
          console.error("Failed to enqueue job notification:", queueError);
        }
      }
      if (ctx?.waitUntil) {
        // drainJobs has its own error handling only for store work; keep a background
        // failure from surfacing as an unhandled rejection.
        ctx.waitUntil(drainJobs(env, 10).catch((error: unknown) => { console.error("Background drain failed:", error); }));
      }
    }

    return jsonResponse(receipt);
  }

  return jsonResponse({ error: "Not found." }, 404);
}

export default {
  fetch(request: Request, env: EdgeEnv, ctx: ExecutionContext): Promise<Response> {
    return handleWebhookRequest(request, env, ctx);
  },
  async queue(batch: MessageBatch<QueueMessage>, env: EdgeEnv, ctx: ExecutionContext): Promise<void> {
    await handleQueueBatch(batch, env, ctx);
  },
  async scheduled(event: ScheduledEvent, env: EdgeEnv, ctx: ExecutionContext): Promise<void> {
    await handleScheduled(event, env, ctx);
  },
};
