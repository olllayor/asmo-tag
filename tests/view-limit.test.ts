import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Job, type NormalizedUpdate, type Scope, type Seed, type Store, type StoreOptions, type Turn } from "../src/core.js";
import { openStore } from "../src/store/index.js";

type ModelJobAlias = Extract<Job, { kind: "model" }>;
type EffectJobAlias = Extract<Job, { kind: "effect" }>;

describe("view payload limits and per-task sources", () => {
  let store: Store;
  let options: StoreOptions & { databasePath: string };
  let seed: Seed;
  let scope: Scope;
  let now: number;
  let updateId: number;
  let deliveryMessageId: number;
  let directory: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "asmo-view-"));
    now = 1_700_000_000_000;
    updateId = 0;
    deliveryMessageId = 2_000_000;
    const workspaceId = randomUUID();
    options = { databasePath: join(directory, "store.sqlite"), modelReserveMicros: 1000, maxOutputTokens: 2000, maxTurns: 12, taskBudgetMicros: 20_000, leaseMs: 10_000, simulated: true, clock: () => now, workspaceIds: [workspaceId] };
    store = await openStore(options);
    scope = { id: randomUUID(), workspaceId, kind: "group", chatId: `-${randomUUID()}`, ownerId: null, name: "Operations", active: true, workspacePublic: false, timezone: "UTC", policyRevision: 1, collectedSince: now - 1000, budgetMicros: 100_000 };
    seed = {
      botId: randomUUID(),
      workspaceId,
      name: "View limit workspace",
      ownerId: "owner",
      budgetMicros: 200_000,
      scopes: [scope],
      memberships: [{ scopeId: scope.id, userId: "member", role: "member" }],
      grants: [{ id: randomUUID(), scopeId: scope.id, repository: "fixture/engineering", read: true, write: true, active: true, revision: 1 }],
    };
    await store.seed(seed);
  });
  afterEach(async () => { await store?.close(); rmSync(directory, { recursive: true, force: true }); });

  function message(text: string, messageId: number, extra: Partial<Extract<NormalizedUpdate, { kind: "message" }>> = {}): Extract<NormalizedUpdate, { kind: "message" }> {
    return { kind: "message", botId: seed.botId, updateId: ++updateId, chatId: scope.chatId, userId: "member", messageId, topicId: null, text, mentioned: false, replyTo: null, edited: false, ...extra };
  }

  async function capturePassive(count: number, firstMessageId: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const receipt = await store.ingest(message(`housekeeping chatter ${firstMessageId + index}`, firstMessageId + index));
      expect(receipt.kind).toBe("ignored");
    }
  }

  async function startViaMention(instruction: string, messageId: number): Promise<string> {
    const receipt = await store.ingest(message(instruction, messageId, { mentioned: true }));
    expect(receipt.kind).toBe("accepted");
    if (!receipt.taskId) throw new Error("Task missing");
    return receipt.taskId;
  }

  async function startCommand(instruction: string): Promise<string> {
    const receipt = await store.command({ scopeId: scope.id, userId: "member", key: randomUUID(), command: { kind: "start", instruction, topicId: null } });
    expect(receipt.kind).toBe("accepted");
    if (!receipt.taskId) throw new Error("Task missing");
    return receipt.taskId;
  }

  function turn(text: string, extra: Partial<Turn> = {}): Turn {
    return { message: { role: "assistant", content: [{ type: "text", text }] }, usage: { inputTokens: 30, outputTokens: 20, costMicros: 1000, simulated: true, pricingRevision: "fixture-v1" }, requestId: randomUUID(), outcome: "complete", sourceIds: [], limitations: [], ...extra };
  }

  async function claimJob(): Promise<ModelJobAlias | EffectJobAlias> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const job = await store.claim("view-worker");
      if (!job) break;
      if (job.kind === "delivery") await store.finishDelivery(job, ++deliveryMessageId);
      else return job;
    }
    throw new Error("Expected a queued model or effect job");
  }
  async function claimModel(): Promise<ModelJobAlias> {
    const job = await claimJob();
    if (job.kind !== "model") throw new Error("Expected a model job");
    return job;
  }
  async function claimEffect(): Promise<EffectJobAlias> {
    const job = await claimJob();
    if (job.kind !== "effect") throw new Error("Expected an effect job");
    return job;
  }

  // Every start and finished turn queues acknowledgement or answer deliveries, and an
  // unclaimed model job counts against the workspace admission limit. Draining keeps a
  // batch of starts below the 500-job cap and leaves completed tasks behind.
  async function drainJobs(): Promise<void> {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const job = await store.claim("batch-worker");
      if (!job) return;
      if (job.kind === "model") await store.finishModel(job, turn("Batch answer recorded.", { sourceIds: [] }));
      else if (job.kind === "delivery") await store.finishDelivery(job, ++deliveryMessageId);
      else throw new Error("Unexpected effect job in the batch");
    }
    throw new Error("Batch job queue did not settle");
  }

  it("does not repeat the scope's captured sources in every task record", async () => {
    const passiveCount = 30;
    await capturePassive(passiveCount, 500);
    for (let index = 0; index < 3; index += 1) {
      now += 1000;
      await startViaMention(`Investigate topic ${index}`, 600 + index);
    }
    const view = await store.view(scope.id, "member");
    expect(view.limited).toBe(false);
    expect(view.tasks).toHaveLength(3);
    const listed = view.tasks.flatMap(item => item.sources);
    // Three tasks with a scope of 31 captured sources used to ship 3x31 records. Every task
    // now carries exactly its own linked capture, so the response holds three records.
    expect(listed.length).toBeLessThan(passiveCount);
    expect(new Set(listed.map(source => source.id)).size).toBe(3);
    for (const item of view.tasks) expect(item.sources).toHaveLength(1);
    for (const source of listed) expect(source.text.startsWith("housekeeping chatter")).toBe(false);
  });

  it("keeps every cited view source resolvable from its task record", async () => {
    await capturePassive(10, 700);
    now += 1000;
    const taskId = await startViaMention("Summarize the chatter", 800);
    const job = await claimModel();
    const initial = job.input.sources.find(source => source.messageId === 800);
    const cited = job.input.sources.filter(source => source.text.startsWith("housekeeping chatter"));
    if (!initial || cited.length !== 10 || !cited[4]) throw new Error("Model input window missing linked captures");
    await store.finishModel(job, turn("All chatter accounted for.", { sourceIds: [cited[4].id] }));
    const view = await store.view(scope.id, "member");
    const item = view.tasks.find(entry => entry.task.id === taskId);
    if (!item) throw new Error("Task view missing");
    expect(item.task.result?.sourceIds).toEqual([cited[4].id]);
    const written = [...new Set([initial.id, cited[4].id])].sort();
    expect(item.sources.map(source => source.id).sort()).toEqual(written);
  });

  it("attaches the task's own tool receipt sources when the effect completes", async () => {
    now += 1000;
    const taskId = await startViaMention("Read open issues", 820);
    const model = await claimModel();
    await store.finishModel(model, turn("", { outcome: "tools", message: { role: "assistant", content: [{ type: "text", text: "Reading now." }, { type: "tool_use", id: randomUUID(), name: "github_read_issues", input: { repository: "fixture/engineering" } }] } }));
    const before = await store.view(scope.id, "member");
    expect(before.tasks.map(item => item.task.id)).toContain(taskId);
    const effect = (await store.task(scope.id, "member", taskId)).effects[0];
    if (!effect) throw new Error("Effect missing");
    await store.finishEffect(await claimEffect(), { providerId: "read-result", url: null, content: "Returned issue list 42" });
    const view = await store.view(scope.id, "member");
    const item = view.tasks.find(entry => entry.task.id === taskId);
    if (!item) throw new Error("Task view missing");
    expect(item.effects[0]?.result).toBe("Returned issue list 42");
    const tool = item.sources.filter(source => source.kind === "tool");
    expect(tool).toHaveLength(1);
    expect(tool[0]?.text).toBe("Returned issue list 42");
    const instructionSource = item.sources.filter(source => source.messageId === 820);
    expect(instructionSource).toHaveLength(1);
  });

  it("reports limited false when the scope holds few tasks", async () => {
    await startCommand("Solo batch task");
    const view = await store.view(scope.id, "member");
    expect(view.tasks).toHaveLength(1);
    expect(view.limited).toBe(false);
  });

  it("caps one view response on the task limit and reports the truncation", async () => {
    for (let index = 0; index < 205; index += 1) {
      now += 1000;
      await startCommand(`Batch task ${index}`);
      await drainJobs();
    }
    const view = await store.view(scope.id, "member");
    expect(view.tasks).toHaveLength(200);
    expect(view.limited).toBe(true);
    // Newest tasks survive the cap, oldest are the records that were dropped.
    expect(view.tasks[0]?.task.instruction).toBe("Batch task 204");
    expect(view.tasks.some(item => item.task.instruction === "Batch task 4")).toBe(false);
  }, 20_000);

  it("includes an older deep-linked task in the capped view response", async () => {
    const oldestTaskId = await startCommand("Oldest deep linked task");
    await drainJobs();
    for (let index = 0; index < 205; index += 1) {
      now += 1000;
      await startCommand(`Subsequent task ${index}`);
      await drainJobs();
    }
    const cappedView = await store.view(scope.id, "member");
    expect(cappedView.tasks.some(t => t.task.id === oldestTaskId)).toBe(false);

    const deepLinkedView = await store.view(scope.id, "member", oldestTaskId);
    expect(deepLinkedView.tasks.some(t => t.task.id === oldestTaskId)).toBe(true);
    expect(deepLinkedView.tasks.find(t => t.task.id === oldestTaskId)?.task.instruction).toBe("Oldest deep linked task");
  }, 20_000);
});
