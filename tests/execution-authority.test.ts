import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore } from "../src/store/index.js";
import { seedFixture } from "../src/fixture.js";
import { Worker } from "../src/worker.js";
import type { AuthorityVerifier, Scope, Store, Turn } from "../src/core.js";

describe("Execution and delivery current-member verification", () => {
  let directory: string;
  let store: Store;
  let now: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "asmo-exec-auth-"));
    now = Date.now();
    store = await openStore({
      databasePath: join(directory, "test.sqlite"),
      modelReserveMicros: 1000,
      maxOutputTokens: 2000,
      maxTurns: 12,
      taskBudgetMicros: 20000,
      leaseMs: 60000,
      simulated: true,
      clock: () => now,
    });
    await seedFixture(store);
  });

  afterEach(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("holds delivery when the requesting member has been removed from the Telegram chat", async () => {
    const authority: AuthorityVerifier = {
      refresh: vi.fn(async (scope: Scope, userId: string) => {
        if (userId === "101") {
          await store.membership(scope.id, userId, null);
          throw new Error("Access denied.");
        }
      }),
      botAdmin: vi.fn(async () => {}),
    };
    store.bindAuthority(authority);

    await store.command({
      scopeId: "engineering",
      userId: "101",
      key: "delivery-test-1",
      command: { kind: "start", instruction: "Do something", topicId: null },
    });

    const delivered: string[] = [];
    const messenger = {
      simulated: true,
      send: vi.fn(async (delivery) => {
        delivered.push(delivery.text);
        return { messageId: 9999 };
      }),
    };
    const worker = new Worker(
      store,
      { simulated: true, turn: async () => ({}) as unknown as Turn },
      { simulated: true, invoke: async () => ({ providerId: "p", url: null, content: "" }), reconcile: async () => ({ kind: "found", receipt: { providerId: "p", url: null, content: "" } }) },
      messenger
    );

    const worked = await worker.step("delivery-worker", undefined, "delivery");
    expect(worked).toBe(false);
    expect(messenger.send).not.toHaveBeenCalled();
    expect(authority.refresh).toHaveBeenCalledWith(expect.objectContaining({ id: "engineering" }), "101");

    const view = await store.view("engineering", "102");
    const task = view.tasks.find((t) => t.task.requesterId === "101");
    expect(task).toBeDefined();
    const deliveryHeldEvent = task?.events.find((e) => e.kind === "delivery_held");
    expect(deliveryHeldEvent).toBeDefined();
    expect((deliveryHeldEvent?.detail as Record<string, unknown>).reason).toBe("Current destination or requester access unavailable.");
  });

  it("holds delivery when the bot has lost administrator membership in the chat", async () => {
    const authority: AuthorityVerifier = {
      refresh: vi.fn(async () => {}),
      botAdmin: vi.fn(async () => {
        throw new Error("Asmo needs administrator membership for reliable member checks.");
      }),
    };
    store.bindAuthority(authority);

    await store.command({
      scopeId: "engineering",
      userId: "101",
      key: "delivery-test-bot",
      command: { kind: "start", instruction: "Check bot admin", topicId: null },
    });

    const messenger = {
      simulated: true,
      send: vi.fn(async () => ({ messageId: 9999 })),
    };
    const worker = new Worker(
      store,
      { simulated: true, turn: async () => ({}) as unknown as Turn },
      { simulated: true, invoke: async () => ({ providerId: "p", url: null, content: "" }), reconcile: async () => ({ kind: "found", receipt: { providerId: "p", url: null, content: "" } }) },
      messenger
    );

    const worked = await worker.step("delivery-worker", undefined, "delivery");
    expect(worked).toBe(false);
    expect(messenger.send).not.toHaveBeenCalled();
    expect(authority.botAdmin).toHaveBeenCalled();

    const view = await store.view("engineering", "102");
    const task = view.tasks.find((t) => t.task.requesterId === "101");
    const deliveryHeldEvent = task?.events.find((e) => e.kind === "delivery_held");
    expect(deliveryHeldEvent).toBeDefined();
    expect((deliveryHeldEvent?.detail as Record<string, unknown>).reason).toBe("Bot administrator access unavailable.");
  });

  it("denies effect execution and avoids connector invocation when requester was removed", async () => {
    const receipt = await store.command({
      scopeId: "engineering",
      userId: "101",
      key: "effect-auth-test-1",
      command: { kind: "start", instruction: "Create issue", topicId: null },
    });
    const taskId = receipt.taskId!;

    const modelJob = await store.claim("model-worker", "model");
    expect(modelJob).not.toBeNull();
    const toolCallId = randomUUID();
    await store.finishModel(modelJob as Extract<typeof modelJob, { kind: "model" }>, {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Proposing issue" },
          {
            type: "tool_use",
            id: toolCallId,
            name: "github_create_issue",
            input: { repository: "atlas/checkout", title: "Defect", body: "Details", labels: ["bug"] },
          },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 10, costMicros: 100, simulated: true, pricingRevision: "fixture" },
      requestId: "r1",
      outcome: "tools",
      sourceIds: [],
      limitations: [],
    });

    const taskBefore = await store.task("engineering", "102", taskId);
    const approval = taskBefore.approvals[0];
    if (!approval) throw new Error("Approval missing");
    await store.command({
      scopeId: "engineering",
      userId: "102",
      key: "decide-1",
      command: { kind: "decide", approvalId: approval.id, decision: "approve" },
    });

    const authority: AuthorityVerifier = {
      refresh: vi.fn(async (scope: Scope, userId: string) => {
        if (userId === "101") {
          await store.membership(scope.id, userId, null);
          throw new Error("Access denied.");
        }
      }),
      botAdmin: vi.fn(async () => {}),
    };
    store.bindAuthority(authority);

    const connector = {
      simulated: true,
      invoke: vi.fn(async () => ({ providerId: "gh", url: "https://github.com/issue/1", content: "{}" })),
      reconcile: vi.fn(async () => ({ kind: "found" as const, receipt: { providerId: "gh", url: null, content: "{}" } })),
    };
    const worker = new Worker(
      store,
      { simulated: true, turn: async () => ({}) as unknown as Turn },
      connector,
      { simulated: true, send: async () => ({ messageId: 1 }) }
    );

    const worked = await worker.step("effect-worker", undefined, "effect");
    expect(worked).toBe(false);
    expect(connector.invoke).not.toHaveBeenCalled();

    const taskAfter = await store.task("engineering", "102", taskId);
    const effect = taskAfter.effects[0];
    if (!effect) throw new Error("Effect missing");
    expect(effect.state).toBe("denied");
    expect(effect.reason).toMatch(/Membership changed|Current authorization denies dispatch/);
  });

  it("denies effect execution when the approving manager has been demoted to regular member", async () => {
    const receipt = await store.command({
      scopeId: "engineering",
      userId: "101",
      key: "effect-auth-test-demote",
      command: { kind: "start", instruction: "Create issue", topicId: null },
    });
    const taskId = receipt.taskId!;

    const modelJob = await store.claim("model-worker", "model");
    const toolCallId = randomUUID();
    await store.finishModel(modelJob as Extract<typeof modelJob, { kind: "model" }>, {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Proposing issue" },
          {
            type: "tool_use",
            id: toolCallId,
            name: "github_create_issue",
            input: { repository: "atlas/checkout", title: "Defect", body: "Details", labels: ["bug"] },
          },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 10, costMicros: 100, simulated: true, pricingRevision: "fixture" },
      requestId: "r2",
      outcome: "tools",
      sourceIds: [],
      limitations: [],
    });

    const taskBefore = await store.task("engineering", "102", taskId);
    const approval = taskBefore.approvals[0];
    if (!approval) throw new Error("Approval missing");
    await store.command({
      scopeId: "engineering",
      userId: "102",
      key: "decide-2",
      command: { kind: "decide", approvalId: approval.id, decision: "approve" },
    });

    const authority: AuthorityVerifier = {
      refresh: vi.fn(async (scope: Scope, userId: string) => {
        if (userId === "102") {
          await store.membership(scope.id, userId, "member");
        }
      }),
      botAdmin: vi.fn(async () => {}),
    };
    store.bindAuthority(authority);

    const connector = {
      simulated: true,
      invoke: vi.fn(async () => ({ providerId: "gh", url: "https://github.com/issue/2", content: "{}" })),
      reconcile: vi.fn(async () => ({ kind: "found" as const, receipt: { providerId: "gh", url: null, content: "{}" } })),
    };
    const worker = new Worker(
      store,
      { simulated: true, turn: async () => ({}) as unknown as Turn },
      connector,
      { simulated: true, send: async () => ({ messageId: 1 }) }
    );

    const worked = await worker.step("effect-worker", undefined, "effect");
    expect(worked).toBe(false);
    expect(connector.invoke).not.toHaveBeenCalled();

    const taskAfter = await store.task("engineering", "102", taskId);
    const effect = taskAfter.effects[0];
    if (!effect) throw new Error("Effect missing");
    expect(effect.state).toBe("denied");
    expect(effect.reason).toMatch(/Membership changed|Current authorization denies dispatch/);
  });

  it("blocks model turn when the requester has been removed before model dispatch", async () => {
    await store.command({
      scopeId: "engineering",
      userId: "101",
      key: "model-auth-test-1",
      command: { kind: "start", instruction: "Do research", topicId: null },
    });

    const authority: AuthorityVerifier = {
      refresh: vi.fn(async (scope: Scope, userId: string) => {
        if (userId === "101") {
          await store.membership(scope.id, userId, null);
          throw new Error("Access denied.");
        }
      }),
      botAdmin: vi.fn(async () => {}),
    };
    store.bindAuthority(authority);

    const modelTurn = vi.fn(async () => ({}) as unknown as Turn);
    const worker = new Worker(
      store,
      { simulated: true, turn: modelTurn },
      { simulated: true, invoke: async () => ({ providerId: "p", url: null, content: "" }), reconcile: async () => ({ kind: "found", receipt: { providerId: "p", url: null, content: "" } }) },
      { simulated: true, send: async () => ({ messageId: 1 }) }
    );

    const worked = await worker.step("model-worker", undefined, "model");
    expect(worked).toBe(false);
    expect(modelTurn).not.toHaveBeenCalled();

    const view = await store.view("engineering", "102");
    const task = view.tasks.find((t) => t.task.requesterId === "101");
    expect(task?.task.state).toBe("blocked");
    expect(task?.task.reason).toBe("Current scope or requester access unavailable.");
  });

  it("holds delivery when the membership check cannot run", async () => {
    const authority: AuthorityVerifier = {
      // Capacity exhaustion or a Telegram failure rejects without persisting a demotion.
      // Execution must not fall back to the stored role when the check could not run.
      refresh: vi.fn(async () => { throw new Error("Membership check capacity reached."); }),
      botAdmin: vi.fn(async () => {}),
    };
    store.bindAuthority(authority);

    await store.command({
      scopeId: "engineering",
      userId: "101",
      key: "delivery-test-unavailable",
      command: { kind: "start", instruction: "Do something", topicId: null },
    });

    const messenger = { simulated: true, send: vi.fn(async () => ({ messageId: 9999 })) };
    const worker = new Worker(
      store,
      { simulated: true, turn: async () => ({}) as unknown as Turn },
      { simulated: true, invoke: async () => ({ providerId: "p", url: null, content: "" }), reconcile: async () => ({ kind: "found", receipt: { providerId: "p", url: null, content: "" } }) },
      messenger
    );

    const worked = await worker.step("delivery-worker", undefined, "delivery");
    expect(worked).toBe(false);
    expect(messenger.send).not.toHaveBeenCalled();

    const view = await store.view("engineering", "102");
    const task = view.tasks.find((t) => t.task.requesterId === "101");
    expect(task?.events.some((event) => event.kind === "delivery_held")).toBe(true);
  });

  it("executes effect and delivers normally when current authority is verified and valid", async () => {
    const authority: AuthorityVerifier = {
      refresh: vi.fn(async () => {}),
      botAdmin: vi.fn(async () => {}),
    };
    store.bindAuthority(authority);

    const receipt = await store.command({
      scopeId: "engineering",
      userId: "101",
      key: "happy-path-test",
      command: { kind: "start", instruction: "Create issue", topicId: null },
    });
    const taskId = receipt.taskId!;

    const connector = {
      simulated: true,
      invoke: vi.fn(async () => ({ providerId: "gh-123", url: "https://github.com/issue/123", content: "Created" })),
      reconcile: vi.fn(async () => ({ kind: "found" as const, receipt: { providerId: "gh-123", url: "https://github.com/issue/123", content: "Created" } })),
    };
    const messenger = { simulated: true, send: vi.fn(async () => ({ messageId: 1 })) };
    const worker = new Worker(
      store,
      { simulated: true, turn: async () => ({}) as unknown as Turn },
      connector,
      messenger
    );

    const delivered = await worker.step("delivery-worker", undefined, "delivery");
    expect(delivered).toBe(true);
    expect(messenger.send).toHaveBeenCalled();

    const modelJob = await store.claim("model-worker", "model");
    expect(modelJob).not.toBeNull();
    const toolCallId = randomUUID();
    await store.finishModel(modelJob as Extract<typeof modelJob, { kind: "model" }>, {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Proposing issue" },
          {
            type: "tool_use",
            id: toolCallId,
            name: "github_create_issue",
            input: { repository: "atlas/checkout", title: "Defect", body: "Details", labels: ["bug"] },
          },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 10, costMicros: 100, simulated: true, pricingRevision: "fixture" },
      requestId: "r3",
      outcome: "tools",
      sourceIds: [],
      limitations: [],
    });

    const taskBefore = await store.task("engineering", "102", taskId);
    const approval = taskBefore.approvals[0];
    if (!approval) throw new Error("Approval missing");
    await store.command({
      scopeId: "engineering",
      userId: "102",
      key: "decide-3",
      command: { kind: "decide", approvalId: approval.id, decision: "approve" },
    });

    const worked = await worker.step("effect-worker", undefined, "effect");
    expect(worked).toBe(true);
    expect(connector.invoke).toHaveBeenCalled();

    const taskAfter = await store.task("engineering", "102", taskId);
    const effect = taskAfter.effects[0];
    if (!effect) throw new Error("Effect missing");
    expect(effect.state).toBe("succeeded");
    expect(effect.providerId).toBe("gh-123");
  });
});
