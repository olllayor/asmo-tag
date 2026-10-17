import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Command, Job, NormalizedUpdate, Scope, Seed, Store, StoreOptions, Turn } from "../src/core.js";
import { openStore } from "../src/store/index.js";

type ModelJob = Extract<Job, { kind: "model" }>;

describe("Memory write policy: evidence, caps, CAS, and terminal invalidation", () => {
  let store: Store;
  let options: StoreOptions & { databasePath: string };
  let seed: Seed;
  let scope: Scope;
  let dmScope: Scope;
  let now: number;
  let updateId: number;
  let deliveryMessageId: number;
  let workspaceIds: string[];
  let directory: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "asmo-memory-policy-"));
    now = Date.now();
    updateId = 0;
    deliveryMessageId = 1_000_000;
    const workspaceId = randomUUID();
    workspaceIds = [workspaceId];
    options = { databasePath: join(directory, "store.sqlite"), modelReserveMicros: 1000, maxOutputTokens: 2000, maxTurns: 12, taskBudgetMicros: 20_000, leaseMs: 10_000, simulated: true, clock: () => now, workspaceIds };
    store = await openStore(options);
    scope = { id: randomUUID(), workspaceId, kind: "group", chatId: `-${randomUUID()}`, ownerId: null, name: "Engineering", active: true, workspacePublic: false, timezone: "UTC", policyRevision: 1, collectedSince: now - 1000, budgetMicros: 100_000 };
    const otherScope = { ...scope, id: randomUUID(), chatId: `-${randomUUID()}`, name: "Private other group" };
    dmScope = { ...scope, id: randomUUID(), chatId: randomUUID(), kind: "dm", ownerId: "member", name: "Member DM" };
    seed = { botId: randomUUID(), workspaceId, name: "Memory policy workspace", ownerId: "owner", budgetMicros: 200_000, scopes: [scope, otherScope, dmScope], memberships: [{ scopeId: scope.id, userId: "member", role: "member" }, { scopeId: scope.id, userId: "manager", role: "manager" }, { scopeId: scope.id, userId: "owner", role: "owner" }, { scopeId: otherScope.id, userId: "other", role: "member" }, { scopeId: dmScope.id, userId: "member", role: "member" }], grants: [] };
    await store.seed(seed);
  });
  afterEach(async () => { await store?.close(); rmSync(directory, { recursive: true, force: true }); });
  async function command(command: Command, userId = "member", key = randomUUID()) {
    return store.command({ scopeId: scope.id, userId, key, command });
  }
  async function start(instruction = "Investigate memory context") {
    const receipt = await command({ kind: "start", instruction, topicId: null });
    expect(receipt.kind).toBe("accepted");
    if (!receipt.taskId) throw new Error("Task missing");
    return receipt.taskId;
  }
  function message(text: string, options: Partial<Extract<NormalizedUpdate, { kind: "message" }>> = {}): Extract<NormalizedUpdate, { kind: "message" }> {
    return { kind: "message", botId: seed.botId, updateId: ++updateId, chatId: scope.chatId, userId: "member", messageId: updateId, topicId: null, text, mentioned: false, replyTo: null, edited: false, ...options };
  }
  function turn(text = "Fixture result"): Turn {
    return { message: { role: "assistant", content: [{ type: "text", text }] }, usage: { inputTokens: 30, outputTokens: 20, costMicros: 1000, simulated: true, pricingRevision: "fixture-v1" }, requestId: randomUUID(), outcome: "complete", sourceIds: [], limitations: [] };
  }
  async function claimModel(): Promise<ModelJob> {
    for (let index = 0; index < 100; index += 1) {
      const job = await store.claim("policy-worker");
      if (!job) throw new Error("Model job missing");
      if (job.kind === "model") return job;
      if (job.kind === "delivery") { await store.finishDelivery(job, ++deliveryMessageId); continue; }
      throw new Error(`Unexpected ${job.kind} job without a task`);
    }
    throw new Error("Delivery queue did not drain");
  }
  async function saveFactByChat(text = "Chat saved fact without manual evidence ids") {
    const receipt = await store.ingest(message(`/remember ${text}`));
    expect(receipt.kind).toBe("accepted");
    const memory = (await store.view(scope.id, "member")).memories.find(item => item.content === text);
    if (!memory) throw new Error("Chat-saved memory missing");
    return memory;
  }

  it("stores an evidence-free member note as a candidate that stays out of task retrieval", async () => {
    const receipt = await command({ kind: "remember", content: "Members claim X", evidenceIds: [], candidate: false });
    expect(receipt.kind).toBe("accepted");
    expect(receipt.message).toContain("candidate");
    const stored = (await store.view(scope.id, "member")).memories.find(item => item.content === "Members claim X");
    expect(stored?.state).toBe("candidate");

    await start();
    const model = await claimModel();
    expect(model.input.memories).toHaveLength(0);
    await store.finishModel(model, turn());

    const accepted = await command({ kind: "set_memory", memoryId: stored?.id ?? "", state: "active", expectedRevision: stored?.revision ?? 0 }, "manager");
    expect(accepted.kind).toBe("accepted");
    const managerActivated = (await store.view(scope.id, "member")).memories.find(item => item.content === "Members claim X");
    expect(managerActivated?.state).toBe("active");
    await start("Second look after acceptance");
    const next = await claimModel();
    expect(next.input.memories.map(item => item.content)).toEqual(["Members claim X"]);
    await store.finishModel(next, turn());
  });

  it("stores a member note with resolvable evidence as active and retrieves it", async () => {
    const chatSaved = await saveFactByChat("Deploy freezes on Fridays");
    expect(chatSaved.state).toBe("active");
    expect(chatSaved.evidenceIds).toHaveLength(1);
    await start();
    const model = await claimModel();
    expect(model.input.memories.map(item => item.content)).toEqual(["Deploy freezes on Fridays"]);
    await store.finishModel(model, turn());

    const receipt = await command({ kind: "remember", content: "Second fact with the same evidence", evidenceIds: chatSaved.evidenceIds, candidate: false });
    expect(receipt.kind).toBe("accepted");
    expect(receipt.message).toBeUndefined();
    expect((await store.view(scope.id, "member")).memories.find(item => item.content === "Second fact with the same evidence")?.state).toBe("active");
  });

  it("lets a manager save an active note without evidence while members need evidence", async () => {
    const receipt = await command({ kind: "remember", content: "Manager judgement call", evidenceIds: [], candidate: false }, "manager");
    expect(receipt.kind).toBe("accepted");
    expect(receipt.message).toBeUndefined();
    expect((await store.view(scope.id, "owner")).memories.find(item => item.content === "Manager judgement call")?.state).toBe("active");
  });

  it("denies unknown and deleted evidence ids", async () => {
    const unknown = await command({ kind: "remember", content: "Ghost evidence", evidenceIds: [randomUUID()], candidate: false });
    expect(unknown.kind).toBe("denied");

    const chatSaved = await saveFactByChat("Evidence soon to be forgotten");
    const removed = await command({ kind: "forget_sources", sourceIds: chatSaved.evidenceIds }, "manager");
    expect(removed.kind).toBe("accepted");
    const afterRemoval = (await store.view(scope.id, "member")).memories.find(item => item.id === chatSaved.id);
    expect(afterRemoval?.state).toBe("invalidated");
    const stale = await command({ kind: "remember", content: "Evidence removed already", evidenceIds: chatSaved.evidenceIds, candidate: false });
    expect(stale.kind).toBe("denied");
    expect(stale.message).toContain("Evidence unavailable");
  });

  it("denies set_memory edits without the current revision and applies the right one", async () => {
    const stored = await saveFactByChat("Revision guarded fact");
    expect(stored.state).toBe("active");

    const missing = await command({ kind: "set_memory", memoryId: stored.id, state: "invalidated" }, "member");
    expect(missing.kind).toBe("denied");
    expect(missing.message).toContain("Memory changed");
    const stale = await command({ kind: "set_memory", memoryId: stored.id, state: "invalidated", expectedRevision: stored.revision + 3 }, "member");
    expect(stale.kind).toBe("denied");
    const current = await command({ kind: "set_memory", memoryId: stored.id, state: "invalidated", expectedRevision: stored.revision }, "member");
    expect(current.kind).toBe("accepted");
    expect((await store.view(scope.id, "member")).memories.find(item => item.id === stored.id)?.state).toBe("invalidated");

    const memberWithout = await command({ kind: "set_memory", memoryId: stored.id, state: "active" }, "member");
    expect(memberWithout.kind).toBe("denied");
    const rejected = await command({ kind: "set_memory", memoryId: stored.id, state: "rejected", expectedRevision: stored.revision + 1 }, "owner");
    expect(rejected.kind).toBe("accepted");
  });

  it("keeps invalidation terminal for members and restorable for managers", async () => {
    const stored = await saveFactByChat("Forgotten fact resurrection attempt");
    const forget = await command({ kind: "forget_sources", sourceIds: stored.evidenceIds }, "manager");
    expect(forget.kind).toBe("accepted");
    const invalidated = (await store.view(scope.id, "member")).memories.find(item => item.id === stored.id);
    expect(invalidated?.state).toBe("invalidated");
    expect(invalidated?.revision).toBeGreaterThan(stored.revision);

    const memberActivate = await command({ kind: "set_memory", memoryId: stored.id, state: "active", expectedRevision: invalidated?.revision ?? 0 }, "member");
    expect(memberActivate.kind).toBe("denied");
    expect(memberActivate.message).toContain("Forgotten memory");
    const memberCorrect = await command({ kind: "correct_memory", memoryId: stored.id, expectedRevision: invalidated?.revision ?? 0, content: "Rewritten while forgotten" }, "member");
    expect(memberCorrect.kind).toBe("denied");
    const memberReforgotten = await command({ kind: "set_memory", memoryId: stored.id, state: "invalidated", expectedRevision: invalidated?.revision ?? 0 }, "member");
    expect(memberReforgotten.kind).toBe("accepted");

    const managerActivate = await command({ kind: "set_memory", memoryId: stored.id, state: "active", expectedRevision: (invalidated?.revision ?? 0) + 1 }, "manager");
    expect(managerActivate.kind).toBe("accepted");
    const restored = (await store.view(scope.id, "member")).memories.find(item => item.id === stored.id);
    expect(restored?.state).toBe("active");
  });

  it("keeps a member correction on a pending note out of active retrieval", async () => {
    const receipt = await command({ kind: "remember", content: "Uncorrected claim", evidenceIds: [], candidate: false }, "member");
    expect(receipt.kind).toBe("accepted");
    const stored = (await store.view(scope.id, "member")).memories.find(item => item.content === "Uncorrected claim");
    if (!stored) throw new Error("Candidate memory missing");
    const corrected = await command({ kind: "correct_memory", memoryId: stored.id, expectedRevision: stored.revision, content: "Evidence backed correction" }, "member");
    expect(corrected.kind).toBe("accepted");
    const after = (await store.view(scope.id, "member")).memories.find(item => item.id === stored.id);
    expect(after?.state).toBe("candidate");
    expect(after?.content).toBe("Evidence backed correction");
    expect(after?.correctedByHuman).toBe(true);
  });

  it("caps both candidate and active memories per scope", async () => {
    for (let index = 0; index < 20; index += 1) {
      const receipt = await command({ kind: "remember", content: `Candidate ${index}`, evidenceIds: [], candidate: false });
      expect(receipt.kind).toBe("accepted");
    }
    const overflow = await command({ kind: "remember", content: "Candidate 21", evidenceIds: [], candidate: false });
    expect(overflow.kind).toBe("denied");
    expect(overflow.message).toContain("candidate memory limit");
    expect((await store.view(scope.id, "member")).memories.filter(item => item.state === "candidate")).toHaveLength(20);

    for (let index = 0; index < 20; index += 1) {
      const receipt = await command({ kind: "remember", content: `Active ${index}`, evidenceIds: [], candidate: false }, "manager");
      expect(receipt.kind).toBe("accepted");
    }
    const activeOverflow = await command({ kind: "remember", content: "Active 21", evidenceIds: [], candidate: false }, "manager");
    expect(activeOverflow.kind).toBe("denied");
    expect(activeOverflow.message).toContain("active memory limit");
    expect((await store.view(scope.id, "member")).memories.filter(item => item.state === "active")).toHaveLength(20);
  });

  it("lets a DM owner save an evidence-free note and restore what they forgot", async () => {
    const receipt = await store.command({ scopeId: dmScope.id, userId: "member", key: randomUUID(), command: { kind: "remember", content: "Private DM note", evidenceIds: [], candidate: false } });
    expect(receipt.kind).toBe("accepted");
    const memory = (await store.view(dmScope.id, "member")).memories.find(item => item.content === "Private DM note");
    if (!memory) throw new Error("DM memory missing");
    expect(memory.state).toBe("active");
    expect((await store.command({ scopeId: dmScope.id, userId: "member", key: randomUUID(), command: { kind: "set_memory", memoryId: memory.id, state: "invalidated", expectedRevision: memory.revision } })).kind).toBe("accepted");
    expect((await store.command({ scopeId: dmScope.id, userId: "member", key: randomUUID(), command: { kind: "set_memory", memoryId: memory.id, state: "active", expectedRevision: memory.revision + 1 } })).kind).toBe("accepted");
  });

  it("counts rejected notes against the candidate budget", async () => {
    for (let index = 0; index < 20; index += 1) expect((await command({ kind: "remember", content: `Parked ${index}`, evidenceIds: [], candidate: false })).kind).toBe("accepted");
    const first = (await store.view(scope.id, "member")).memories.find(item => item.state === "candidate");
    if (!first) throw new Error("Candidate missing");
    expect((await command({ kind: "set_memory", memoryId: first.id, state: "rejected", expectedRevision: first.revision })).kind).toBe("accepted");
    const overflow = await command({ kind: "remember", content: "Parked overflow", evidenceIds: [], candidate: false });
    expect(overflow.kind).toBe("denied");
    expect(overflow.message).toContain("candidate memory limit");
  });

  it("does not apply the active cap to a pending member correction", async () => {
    for (let index = 0; index < 20; index += 1) expect((await command({ kind: "remember", content: `Active fact ${index}`, evidenceIds: [], candidate: false }, "manager")).kind).toBe("accepted");
    expect((await command({ kind: "remember", content: "Pending correction target", evidenceIds: [], candidate: false })).kind).toBe("accepted");
    const pending = (await store.view(scope.id, "member")).memories.find(item => item.content === "Pending correction target");
    if (!pending) throw new Error("Pending memory missing");
    expect((await command({ kind: "correct_memory", memoryId: pending.id, expectedRevision: pending.revision, content: "Corrected while pending" })).kind).toBe("accepted");
    expect((await store.view(scope.id, "member")).memories.find(item => item.id === pending.id)?.state).toBe("candidate");
  });
});
