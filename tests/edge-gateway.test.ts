import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { D1Database } from "../src/store/d1.js";
import { createMockD1 } from "./helpers/mock-d1.js";
import { openStore } from "../src/store/index.js";
import { getEdgeStore, handleWebhookRequest, timingSafeEqualStrings } from "../src/edge/gateway.js";
import type { EdgeEnv, ExecutionContext } from "../src/edge/gateway.js";
import type { Scope, Seed } from "../src/core.js";


describe("timingSafeEqualStrings", () => {
  it("compares strings in constant time safely", () => {
    expect(timingSafeEqualStrings("secret-token-123", "secret-token-123")).toBe(true);
    expect(timingSafeEqualStrings("secret-token-123", "secret-token-456")).toBe(false);
    expect(timingSafeEqualStrings("short", "longer-string")).toBe(false);
    expect(timingSafeEqualStrings("", "")).toBe(true);
  });
});

describe("Edge Telegram Webhook Gateway", () => {
  it("serves health checks on GET /health", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const env: EdgeEnv = {
      DB: d1,
      TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot",
      TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-token",
    };

    const req = new Request("https://edge.asmo.local/health", { method: "GET" });
    const res = await handleWebhookRequest(req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; time: number };
    expect(body.status).toBe("ok");
    expect(body.time).toBeGreaterThan(0);
    rawDb.close();
  });

  it("rejects unauthorized webhook calls missing secret token header", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const env: EdgeEnv = {
      DB: d1,
      TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot",
      TELEGRAM_WEBHOOK_SECRET: "correct-webhook-secret-token",
    };

    const req = new Request("https://edge.asmo.local/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });

    const res = await handleWebhookRequest(req, env);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("authentication failed");
    rawDb.close();
  });

  it("rejects unauthorized webhook calls with wrong secret token", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const env: EdgeEnv = {
      DB: d1,
      TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot",
      TELEGRAM_WEBHOOK_SECRET: "correct-webhook-secret-token",
    };

    const req = new Request("https://edge.asmo.local/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong-webhook-secret-token",
      },
      body: JSON.stringify({ update_id: 1 }),
    });

    const res = await handleWebhookRequest(req, env);
    expect(res.status).toBe(401);
    rawDb.close();
  });

  it("ingests Telegram messages into D1 store and returns accepted receipt", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const botId = "123456";
    const env: EdgeEnv = {
      DB: d1,
      TELEGRAM_BOT_TOKEN: `${botId}:ABC-DEF`,
      TELEGRAM_BOT_ID: botId,
      TELEGRAM_BOT_USERNAME: "asmo_test_bot",
      TELEGRAM_WEBHOOK_SECRET: "my-longer-webhook-secret",
      SIMULATED: true,
    };

    // Pre-seed workspace & scope
    const store = await openStore({
      d1,
      modelReserveMicros: 1000,
      maxOutputTokens: 2000,
      maxTurns: 12,
      taskBudgetMicros: 20_000,
      leaseMs: 10_000,
      simulated: true,
    });
    const workspaceId = randomUUID();
    const scopeId = randomUUID();
    const chatId = "-100999888";
    const scope: Scope = {
      id: scopeId,
      workspaceId,
      kind: "group",
      chatId,
      ownerId: null,
      name: "Edge Group",
      active: true,
      workspacePublic: false,
      timezone: "UTC",
      policyRevision: 1,
      collectedSince: Date.now() - 5000,
      budgetMicros: 100_000,
    };
    const seed: Seed = {
      botId,
      workspaceId,
      name: "Edge Workspace",
      ownerId: "edge-owner",
      budgetMicros: 200_000,
      scopes: [scope],
      memberships: [
        { scopeId, userId: "42", role: "member" },
        { scopeId, userId: "edge-owner", role: "owner" },
      ],
      grants: [],
    };
    await store.seed(seed);

    // Simulate incoming Telegram update mentioning the bot
    const updatePayload = {
      update_id: 1001,
      message: {
        message_id: 55,
        chat: { id: Number(chatId), type: "supergroup" },
        from: { id: 42, is_bot: false },
        text: "@asmo_test_bot write a deployment script",
        entities: [
          { type: "mention", offset: 0, length: 14 },
        ],
      },
    };

    const req = new Request("https://edge.asmo.local/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "my-longer-webhook-secret",
      },
      body: JSON.stringify(updatePayload),
    });

    const res = await handleWebhookRequest(req, env);
    expect(res.status).toBe(200);
    const receipt = await res.json() as { kind: string; taskId?: string };
    expect(receipt.kind).toBe("accepted");
    expect(receipt.taskId).toBeDefined();

    // Verify task is stored in D1
    const taskView = await store.task(scopeId, "42", receipt.taskId!);
    expect(taskView.task.instruction).toBe("@asmo_test_bot write a deployment script");
    expect(taskView.task.state).toBe("queued");

    await store.close();
    rawDb.close();
  });

  it("handles callback query and registers background acknowledgement via waitUntil", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const botId = "123456";
    const env: EdgeEnv = {
      DB: d1,
      TELEGRAM_BOT_TOKEN: `${botId}:ABC-DEF`,
      TELEGRAM_BOT_ID: botId,
      TELEGRAM_BOT_USERNAME: "asmo_test_bot",
      TELEGRAM_WEBHOOK_SECRET: "my-longer-webhook-secret",
      SIMULATED: true,
    };

    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx: ExecutionContext = {
      waitUntil(p: Promise<unknown>) {
        waitUntilPromises.push(p);
      },
      passThroughOnException() {},
    };

    const callbackPayload = {
      update_id: 1002,
      callback_query: {
        id: "cb_query_999",
        from: { id: 42, is_bot: false },
        data: "invalid:callback:data",
        message: {
          message_id: 56,
          chat: { id: -100999888, type: "supergroup" },
        },
      },
    };

    // acknowledgeCallback posts to api.telegram.org. Stub it so the suite never depends on
    // external network access, and so the acknowledgement is awaited rather than left
    // dangling after the test ends.
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("https://edge.asmo.local/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "my-longer-webhook-secret",
      },
      body: JSON.stringify(callbackPayload),
    });

    const res = await handleWebhookRequest(req, env, ctx);
    expect(res.status).toBe(200);
    // ctx.waitUntil was called to acknowledge the callback query
    expect(waitUntilPromises.length).toBe(1);
    await waitUntilPromises[0];
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
    rawDb.close();
  });
});

