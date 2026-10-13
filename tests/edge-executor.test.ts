import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { D1Database } from "../src/store/d1.js";
import { createMockD1 } from "./helpers/mock-d1.js";
import { openStore } from "../src/store/index.js";
import { handleWebhookRequest } from "../src/edge/gateway.js";
import { drainJobs, handleQueueBatch, handleScheduled, createEdgeWorker, edgeSimulationGaps, createEdgeModel, createInMemoryConnector, resolveEdgeModelPrices } from "../src/edge/executor.js";
import type {
  Message,
  MessageBatch,
  Queue,
  QueueMessage,
  ScheduledEvent,
} from "../src/edge/executor.js";
import type { EdgeEnv, ExecutionContext } from "../src/edge/gateway.js";
import type { Scope, Seed } from "../src/core.js";


function createMockQueue(): Queue<QueueMessage> & { sent: QueueMessage[] } {
  const sent: QueueMessage[] = [];
  return {
    sent,
    async send(msg: QueueMessage) {
      sent.push(msg);
    },
    async sendBatch(msgs) {
      sent.push(...msgs.map(m => m.body));
    },
  };
}

describe("Background Edge Executor and Queue Processing", () => {
  it("drains queued model and delivery jobs to completion", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const botId = "777";
    const env: EdgeEnv = {
      DB: d1,
      TELEGRAM_BOT_TOKEN: `${botId}:ABC`,
      TELEGRAM_BOT_ID: botId,
      TELEGRAM_WEBHOOK_SECRET: "edge-webhook-secret-token",
      SIMULATED: true,
    };

    const store = await openStore({
      d1,
      modelReserveMicros: 1000,
      maxOutputTokens: 2000,
      maxTurns: 12,
      taskBudgetMicros: 2_000_000,
      leaseMs: 10_000,
      simulated: true,
    });

    const workspaceId = randomUUID();
    const scopeId = randomUUID();
    const scope: Scope = {
      id: scopeId,
      workspaceId,
      kind: "group",
      chatId: "-100222333",
      ownerId: null,
      name: "Queue Group",
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
      name: "Queue Workspace",
      ownerId: "owner-1",
      budgetMicros: 200_000,
      scopes: [scope],
      memberships: [
        { scopeId, userId: "dev-1", role: "member" },
        { scopeId, userId: "owner-1", role: "owner" },
      ],
      grants: [],
    };
    await store.seed(seed);

    // Create a task
    const receipt = await store.command({
      scopeId,
      userId: "dev-1",
      key: "k1",
      command: { kind: "start", instruction: "Draft release notes", topicId: null },
    });
    expect(receipt.kind).toBe("accepted");
    expect(receipt.taskId).toBeDefined();

    // Verify task is initially queued
    let taskView = await store.task(scopeId, "dev-1", receipt.taskId!);
    expect(taskView.task.state).toBe("queued");

    // Drain jobs using edge executor
    const drained = await drainJobs(env, 10);
    expect(drained).toBeGreaterThanOrEqual(1);

    // Task should now be completed
    taskView = await store.task(scopeId, "dev-1", receipt.taskId!);
    expect(taskView.task.state).toBe("completed");

    await store.close();
    rawDb.close();
  });

  it("handles a Cloudflare Queue message batch and acknowledges all messages", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const env: EdgeEnv = {
      DB: d1,
      TELEGRAM_BOT_TOKEN: "777:ABC",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot",
      TELEGRAM_WEBHOOK_SECRET: "edge-webhook-secret-token",
      SIMULATED: true,
    };

    let ackCount = 0;
    const mockMessages: Message<QueueMessage>[] = [
      {
        id: "msg-1",
        timestamp: new Date(),
        body: { type: "drain", limit: 5, timestamp: Date.now() },
        ack() { ackCount++; },
        retry() {},
      },
      {
        id: "msg-2",
        timestamp: new Date(),
        body: { type: "drain", limit: 5, timestamp: Date.now() },
        ack() { ackCount++; },
        retry() {},
      },
    ];

    const batch: MessageBatch<QueueMessage> = {
      queue: "asmo-tag-jobs",
      messages: mockMessages,
      ackAll() {},
      retryAll() {},
    };

    const res = await handleQueueBatch(batch, env);
    expect(res.acked).toBe(2);
    expect(ackCount).toBe(2);

    rawDb.close();
  });

  it("handles scheduled cron trigger to drain queues and routines", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const env: EdgeEnv = {
      DB: d1,
      TELEGRAM_BOT_TOKEN: "777:ABC",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot",
      TELEGRAM_WEBHOOK_SECRET: "edge-webhook-secret-token",
      SIMULATED: true,
    };

    const event: ScheduledEvent = {
      cron: "* * * * *",
      type: "cron",
      scheduledTime: Date.now(),
    };

    const result = await handleScheduled(event, env);
    expect(result.processed).toBeDefined();

    rawDb.close();
  });

  it("enqueues queue messages and calls waitUntil on accepted webhook requests", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const queue = createMockQueue();
    const botId = "777";
    const env: EdgeEnv = {
      DB: d1,
      QUEUE: queue,
      TELEGRAM_BOT_TOKEN: `${botId}:ABC`,
      TELEGRAM_BOT_ID: botId,
      TELEGRAM_BOT_USERNAME: "asmo_queue_bot",
      TELEGRAM_WEBHOOK_SECRET: "edge-webhook-secret-key",
      SIMULATED: true,
    };

    // Pre-seed workspace
    const store = await openStore({
      d1,
      modelReserveMicros: 1000,
      maxOutputTokens: 2000,
      maxTurns: 12,
      taskBudgetMicros: 2_000_000,
      leaseMs: 10_000,
      simulated: true,
    });
    const workspaceId = randomUUID();
    const scopeId = randomUUID();
    const chatId = "-100333444";
    const scope: Scope = {
      id: scopeId,
      workspaceId,
      kind: "group",
      chatId,
      ownerId: null,
      name: "Async Group",
      active: true,
      workspacePublic: false,
      timezone: "UTC",
      policyRevision: 1,
      collectedSince: Date.now() - 5000,
      budgetMicros: 100_000,
    };
    await store.seed({
      botId,
      workspaceId,
      name: "Async Workspace",
      ownerId: "owner",
      budgetMicros: 200_000,
      scopes: [scope],
      memberships: [
        { scopeId, userId: "99", role: "member" },
        { scopeId, userId: "owner", role: "owner" },
      ],
      grants: [],
    });

    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx: ExecutionContext = {
      waitUntil(p) { waitUntilPromises.push(p); },
      passThroughOnException() {},
    };

    const req = new Request("https://edge.asmo.local/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "edge-webhook-secret-key",
      },
      body: JSON.stringify({
        update_id: 5001,
        message: {
          message_id: 10,
          chat: { id: Number(chatId), type: "supergroup" },
          from: { id: 99, is_bot: false },
          text: "@asmo_queue_bot generate summary report",
          entities: [{ type: "mention", offset: 0, length: 15 }],
        },
      }),
    });

    const res = await handleWebhookRequest(req, env, ctx);
    expect(res.status).toBe(200);
    const receipt = await res.json() as { kind: string; taskId?: string };
    expect(receipt.kind).toBe("accepted");

    // Queue notification should have been sent
    expect(queue.sent.length).toBe(1);
    expect(queue.sent[0]?.type).toBe("drain");

    // ctx.waitUntil should have registered the fast-path drain promise
    expect(waitUntilPromises.length).toBeGreaterThanOrEqual(1);

    // Let the fast-path drain complete
    await Promise.all(waitUntilPromises);

    // Verify task completed via fast-path drain
    const taskView = await store.task(scopeId, "99", receipt.taskId!);
    expect(taskView.task.state).toBe("completed");

    await store.close();
    rawDb.close();
  });
});