describe("Edge store lifecycle and configuration", () => {
  it("rejects a missing bot username, which would silently break group mentions", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const env = { DB: d1, TELEGRAM_BOT_TOKEN: "123456:ABC", TELEGRAM_WEBHOOK_SECRET: "edge-webhook-secret-token" } as EdgeEnv;
    const req = new Request("https://edge.asmo.local/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "edge-webhook-secret-token" },
      body: JSON.stringify({ update_id: 11, message: { message_id: 1, chat: { id: Number("-100999888"), type: "supergroup" }, from: { id: 42, is_bot: false }, text: "@asmo_test_bot hello", entities: [{ type: "mention", offset: 0, length: 14 }] } }),
    });
    const res = await handleWebhookRequest(req, env);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("TELEGRAM_BOT_USERNAME") });
    rawDb.close();
  });

  it("answers 400 for an update payload that fails schema validation", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const env: EdgeEnv = {
      DB: createMockD1(rawDb),
      TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot",
      TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-token",
    };
    const req = new Request("https://edge.asmo.local/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "test-webhook-secret-token" },
      body: JSON.stringify({ update_id: -5 }),
    });
    const res = await handleWebhookRequest(req, env);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("Telegram update") });
    rawDb.close();
  });

  it("rejects non-integer configuration instead of letting NaN reach the store", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const env: EdgeEnv = { DB: d1, TELEGRAM_BOT_TOKEN: "123456:ABC",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot", TELEGRAM_WEBHOOK_SECRET: "edge-webhook-secret-token", LEASE_MS: "abc" };
    const req = new Request("https://edge.asmo.local/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "edge-webhook-secret-token" },
      body: JSON.stringify({ update_id: 9, message: { message_id: 1, chat: { id: Number("-100999888"), type: "supergroup" }, from: { id: 42, is_bot: false }, text: "@asmo_test_bot do the thing", entities: [{ type: "mention", offset: 0, length: 14 }] } }),
    });
    await expect(handleWebhookRequest(req, env)).rejects.toThrow("LEASE_MS must be an integer");
    rawDb.close();
  });

  it("retries after a failed store start instead of replaying the failure", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const env: EdgeEnv = { DB: d1, TELEGRAM_BOT_TOKEN: "123456:ABC",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot", TELEGRAM_WEBHOOK_SECRET: "edge-webhook-secret-token" };

    const broken: D1Database = {
      ...d1,
      prepare(query: string) {
        if (query === "PRAGMA table_list") return { ...d1.prepare(query), all: async () => { throw new Error("D1 temporarily unavailable"); } };
        return d1.prepare(query);
      },
    };
    const brokenEnv: EdgeEnv = { ...env, DB: broken };
    // A Request body is single use, so each call needs a fresh one.
    const request = () => new Request("https://edge.asmo.local/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "edge-webhook-secret-token" },
      body: JSON.stringify({ update_id: 10, message: { message_id: 1, chat: { id: Number("-100999888"), type: "supergroup" }, from: { id: 42, is_bot: false }, text: "@asmo_test_bot do the thing", entities: [{ type: "mention", offset: 0, length: 14 }] } }),
    });

    await expect(handleWebhookRequest(request(), brokenEnv)).rejects.toThrow("D1 temporarily unavailable");
    // The failure must not be cached: the next call against the same binding retries the start.
    await expect(handleWebhookRequest(request(), brokenEnv)).rejects.toThrow("D1 temporarily unavailable");

    // A healthy binding still starts cleanly.
    const res = await handleWebhookRequest(request(), env);
    expect(res.status).toBe(200);
    rawDb.close();
  });
});