describe("Edge simulation reporting", () => {
  it("reports simulated when model credentials are absent", () => {
    const env = { DB: {} as never, TELEGRAM_BOT_TOKEN: "123:a",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot", TELEGRAM_WEBHOOK_SECRET: "edge-webhook-secret-token", GITHUB_TOKEN: "gh", ALLOWED_REPOSITORIES: "a/b" } as EdgeEnv;
    // The dangerous deploy: no model credentials, so every task is answered by a fixture
    // while the ledger would otherwise claim real usage.
    expect(edgeSimulationGaps(env)).toEqual(["model"]);
  });

  it("reports no gaps when every credential is present", () => {
    const env = { DB: {} as never, TELEGRAM_BOT_TOKEN: "123:a",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot", TELEGRAM_WEBHOOK_SECRET: "edge-webhook-secret-token", MODEL_API_KEY: "k", MODEL_NAME: "m", GITHUB_TOKEN: "gh", ALLOWED_REPOSITORIES: "a/b" } as EdgeEnv;
    expect(edgeSimulationGaps(env)).toEqual([]);
  });

  it("records simulated in the usage ledger when a fixture is in use", async () => {
    const rawDb = new DatabaseSync(":memory:");
    const d1 = createMockD1(rawDb);
    const env: EdgeEnv = { DB: d1, TELEGRAM_BOT_TOKEN: "123:a",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot", TELEGRAM_WEBHOOK_SECRET: "edge-webhook-secret-token", GITHUB_TOKEN: "gh", ALLOWED_REPOSITORIES: "a/b" };
    const { store } = await createEdgeWorker(env);
    const workspaceId = randomUUID();
    const scopeId = randomUUID();
    await store.seed({
      botId: randomUUID(),
      workspaceId,
      name: "Probe",
      ownerId: "owner",
      budgetMicros: 200_000,
      scopes: [{ id: scopeId, workspaceId, kind: "group", chatId: "-1001", ownerId: null, name: "Probe", active: true, workspacePublic: false, timezone: "UTC", policyRevision: 1, collectedSince: Date.now(), budgetMicros: 100_000 }],
      memberships: [{ scopeId, userId: "member", role: "member" }],
      grants: [],
    });
    const view = await store.view(scopeId, "member");
    expect(view.usage.simulated).toBe(true);
    await store.close();
    rawDb.close();
  });
});

describe("Edge fail-closed simulation contracts", () => {
  it("never records a simulated issue under a github.com URL", async () => {
    const connector = createInMemoryConnector();
    const receipt = await connector.invoke({
      call: { name: "github_create_issue", input: { repository: "a/b", title: "t", body: "b" } },
    } as any, new AbortController().signal);
    expect(receipt.url).not.toContain("github.com");
    expect(receipt.url).toContain("asmo-simulated.invalid");
    expect(receipt.providerId).toContain("simulated-");
    expect(receipt.content).toContain("No GitHub issue exists");
  });

  it("rejects a DeepSeek model without explicit prices", () => {
    const env = { DB: {} as never, TELEGRAM_BOT_TOKEN: "123:a",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot", TELEGRAM_WEBHOOK_SECRET: "edge-webhook-secret-token",
      MODEL_API_KEY: "k", MODEL_NAME: "m", MODEL_PROVIDER: "deepseek" } as EdgeEnv;
    // OpenAI rates must never silently price DeepSeek usage in the ledger.
    expect(() => resolveEdgeModelPrices(env)).toThrow("not defaulted");
    expect(() => createEdgeModel(env)).toThrow("not defaulted");
  });

  it("accepts explicit prices for either provider", () => {
    const base = { DB: {} as never, TELEGRAM_BOT_TOKEN: "123:a",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot", TELEGRAM_WEBHOOK_SECRET: "edge-webhook-secret-token",
      MODEL_API_KEY: "k", MODEL_NAME: "m",
      MODEL_INPUT_USD_PER_MILLION: "1", MODEL_CACHED_INPUT_USD_PER_MILLION: "0.5", MODEL_OUTPUT_USD_PER_MILLION: "2" } as EdgeEnv;
    expect(resolveEdgeModelPrices(base)).toEqual({ inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 2 });
    expect(createEdgeModel(base).simulated).toBe(false);
    expect(createEdgeModel({ ...base, MODEL_PROVIDER: "deepseek" }).simulated).toBe(false);
  });

  it("rejects a partial price override instead of mixing it with defaults", () => {
    const env = { DB: {} as never, TELEGRAM_BOT_TOKEN: "123:a",
      TELEGRAM_BOT_USERNAME: "asmo_test_bot", TELEGRAM_WEBHOOK_SECRET: "edge-webhook-secret-token",
      MODEL_API_KEY: "k", MODEL_NAME: "m", MODEL_INPUT_USD_PER_MILLION: "1" } as EdgeEnv;
    expect(() => resolveEdgeModelPrices(env)).toThrow("together");
  });
});
