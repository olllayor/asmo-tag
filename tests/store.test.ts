import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextWallClockInstant, wallClockInstant, type Command, type Job, type NormalizedUpdate, type Scope, type Seed, type Store, type StoreOptions, type Turn } from "../src/core.js";
import { openStore } from "../src/store/index.js";
import { createResponsesModel } from "../src/providers/responses.js";
import { contextCoverageLimitation } from "../src/conversation.js";


type ModelJob = Extract<Job, { kind: "model" }>;
type EffectJob = Extract<Job, { kind: "effect" }>;
type DeliveryJob = Extract<Job, { kind: "delivery" }>;

describe("SQLite task lifecycle with simulated integrations", () => {
  let store: Store;
  let options: StoreOptions;
  let seed: Seed;
  let scope: Scope;
  let otherScope: Scope;
  let now: number;
  let updateId: number;
  let deliveryMessageId: number;
  let workspaceIds: string[];
  let directory: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "asmo-store-"));
    now = Date.now();
    updateId = 0;
    deliveryMessageId = 1_000_000;
    const workspaceId = randomUUID();
    workspaceIds = [workspaceId];
    options = { databasePath: join(directory, "store.sqlite"), modelReserveMicros: 1000, maxOutputTokens: 2000, maxTurns: 12, taskBudgetMicros: 20_000, leaseMs: 10_000, simulated: true, clock: () => now, workspaceIds };
    store = await openStore(options);
    scope = { id: randomUUID(), workspaceId, kind: "group", chatId: `-${randomUUID()}`, ownerId: null, name: "Engineering", active: true, workspacePublic: false, timezone: "UTC", policyRevision: 1, collectedSince: now - 1000, budgetMicros: 100_000 };
    otherScope = { ...scope, id: randomUUID(), chatId: `-${randomUUID()}`, name: "Private other group" };
    seed = { botId: randomUUID(), workspaceId, name: "Synthetic integration workspace", ownerId: "owner", budgetMicros: 200_000, scopes: [scope, otherScope], memberships: [{ scopeId: scope.id, userId: "member", role: "member" }, { scopeId: scope.id, userId: "manager", role: "manager" }, { scopeId: scope.id, userId: "owner", role: "owner" }, { scopeId: otherScope.id, userId: "other", role: "member" }], grants: [{ id: randomUUID(), scopeId: scope.id, repository: "fixture/engineering", read: true, write: true, active: true, revision: 1 }] };
    await store.seed(seed);
  });
  afterEach(async () => { await store?.close(); rmSync(directory, { recursive: true, force: true }); });
  async function command(command: Command, userId = "member", key = randomUUID()) {
    return store.command({ scopeId: scope.id, userId, key, command });
  }
  async function start(instruction = "Investigate fixture work") {
    const receipt = await command({ kind: "start", instruction, topicId: null });
    expect(receipt.kind).toBe("accepted");
    expect(receipt.taskId).toBeDefined();
    if (!receipt.taskId) throw new Error("Task missing");
    return receipt.taskId;
  }
  function message(text: string, messageId: number, options: Partial<Extract<NormalizedUpdate, { kind: "message" }>> = {}): Extract<NormalizedUpdate, { kind: "message" }> {
    return { kind: "message", botId: seed.botId, updateId: ++updateId, chatId: scope.chatId, userId: "member", messageId, topicId: null, text, mentioned: false, replyTo: null, edited: false, ...options };
  }
  async function claimNonDelivery(): Promise<ModelJob | EffectJob | null> {
    for (let index = 0; index < 100; index += 1) {
      const job = await store.claim("integration-worker");
      if (!job || job.kind !== "delivery") return job;
      await store.finishDelivery(job, ++deliveryMessageId);
    }
    throw new Error("Delivery queue did not drain");
  }
  async function claimModel(): Promise<ModelJob> {
    const job = await claimNonDelivery();
    if (job?.kind !== "model") throw new Error(`Expected model, received ${job?.kind ?? "idle"}`);
    return job;
  }
  async function claimEffect(): Promise<EffectJob> {
    const job = await claimNonDelivery();
    if (job?.kind !== "effect") throw new Error(`Expected effect, received ${job?.kind ?? "idle"}`);
    return job;
  }
  function turn(text = "Fixture result", extra: Partial<Turn> = {}): Turn {
    return { message: { role: "assistant", content: [{ type: "text", text }] }, usage: { inputTokens: 30, outputTokens: 20, costMicros: 1000, simulated: true, pricingRevision: "fixture-v1" }, requestId: randomUUID(), outcome: "complete", sourceIds: [], limitations: [], ...extra };
  }
  async function draftWrite() {
    const taskId = await start("Draft an exact GitHub issue");
    const job = await claimModel();
    await store.finishModel(job, turn("", { outcome: "tools", message: { role: "assistant", content: [{ type: "text", text: "Here is the exact issue." }, { type: "tool_use", id: randomUUID(), name: "github_create_issue", input: { repository: "fixture/engineering", title: "Fixture defect", body: "Exact simulated issue body", labels: ["bug"] } }] } }));
    const view = await store.task(scope.id, "member", taskId);
    const approval = view.approvals[0];
    if (!approval) throw new Error("Approval missing");
    return { taskId, approval, effect: view.effects[0] };
  }

  it("keeps exact write approval text outside the Markdown response path", async () => {
    const { approval } = await draftWrite();
    const pending = await store.claim("approval-delivery-worker");
    if (pending?.kind !== "delivery") throw new Error("Approval delivery missing");
    expect(pending.delivery.buttons).toEqual([{ text: "Approve", data: `approve:${approval.id}` }, { text: "Deny", data: `deny:${approval.id}` }]);
    expect(pending.delivery.text).toContain("Exact simulated issue body");
    expect(pending.delivery.format).toBeUndefined();
  });

  it("binds Notion reads to its own grant and fences a queued read on disconnect", async () => {
    const connectionId = randomUUID();
    await expect(store.connectNotionGrant(scope.id, "member", connectionId, 1, randomUUID())).rejects.toThrow("management denied");
    const initial = await start("Find the selected Notion plan");
    const deniedModel = await claimModel();
    expect(deniedModel.input.tools).not.toContain("notion_search");
    await store.finishModel(deniedModel, turn("", { outcome: "tools", message: { role: "assistant", content: [{ type: "tool_use", id: randomUUID(), name: "notion_search", input: { query: "plan" } }] } }));
    expect((await store.task(scope.id, "member", initial)).effects[0]?.state).toBe("denied");
    await store.finishModel(await claimModel(), turn("Search unavailable"));
    await store.connectNotionGrant(scope.id, "manager", connectionId, 1, randomUUID());
    const taskId = await start("Read selected Notion pages");
    const model = await claimModel();
    expect(model.input.tools).toContain("notion_search");
    await store.finishModel(model, turn("", { outcome: "tools", message: { role: "assistant", content: [{ type: "tool_use", id: randomUUID(), name: "notion_read_page", input: { pageId: randomUUID() } }] } }));
    const prepared = (await store.task(scope.id, "member", taskId)).effects[0];
    expect(prepared).toMatchObject({ state: "ready", connectionId, connectionVersion: 1 });
    expect((await store.task(scope.id, "member", taskId)).approvals).toHaveLength(0);
    await store.disconnectRepositoryGrants(scope.id, "manager", connectionId);
    expect((await store.task(scope.id, "member", taskId)).effects[0]?.state).toBe("denied");
    const fresh = await claimModel();
    expect(fresh.input.tools).not.toContain("notion_read_page");
  });

  it("reconnecting a GitHub account invalidates an already approved exact write", async () => {
    const connectionId = randomUUID();
    await store.connectRepositoryGrants(scope.id, "manager", connectionId, 1, ["fixture/engineering"]);
    const draft = await draftWrite();
    expect(draft.effect).toMatchObject({ connectionId, connectionVersion: 1 });
    await command({ kind: "decide", approvalId: draft.approval.id, decision: "approve" }, "manager");
    await store.connectRepositoryGrants(scope.id, "manager", connectionId, 2, ["fixture/engineering"]);
    const view = await store.task(scope.id, "member", draft.taskId);
    expect(view.effects[0]?.state).toBe("denied");
    expect(view.approvals[0]?.state).toBe("invalidated");
    expect((await claimModel()).input.tools).toContain("github_create_issue");
  });
  it("excludes an in-flight Notion receipt after its grant is revoked", async () => {
    const connectionId = randomUUID();
    await store.connectNotionGrant(scope.id, "manager", connectionId, 1, randomUUID());
    const taskId = await start("Read selected Notion document");
    await store.finishModel(await claimModel(), turn("", { outcome: "tools", message: { role: "assistant", content: [{ type: "tool_use", id: randomUUID(), name: "notion_read_page", input: { pageId: randomUUID() } }] } }));
    const dispatch = await claimEffect();
    const grant = (await store.view(scope.id, "manager")).grants.find(item => item.kind === "notion_scope");
    if (!grant) throw new Error("Notion grant missing");
    await command({ kind: "revoke_grant", grantId: grant.id }, "manager");
    await store.finishEffect(dispatch, { providerId: "secret-page", url: "https://www.notion.so/secret-page", content: "PRIVATE NOTION RESPONSE AFTER REVOCATION" });
    const view = await store.task(scope.id, "member", taskId);
    expect(JSON.stringify(view)).not.toContain("PRIVATE NOTION RESPONSE AFTER REVOCATION");
    expect(JSON.stringify(view)).not.toContain("secret-page");
    const next = await claimModel();
    expect(JSON.stringify(next.input)).not.toContain("PRIVATE NOTION RESPONSE AFTER REVOCATION");
    expect(next.input.tools).not.toContain("notion_read_page");
  });

  it("source removal clears opaque Responses continuation state before another model turn", async () => {
    const intake = await store.ingest(message("Sensitive source for reasoning", 7862, { mentioned: true }));
    if (!intake.taskId) throw new Error("Task missing");
    const first = await claimModel();
    const callId = randomUUID();
    await store.finishModel(first, turn("", { outcome: "tools", message: { role: "assistant", content: [{ type: "tool_use", id: callId, name: "github_read_issues", input: { repository: "fixture/engineering" } }], providerState: { protocol: "responses", provider: "openai", endpoint: "https://api.openai.com/v1/responses", model: "synthetic", items: [{ type: "reasoning", id: "rs_test", encrypted_content: "source-derived-secret", summary: [] }, { type: "function_call", call_id: callId, name: "github_read_issues", arguments: JSON.stringify({ repository: "fixture/engineering" }) }] } } }));
    await store.finishEffect(await claimEffect(), { providerId: "read-result", url: null, content: "Sensitive derived tool evidence" });
    const source = (await store.task(scope.id, "member", intake.taskId)).sources.find(item => item.messageId === 7862);
    if (!source) throw new Error("Source missing");
    await command({ kind: "forget_sources", sourceIds: [source.id] }, "manager");
    const next = await claimModel();
    expect(JSON.stringify(next.input.history)).not.toContain("source-derived-secret");
    expect(next.input.history.every(item => !item.providerState)).toBe(true);
    expect(next.input.history.flatMap(item => item.content).every(block => block.type === "text")).toBe(true);
    const provider = createResponsesModel({ apiKey: "synthetic", model: "synthetic", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 1, fetch: async (_url, request) => { expect(String(request?.body)).not.toContain("source-derived-secret"); return new Response(JSON.stringify({ id: "resp_after_forget", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Continuing with current context", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 5 } }), { headers: { "Content-Type": "application/json" } }); } });
    expect((await provider.turn(next.input, new AbortController().signal)).outcome).toBe("complete");
  });

  it("acknowledges a quick ask and delivers a plain linked answer while retaining coverage in the inspector", async () => {
    const receipt = await store.ingest(message("Say hello", 100, { mentioned: true }));
    const acknowledgement = await store.claim("outbox", "delivery");
    if (acknowledgement?.kind !== "delivery") throw new Error("Acknowledgement missing");
    expect(acknowledgement.delivery).toMatchObject({ text: "On it.", buttons: [], replyTo: 100, purpose: "acknowledgement" });
    await store.finishDelivery(acknowledgement, 900);
    // The outbox cannot dispatch model work while the execution worker is busy.
    expect(await store.claim("outbox", "delivery")).toBeNull();
    const model = await claimModel();
    const coverage = contextCoverageLimitation(scope.collectedSince);
    await store.finishModel(model, turn("Hello!", { limitations: [coverage] }));
    const answer = await store.claim("outbox", "delivery");
    if (answer?.kind !== "delivery") throw new Error("Answer missing");
    expect(answer.delivery).toMatchObject({ text: "Hello!", buttons: [], replyTo: 100 });
    expect(answer.delivery.text).not.toContain(receipt.taskId);
    await store.finishDelivery(answer, 901);
    now += 8001;
    expect(await store.claim("outbox", "delivery")).toBeNull();
    expect((await store.task(scope.id, "member", receipt.taskId!)).task.result?.limitations).toContain(coverage);
    const followup = await store.ingest(message("Make it shorter", 101, { replyTo: 901 }));
    expect(followup.taskId).toBe(receipt.taskId);
    expect((await claimModel()).input.history.flatMap(item => item.content).some(block => block.type === "text" && block.text.includes("Make it shorter"))).toBe(true);
  });

  it("edits long-work progress to remove Stop and sends a separate final answer", async () => {
    await store.ingest(message("Investigate the supplied reports", 100, { mentioned: true }));
    const model = await claimModel();
    now += 8001;
    const working = await store.claim("outbox", "delivery");
    if (working?.kind !== "delivery") throw new Error("Progress missing");
    expect(working.delivery).toMatchObject({ purpose: "progress", replyTo: 100, buttons: [{ text: "Stop" }] });
    await store.finishDelivery(working, 901);
    await store.finishModel(model, turn("The retry loop is the first fix.", { limitations: [contextCoverageLimitation(scope.collectedSince), "The reports do not measure the fix's impact."] }));
    const settled = await store.claim("outbox", "delivery");
    if (settled?.kind !== "delivery") throw new Error("Settled progress missing");
    expect(settled.delivery).toMatchObject({ purpose: "progress", messageId: 901, buttons: [], text: "Finished. My answer is below." });
    await store.finishDelivery(settled, 901);
    const answer = await store.claim("outbox", "delivery");
    if (answer?.kind !== "delivery") throw new Error("Separate answer missing");
    expect(answer.delivery).toMatchObject({ messageId: null, buttons: [], text: "The retry loop is the first fix.\n\nThe reports do not measure the fix's impact." });
  });

  it("clears Stop when progress delivery races with task completion", async () => {
    await start();
    const model = await claimModel();
    now += 8001;
    const sending = await store.claim("outbox", "delivery");
    if (sending?.kind !== "delivery") throw new Error("Progress missing");
    await store.finishModel(model, turn("Done."));
    await store.finishDelivery(sending, 902);
    const deliveries: DeliveryJob["delivery"][] = [];
    for (;;) {
      const job = await store.claim("outbox", "delivery");
      if (job?.kind !== "delivery") break;
      deliveries.push(job.delivery);
      await store.finishDelivery(job, job.delivery.messageId ?? 903);
    }
    expect(deliveries.some(delivery => delivery.purpose === "progress" && delivery.messageId === 902 && delivery.buttons.length === 0)).toBe(true);
  });

  it("exposes settings deliberately without starting model work", async () => {
    expect((await store.ingest(message("/settings", 100))).kind).toBe("accepted");
    const job = await store.claim("outbox", "delivery");
    if (job?.kind !== "delivery") throw new Error("Settings missing");
    expect(job.delivery).toMatchObject({ purpose: "settings", taskId: null, buttons: [] });
    expect((await store.view(scope.id, "member")).tasks).toHaveLength(0);
    expect(await store.claim("model-worker", "model")).toBeNull();
  });

  it("deduplicates intake across restart and follows explicit task replies", async () => {
    const input = message("Investigate this", 101, { mentioned: true, topicId: 9 });
    const first = await store.ingest(input);
    expect(first.kind).toBe("accepted");
    expect((await store.ingest(input)).kind).toBe("duplicate");
    await store.close();
    store = await openStore(options);
    expect((await store.ingest(input)).kind).toBe("duplicate");
    const view = await store.view(scope.id, "member");
    expect(view.tasks).toHaveLength(1);
    expect(view.tasks[0]?.sources).toHaveLength(1);
    expect(view.tasks[0]?.task.topicId).toBe(9);
    const delivery = await store.claim("delivery-worker");
    expect(delivery?.kind).toBe("delivery");
    if (delivery?.kind !== "delivery") throw new Error("Delivery missing");
    await store.finishDelivery(delivery, 900);
    const reply = await store.ingest(message("Focus on retry behavior", 102, { replyTo: 900 }));
    expect(reply.taskId).toBe(first.taskId);
    const model = await claimModel();
    expect(model.input.history.flatMap(row => row.content).filter(block => block.type === "text").map(block => block.text).join("\n")).toContain("Focus on retry behavior");
  });

  it("keeps tenant, private group and private DM evidence outside unauthorized retrieval", async () => {
    await store.ingest(message("PRIVATE OTHER GROUP", 11, { chatId: otherScope.chatId, userId: "other" }));
    const dm: Scope = { ...scope, id: randomUUID(), chatId: randomUUID(), kind: "dm", ownerId: "other", name: "Other private DM", workspacePublic: false };
    await store.seed({ ...seed, scopes: [dm], memberships: [{ scopeId: dm.id, userId: "other", role: "member" }], grants: [] });
    await expect(store.view(otherScope.id, "owner")).rejects.toThrow("Access denied");
    await expect(store.view(dm.id, "member")).rejects.toThrow("Access denied");
    await expect(store.task(scope.id, "member", randomUUID())).rejects.toThrow("Record unavailable");
    const scopes = await store.scopes("member");
    expect(scopes.filter(item => item.workspaceId === seed.workspaceId).map(item => item.id)).toEqual([scope.id]);
    await start();
    const model = await claimModel();
    expect(model.input.sources.some(source => source.text.includes("PRIVATE OTHER GROUP"))).toBe(false);
    const db = new DatabaseSync(options.databasePath);
    db.exec("PRAGMA foreign_keys=ON");
    try {
      expect(() => db.prepare("INSERT INTO tasks(workspace_id,scope_id,id,data) VALUES(?,?,?,'{}')").run(seed.workspaceId, otherScope.id + "missing", randomUUID())).toThrow("FOREIGN KEY constraint failed");
    } finally { db.close(); }
  });

  it("selects a recent bounded context window with the current attachment and chronological presentation", async () => {
    await store.ingest(message("PRIVATE OTHER GROUP HISTORY", 700, { chatId: otherScope.chatId, userId: "other" }));
    for (let index = 0; index < 320; index += 1) {
      now += 1;
      await store.ingest(message(index === 0 ? "OLDEST SCOPED FACT" : index === 319 ? "RECENT SCOPED FACT" : `Recent-window fixture ${index}`, 10_000 + index));
    }
    now += 1;
    const accepted = await store.ingest(message("Analyze the current attached text", 11_000, { mentioned: true, file: { name: "current-context.txt", text: "CURRENT ATTACHMENT EVIDENCE" } }));
    const model = await claimModel();
    expect(model.input.task.id).toBe(accepted.taskId);
    expect(model.input.sources).toHaveLength(300);
    expect(model.input.sources.some(source => source.text === "RECENT SCOPED FACT")).toBe(true);
    expect(model.input.sources.some(source => source.kind === "text_file" && source.text === "CURRENT ATTACHMENT EVIDENCE")).toBe(true);
    expect(model.input.sources.some(source => source.text === "OLDEST SCOPED FACT")).toBe(false);
    expect(JSON.stringify(model.input)).not.toContain("PRIVATE OTHER GROUP HISTORY");
    const chronological = [...model.input.sources].sort((a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id));
    expect(model.input.sources.map(source => source.id)).toEqual(chronological.map(source => source.id));
  });

  it("retains an older task prompt, attachment and receipt when resumed after newer unrelated history", async () => {
    const accepted = await store.ingest(message("ORIGINAL TASK PROMPT", 12_000, { mentioned: true, file: { name: "original-context.txt", text: "ORIGINAL TASK ATTACHMENT" } }));
    if (!accepted.taskId) throw new Error("Original task missing");
    async function completeRead(content: string) {
      const model = await claimModel();
      await store.finishModel(model, turn("", { outcome: "tools", message: { role: "assistant", content: [{ type: "tool_use", id: randomUUID(), name: "github_read_issues", input: { repository: "fixture/engineering" } }] } }));
      const effect = await claimEffect();
      await store.finishEffect(effect, { providerId: randomUUID(), url: null, content });
      const conclusion = await claimModel();
      await store.finishModel(conclusion, turn("Completed investigation"));
    }
    await completeRead("ORIGINAL TASK TOOL RECEIPT");
    now += 1;
    await start("Unrelated older investigation");
    await completeRead("UNRELATED OLDER TOOL RECEIPT");
    for (let index = 0; index < 305; index += 1) {
      now += 1;
      await store.ingest(message(`Newer unrelated group context ${index}`, 13_000 + index));
    }
    await command({ kind: "steer", taskId: accepted.taskId, text: "Continue the original investigation with its saved receipt" });
    const resumed = await claimModel();
    expect(resumed.input.task.id).toBe(accepted.taskId);
    expect(resumed.input.sources).toHaveLength(300);
    expect(resumed.input.sources.some(source => source.text === "ORIGINAL TASK PROMPT")).toBe(true);
    expect(resumed.input.sources.some(source => source.text === "ORIGINAL TASK ATTACHMENT")).toBe(true);
    expect(resumed.input.sources.some(source => source.text === "ORIGINAL TASK TOOL RECEIPT")).toBe(true);
    expect(resumed.input.sources.some(source => source.text === "Newer unrelated group context 304")).toBe(true);
    expect(resumed.input.sources.some(source => source.text === "UNRELATED OLDER TOOL RECEIPT")).toBe(false);
    const chronological = [...resumed.input.sources].sort((a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id));
    expect(resumed.input.sources.map(source => source.id)).toEqual(chronological.map(source => source.id));
  });

  it("supplies citation references for active memory whose raw evidence is outside the recent window", async () => {
    await store.ingest(message("OLDER RAW MEMORY EVIDENCE", 15_000));
    const initialTask = await start();
    const initialView = await store.task(scope.id, "member", initialTask);
    const evidence = initialView.sources.find(source => source.text === "OLDER RAW MEMORY EVIDENCE");
    if (!evidence) throw new Error("Memory evidence missing");
    await command({ kind: "remember", content: "A saved older fact remains useful", evidenceIds: [evidence.id], candidate: false });
    await command({ kind: "cancel", taskId: initialTask });
    for (let index = 0; index < 305; index += 1) {
      now += 1;
      await store.ingest(message(`Later memory-window context ${index}`, 16_000 + index));
    }
    await start("Use the active saved fact with its evidence reference");
    const model = await claimModel();
    expect(model.input.memories.map(memory => memory.content)).toContain("A saved older fact remains useful");
    const reference = model.input.sources.find(source => source.id === evidence.id);
    expect(reference?.text).toBe("Evidence reference for an active curated fact. Original source content is outside the selected source window.");
    expect(model.input.sources.filter(source => source.scopeId === scope.id && source.id !== evidence.id)).toHaveLength(300);
    expect(JSON.stringify(model.input)).not.toContain("OLDER RAW MEMORY EVIDENCE");
    await store.finishModel(model, turn(`The saved fact applies [Source: ${evidence.id}]`, { sourceIds: [evidence.id] }));
    expect((await store.task(scope.id, "member", model.input.task.id)).task.result?.sourceIds).toEqual([evidence.id]);
  });

  it("keeps raw task prompts and files when correcting a consumed memory", async () => {
    const accepted = await store.ingest(message("RAW TASK PROMPT MUST REMAIN", 17_000, { mentioned: true, file: { name: "context.txt", text: "RAW TASK FILE MUST REMAIN" } }));
    if (!accepted.taskId) throw new Error("Raw-input task missing");
    const initial = await store.task(scope.id, "member", accepted.taskId);
    const prompt = initial.sources.find(source => source.kind === "message");
    const file = initial.sources.find(source => source.kind === "text_file");
    if (!prompt || !file) throw new Error("Raw input missing");
    await command({ kind: "remember", content: "Correct this interpreted fact", evidenceIds: [file.id], candidate: false });
    await command({ kind: "remember", content: "Independent prompt-backed fact", evidenceIds: [prompt.id], candidate: false });
    const model = await claimModel();
    await store.finishModel(model, turn("A conclusion based on both saved facts"));
    const correction = model.input.memories.find(memory => memory.content === "Correct this interpreted fact");
    if (!correction) throw new Error("Consumed memory missing");
    await command({ kind: "correct_memory", memoryId: correction.id, expectedRevision: correction.revision, content: "Corrected interpreted fact" });
    const corrected = await store.task(scope.id, "member", accepted.taskId);
    expect(corrected.task.result).toBeNull();
    expect(corrected.sources.map(source => source.text)).toContain("RAW TASK PROMPT MUST REMAIN");
    expect(corrected.sources.map(source => source.text)).toContain("RAW TASK FILE MUST REMAIN");
    const independent = (await store.view(scope.id, "member")).memories.find(memory => memory.content === "Independent prompt-backed fact");
    expect(independent?.state).toBe("active");
  });

  it("invalidates memory consumers without clearing an unrelated earlier task in the same scope", async () => {
    const unrelatedId = await start("Complete unrelated work before the fact exists");
    const unrelatedModel = await claimModel();
    await store.finishModel(unrelatedModel, turn("UNRELATED RESULT MUST SURVIVE"));
    now += 1;
    const accepted = await store.ingest(message("Investigate the later fact", 18_000, { mentioned: true, file: { name: "later.txt", text: "LATER FILE EVIDENCE" } }));
    if (!accepted.taskId) throw new Error("Consumer task missing");
    const file = (await store.task(scope.id, "member", accepted.taskId)).sources.find(source => source.kind === "text_file");
    if (!file) throw new Error("Later file missing");
    await command({ kind: "remember", content: "A later interpreted fact", evidenceIds: [file.id], candidate: false });
    const consumer = await claimModel();
    const memory = consumer.input.memories.find(item => item.content === "A later interpreted fact");
    if (!memory) throw new Error("Later memory missing");
    await store.finishModel(consumer, turn("A result using the later fact"));
    await command({ kind: "correct_memory", memoryId: memory.id, expectedRevision: memory.revision, content: "Corrected later fact" });
    expect((await store.task(scope.id, "member", accepted.taskId)).task.result).toBeNull();
    expect((await store.task(scope.id, "member", unrelatedId)).task.result?.text).toBe("UNRELATED RESULT MUST SURVIVE");
    await command({ kind: "forget_sources", sourceIds: [file.id] }, "manager");
    expect((await store.task(scope.id, "member", unrelatedId)).task.result?.text).toBe("UNRELATED RESULT MUST SURVIVE");
    await command({ kind: "steer", taskId: unrelatedId, text: "Continue the unrelated saved work" });
    const resumed = await claimModel();
    expect(resumed.input.task.id).toBe(unrelatedId);
    expect(JSON.stringify(resumed.input.history)).toContain("UNRELATED RESULT MUST SURVIVE");
  });

  it("scrubs linked raw input before its first model call without clearing unrelated work", async () => {
    const unrelatedId = await start("Unrelated prior work");
    await store.finishModel(await claimModel(), turn("PRIOR RESULT MUST SURVIVE"));
    now += 1;
    const accepted = await store.ingest(message("RAW SENSITIVE TASK INSTRUCTION", 19_000, { mentioned: true, file: { name: "sensitive.txt", text: "RAW SENSITIVE FILE" } }));
    if (!accepted.taskId) throw new Error("Undispatched task missing");
    const file = (await store.task(scope.id, "member", accepted.taskId)).sources.find(source => source.kind === "text_file");
    if (!file) throw new Error("Undispatched file missing");
    await command({ kind: "forget_sources", sourceIds: [file.id] }, "manager");
    const fresh = await claimModel();
    expect(fresh.input.task.id).toBe(accepted.taskId);
    expect(fresh.input.task.instruction).toBe("Continue with current authorized context.");
    expect(JSON.stringify(fresh.input.history)).not.toContain("RAW SENSITIVE TASK INSTRUCTION");
    expect(JSON.stringify(fresh.input)).not.toContain("RAW SENSITIVE FILE");
    expect((await store.task(scope.id, "member", unrelatedId)).task.result?.text).toBe("PRIOR RESULT MUST SURVIVE");
  });

  it("forgets a task-owned tool receipt before the next model reservation", async () => {
    const taskId = await start("Read the approved issue list");
    await store.finishModel(await claimModel(), turn("", { outcome: "tools", message: { role: "assistant", content: [{ type: "tool_use", id: randomUUID(), name: "github_read_issues", input: { repository: "fixture/engineering" } }] } }));
    await store.finishEffect(await claimEffect(), { providerId: randomUUID(), url: null, content: "SENSITIVE TOOL RECEIPT MUST DISAPPEAR" });
    const toolSource = (await store.task(scope.id, "member", taskId)).sources.find(source => source.kind === "tool");
    if (!toolSource) throw new Error("Tool source missing");
    await command({ kind: "forget_sources", sourceIds: [toolSource.id] }, "manager");
    const fresh = await claimModel();
    expect(fresh.input.task.id).toBe(taskId);
    expect(JSON.stringify(fresh.input)).not.toContain("SENSITIVE TOOL RECEIPT MUST DISAPPEAR");
    expect(JSON.stringify(await store.task(scope.id, "member", taskId))).not.toContain("SENSITIVE TOOL RECEIPT MUST DISAPPEAR");
    expect(fresh.input.history.some(entry => entry.content.some(block => block.type === "text" && block.text === "[Content removed following evidence invalidation]"))).toBe(true);
    expect(fresh.input.history.flatMap(entry => entry.content).every(block => block.type === "text")).toBe(true);
  });

  it("fences a stale model response after steering and preserves ordered instructions", async () => {
    const taskId = await start();
    const stale = await claimModel();
    await command({ kind: "steer", taskId, text: "Use the new requested direction" });
    await store.finishModel(stale, turn("STALE ANSWER"));
    const fresh = await claimModel();
    expect(fresh.input.task.epoch).toBe(1);
    expect(fresh.input.history.flatMap(row => row.content).some(block => block.type === "text" && block.text === "STALE ANSWER")).toBe(false);
    expect(fresh.input.history.flatMap(row => row.content).some(block => block.type === "text" && block.text.includes("new requested direction"))).toBe(true);
    await store.finishModel(fresh, turn("Current answer"));
    const view = await store.task(scope.id, "member", taskId);
    expect(view.task.result?.text).toBe("Current answer");
    expect(view.events.some(event => event.kind === "model_result_fenced")).toBe(true);
    expect((await store.view(scope.id, "member")).usage.spentMicros).toBe(2000);
  });

  it("stops queued work and records an already-dispatched write receipt before pausing", async () => {
    const queued = await start();
    await command({ kind: "stop", taskId: queued });
    expect(await claimNonDelivery()).toBeNull();
    expect((await store.task(scope.id, "member", queued)).task.state).toBe("paused");
    const draft = await draftWrite();
    await command({ kind: "decide", approvalId: draft.approval.id, decision: "approve" }, "manager");
    const effect = await claimEffect();
    expect(effect.reconcile).toBe(false);
    await command({ kind: "stop", taskId: draft.taskId });
    expect((await store.task(scope.id, "member", draft.taskId)).task.state).toBe("stopping");
    await store.finishEffect(effect, { providerId: "fixture-42", url: "https://example.invalid/issue/42", content: "Created simulated issue 42" });
    const stopped = await store.task(scope.id, "member", draft.taskId);
    expect(stopped.task.state).toBe("paused");
    expect(stopped.effects[0]?.state).toBe("succeeded");
    await command({ kind: "resume", taskId: draft.taskId });
    const resumed = await claimModel();
    expect(resumed.input.history.flatMap(row => row.content).some(block => block.type === "tool_result" && block.content.includes("issue 42"))).toBe(true);
    expect(resumed.input.history.flatMap(row => row.content).filter(block => block.type === "tool_use")).toHaveLength(1);
  });

  it("requires current manager authority and exact, unexpired approvals", async () => {
    const draft = await draftWrite();
    expect((await command({ kind: "decide", approvalId: draft.approval.id, decision: "approve" }, "member")).kind).toBe("denied");
    expect((await store.task(scope.id, "manager", draft.taskId)).approvals[0]?.state).toBe("pending");
    const key = randomUUID();
    const decision = { kind: "decide", approvalId: draft.approval.id, decision: "approve" } satisfies Command;
    expect((await command(decision, "manager", key)).kind).toBe("accepted");
    expect((await command(decision, "manager", key)).kind).toBe("duplicate");
    await store.membership(scope.id, "manager", "member");
    const deniedContinuation = await claimModel();
    await store.finishModel(deniedContinuation, turn("The old action was invalidated."));
    expect((await store.task(scope.id, "member", draft.taskId)).effects[0]?.state).toBe("denied");
    const expired = await draftWrite();
    now += 900_001;
    expect((await command({ kind: "decide", approvalId: expired.approval.id, decision: "approve" }, "owner")).kind).toBe("denied");
    expect((await store.task(scope.id, "member", expired.taskId)).approvals[0]?.state).toBe("expired");
  });

  it("retains mixed assistant blocks and waits for every matching tool result", async () => {
    const taskId = await start();
    const model = await claimModel();
    const firstId = randomUUID();
    const secondId = randomUUID();
    await store.finishModel(model, turn("", { outcome: "tools", message: { role: "assistant", content: [{ type: "text", text: "Two reads" }, { type: "tool_use", id: firstId, name: "github_read_issues", input: { repository: "fixture/engineering" } }, { type: "tool_use", id: secondId, name: "github_read_issues", input: { repository: "fixture/engineering" } }] } }));
    const firstRead = await claimEffect();
    await store.finishEffect(firstRead, { providerId: "read-1", url: null, content: "First result" });
    const secondRead = await claimEffect();
    expect(secondRead.effect.id).not.toBe(firstRead.effect.id);
    expect(await claimNonDelivery()).toBeNull();
    await store.finishEffect(secondRead, { providerId: "read-2", url: null, content: "Second result" });
    const next = await claimModel();
    expect(next.input.task.id).toBe(taskId);
    expect(next.input.history.flatMap(row => row.content).some(block => block.type === "text" && block.text === "Two reads")).toBe(true);
    const results = next.input.history.flatMap(row => row.content).filter(block => block.type === "tool_result");
    expect(results.map(block => block.tool_use_id).sort()).toEqual([firstId, secondId].sort());
  });

  it("preserves accepted same-millisecond steering order while a tool is in flight", async () => {
    const taskId = await start();
    const model = await claimModel();
    await store.finishModel(model, turn("", { outcome: "tools", message: { role: "assistant", content: [{ type: "tool_use", id: randomUUID(), name: "github_read_issues", input: { repository: "fixture/engineering" } }] } }));
    const effect = await claimEffect();
    await command({ kind: "steer", taskId, text: "FIRST accepted steering" });
    await command({ kind: "steer", taskId, text: "SECOND accepted steering" });
    await command({ kind: "steer", taskId, text: "THIRD accepted steering" });
    await store.finishEffect(effect, { providerId: "ordered-read", url: null, content: "Read completed after steering" });
    const fresh = await claimModel();
    const text = fresh.input.history.flatMap(row => row.content).filter(block => block.type === "text").map(block => block.text);
    expect(text.filter(item => item.includes("accepted steering"))).toEqual(["Instruction from member: FIRST accepted steering", "Instruction from member: SECOND accepted steering", "Instruction from member: THIRD accepted steering"]);
    const blocks = fresh.input.history.flatMap(row => row.content);
    expect(blocks.findIndex(block => block.type === "tool_result")).toBeLessThan(blocks.findIndex(block => block.type === "text" && block.text.includes("FIRST accepted steering")));
  });

  it("does not dispatch partial tool output and resumes the saved transcript", async () => {
    const taskId = await start();
    const model = await claimModel();
    await store.finishModel(model, turn("", { outcome: "incomplete", message: { role: "assistant", content: [{ type: "text", text: "Partial response" }, { type: "tool_use", id: randomUUID(), name: "github_create_issue", input: { repository: "fixture/engineering", title: "Partial", body: "Must not dispatch", labels: [] } }] } }));
    expect((await store.task(scope.id, "member", taskId)).effects).toHaveLength(0);
    await command({ kind: "resume", taskId });
    const resumed = await claimModel();
    expect(resumed.input.history.flatMap(row => row.content).some(block => block.type === "tool_result" && block.is_error)).toBe(true);
  });

  it("reconciles an ambiguous write instead of blindly dispatching it again", async () => {
    const draft = await draftWrite();
    await command({ kind: "decide", approvalId: draft.approval.id, decision: "approve" }, "manager");
    const write = await claimEffect();
    await store.unknownEffect(write, "token=NEVER_LOG_THIS_SECRET");
    expect(await claimNonDelivery()).toBeNull();
    now += 2001;
    const reconcile = await claimEffect();
    expect(reconcile.reconcile).toBe(true);
    await store.finishEffect(reconcile, { providerId: "found-original", url: null, content: "Original simulated issue exists" });
    const next = await claimModel();
    expect(next.input.task.id).toBe(draft.taskId);
    const view = await store.task(scope.id, "member", draft.taskId);
    expect(view.effects[0]?.providerId).toBe("found-original");
    expect(view.events.filter(event => event.kind === "effect_dispatched")).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain("NEVER_LOG_THIS_SECRET");
  });

  it("retains confirmed effect and stays blocked when recovery resumption hits pending-job capacity", async () => {
    const draft = await draftWrite();
    await command({ kind: "decide", approvalId: draft.approval.id, decision: "approve" }, "manager");
    const dispatched = await claimEffect();
    await store.unknownEffect(dispatched, "Outcome awaiting positive reconciliation");
    const held = await store.task(scope.id, "member", draft.taskId);
    expect(held.task.state).toBe("blocked");
    expect(held.task.reason).toBe("External outcome unknown. Reconciliation required.");

    const probe = new DatabaseSync(options.databasePath);
    try {
      probe.prepare("UPDATE jobs SET state='held' WHERE id=?").run(dispatched.lease.id);
    } finally {
      probe.close();
    }

    const filler = await start("Recovery capacity filler");
    for (let index = 0; index < 500; index += 1) {
      expect((await command({ kind: "stop", taskId: filler })).kind).toBe("accepted");
    }

    await store.finishEffect(dispatched, { providerId: "write-confirmed-at-capacity", url: null, content: "Positively confirmed at capacity" });
    const recoveryBlocked = await store.task(scope.id, "member", draft.taskId);
    expect(recoveryBlocked.task.state).toBe("blocked");
    expect(recoveryBlocked.task.reason).toContain("Workspace pending-job limit reached.");
    expect(recoveryBlocked.effects[0]?.state).toBe("succeeded");
    expect(recoveryBlocked.effects[0]?.providerId).toBe("write-confirmed-at-capacity");
    expect(recoveryBlocked.events.some(event => event.kind === "recovery_admission_blocked")).toBe(true);
  });

  it("resolves nonexistent local times across spring-forward DST gap without stalling", () => {
    const tz = "America/New_York";
    const start = Date.UTC(2026, 2, 8, 6, 30);
    const first = nextWallClockInstant(start, 3_600_000, tz);
    expect(first).toBe(Date.UTC(2026, 2, 8, 7, 0));
    expect(first).toBeGreaterThan(start);
    const second = nextWallClockInstant(first, 3_600_000, tz);
    expect(second).toBe(Date.UTC(2026, 2, 8, 8, 0));
    expect(second).toBeGreaterThan(first);

    const explicit = wallClockInstant("2026-03-08T02:30", tz);
    expect(explicit).toBe(Date.UTC(2026, 2, 8, 7, 0));
  });

  it("skips backlog tasks and advances nextAt when routine is more than 50 intervals overdue", async () => {
    const intervalMs = 86_400_000;
    const staleNextAt = now - 60 * intervalMs;
    await command({ kind: "create_routine", instruction: "Overdue digest", timezone: "America/New_York", nextAt: staleNextAt, intervalMs, budgetMicros: 5000 }, "manager");
    const beforeView = await store.view(scope.id, "member");
    const routineId = beforeView.routines.find(r => r.instruction === "Overdue digest")!.id;

    await store.materializeRoutines();

    const afterView = await store.view(scope.id, "member");
    const updatedRoutine = afterView.routines.find(r => r.id === routineId)!;
    expect(updatedRoutine.nextAt).toBeGreaterThan(now);
    expect(afterView.tasks.filter(t => t.task.instruction === "Overdue digest")).toHaveLength(0);

    const probe = new DatabaseSync(options.databasePath);
    try {
      const skipped = probe.prepare("SELECT count(*) AS count FROM events WHERE workspace_id=? AND json_extract(data, '$.kind') = 'routine_backlog_skipped'").get(seed.workspaceId) as { count: number } | undefined;
      expect(skipped?.count).toBe(1);
    } finally { probe.close(); }
  });

  it("resumes a recovered effect with one dispatch and the confirmed result in history", async () => {
    const draft = await draftWrite();
    await command({ kind: "decide", approvalId: draft.approval.id, decision: "approve" }, "manager");
    const dispatched = await claimEffect();
    await store.unknownEffect(dispatched, "Outcome awaiting positive reconciliation");
    const held = await store.task(scope.id, "member", draft.taskId);
    expect(held.task.state).toBe("blocked");
    expect(held.task.reason).toBe("External outcome unknown. Reconciliation required.");
    await store.finishEffect(dispatched, { providerId: "original-write-confirmed", url: null, content: "Original effect positively confirmed" });
    const recovered = await store.task(scope.id, "member", draft.taskId);
    expect(recovered.task.state).toBe("queued");
    expect(recovered.effects[0]?.state).toBe("succeeded");
    expect(recovered.effects[0]?.providerId).toBe("original-write-confirmed");
    expect(recovered.events.filter(event => event.kind === "effect_dispatched")).toHaveLength(1);
    let next: ModelJob | null = null;
    for (let index = 0; index < 250; index += 1) {
      const job = await store.claim("recovery-worker");
      if (!job) break;
      if (job.kind === "delivery") await store.finishDelivery(job, ++deliveryMessageId);
      else if (job.kind === "model") { next = job; break; }
      else throw new Error("Recovered effect must not dispatch again");
    }
    expect(next?.input.task.id).toBe(draft.taskId);
    expect(next?.input.history.flatMap(row => row.content).some(block => block.type === "tool_result" && block.content === "Original effect positively confirmed")).toBe(true);
  });

  it("skips a routine occurrence while the pending-job cap is saturated", async () => {
    await command({ kind: "create_routine", instruction: "Capacity digest", timezone: "UTC", nextAt: now + 1000, intervalMs: 86_400_000, budgetMicros: 5000 }, "manager");
    const filler = await start("Routine capacity filler");
    for (let index = 0; index < 500; index += 1) expect((await command({ kind: "stop", taskId: filler })).kind).toBe("accepted");
    now += 1001;
    await store.materializeRoutines();
    expect((await store.view(scope.id, "member")).tasks).toHaveLength(1);
    const probe = new DatabaseSync(options.databasePath);
    try {
      const skipped = probe.prepare("SELECT count(*) AS count FROM events WHERE workspace_id=? AND json_extract(data,'$.kind')='routine_capacity_skipped'").get(seed.workspaceId) as { count: number } | undefined;
      expect(skipped?.count).toBe(1);
    } finally { probe.close(); }
  });

  it("reserves the workspace allowance atomically across concurrent tasks", async () => {
    const limitedId = randomUUID();
    workspaceIds.push(limitedId);
    const limitedScope: Scope = { ...scope, id: randomUUID(), workspaceId: limitedId, chatId: randomUUID(), budgetMicros: 1500 };
    await store.seed({ ...seed, workspaceId: limitedId, botId: seed.botId, scopes: [limitedScope], memberships: [{ scopeId: limitedScope.id, userId: "member", role: "member" }], grants: [], budgetMicros: 1500 });
    const starts = await Promise.all(["one", "two"].map(instruction => store.command({ scopeId: limitedScope.id, userId: "member", key: randomUUID(), command: { kind: "start", instruction, topicId: null } })));
    expect(starts.every(receipt => receipt.kind === "accepted")).toBe(true);
    const first = await claimModel();
    expect(await claimNonDelivery()).toBeNull();
    const view = await store.view(limitedScope.id, "member");
    expect(view.usage.heldMicros).toBe(1000);
    expect(view.tasks.filter(task => task.task.state === "blocked")).toHaveLength(1);
    await store.finishModel(first, turn());
    expect((await store.view(limitedScope.id, "member")).usage.spentMicros).toBe(1000);
  });

  it("leases at most two model tasks per scope and defers a third worker", async () => {
    await start("Concurrent model one");
    await start("Concurrent model two");
    await start("Concurrent model three");
    for (let index = 0; index < 3; index += 1) {
      const delivery = await store.claim("admission-delivery-worker");
      if (delivery?.kind !== "delivery") throw new Error("Acceptance delivery missing");
      await store.finishDelivery(delivery, ++deliveryMessageId);
    }
    const claims = await Promise.all(["one", "two", "three"].map(worker => store.claim(`concurrent-worker-${worker}`)));
    const models = claims.filter((job): job is ModelJob => job?.kind === "model");
    expect(models).toHaveLength(2);
    expect(claims.filter(job => job === null)).toHaveLength(1);
    const [first, second] = models;
    if (!first || !second) throw new Error("Concurrent model leases missing");
    expect(first.input.task.id).not.toBe(second.input.task.id);
    expect(await claimNonDelivery()).toBeNull();
    expect((await store.view(scope.id, "member")).usage.heldMicros).toBe(2000);
    await store.finishModel(first, turn("First model finished"));
    now += 251;
    const third = await claimModel();
    expect([first.input.task.id, second.input.task.id]).not.toContain(third.input.task.id);
    expect((await store.view(scope.id, "member")).usage.heldMicros).toBe(2000);
  });

  it("caps pending jobs at five hundred while keeping Stop and cleanup commands available", async () => {
    const taskId = await start("Pending queue saturation fixture");
    for (let index = 0; index < 500; index += 1) expect((await command({ kind: "stop", taskId })).kind).toBe("accepted");
    expect(await command({ kind: "start", instruction: "Must not be admitted into saturated queue", topicId: null })).toEqual({ kind: "denied", message: "Workspace pending-job limit reached." });
    expect((await command({ kind: "set_scope", active: false }, "manager")).kind).toBe("accepted");
    const view = await store.view(scope.id, "member");
    expect(view.tasks).toHaveLength(1);
    expect(view.usage.heldMicros).toBe(0);
    expect(view.tasks[0]?.events.some(event => event.kind === "queue_capacity_held")).toBe(true);
    const db = new DatabaseSync(options.databasePath);
    try {
      const result = db.prepare("SELECT count(*) AS count FROM jobs WHERE workspace_id=? AND state IN ('ready','leased')").get(seed.workspaceId);
      expect(result?.count).toBe(500);
    } finally { db.close(); }
  });

  it("blocks saturated tool preparation and resumes with matching results and no duplicate dispatch", async () => {
    const taskId = await start("Read two fixture issue lists");
    const model = await claimModel();
    const fillerTaskId = await start("Separate queue saturation fixture");
    for (let index = 0; index < 500; index += 1) await command({ kind: "stop", taskId: fillerTaskId });
    const callIds = [randomUUID(), randomUUID()];
    await store.finishModel(model, turn("", { outcome: "tools", message: { role: "assistant", content: callIds.map(id => ({ type: "tool_use", id, name: "github_read_issues", input: { repository: "fixture/engineering" } })) } }));
    const blocked = await store.task(scope.id, "member", taskId);
    expect(blocked.task.state).toBe("blocked");
    expect(blocked.task.reason).toContain("Workspace pending-job limit reached");
    expect(blocked.effects).toHaveLength(0);
    expect(blocked.events.some(event => event.kind === "queue_capacity_blocked")).toBe(true);
    let released = 0;
    for (; released < 600; released += 1) {
      const pending = await store.claim("capacity-release-worker");
      if (!pending) break;
      if (pending.kind !== "delivery") throw new Error("Saturated tool must not dispatch while capacity is blocked");
      await store.finishDelivery(pending, ++deliveryMessageId);
    }
    expect(released).toBeGreaterThan(0);
    expect(released).toBeLessThanOrEqual(500);
    const db = new DatabaseSync(options.databasePath);
    try { expect(db.prepare("SELECT count(*) AS count FROM jobs WHERE state IN ('ready','leased')").get()?.count).toBe(0); }
    finally { db.close(); }
    expect((await command({ kind: "resume", taskId })).kind).toBe("accepted");
    const resumed = await claimModel();
    const results = resumed.input.history.flatMap(row => row.content).filter(block => block.type === "tool_result");
    expect(results.map(result => result.tool_use_id).sort()).toEqual([...callIds].sort());
    expect(results.every(result => result.is_error)).toBe(true);
    await store.finishModel(resumed, turn("Continued after queue capacity recovered"));
    const completed = await store.task(scope.id, "member", taskId);
    expect(completed.task.state).toBe("completed");
    expect(completed.effects).toHaveLength(0);
    expect(completed.events.filter(event => event.kind === "effect_dispatched")).toHaveLength(0);
  });

  it("keeps discovery inside a configured worker partition", async () => {
    const foreignWorkspace = randomUUID();
    const foreignScope = { ...scope, id: randomUUID(), workspaceId: foreignWorkspace, chatId: randomUUID() };
    await store.seed({ ...seed, workspaceId: foreignWorkspace, scopes: [foreignScope], memberships: [{ scopeId: foreignScope.id, userId: "member", role: "member" }], grants: [] });
    const available = await store.scopes("member");
    expect(available.map(item => item.id)).toContain(scope.id);
    expect(available.map(item => item.id)).not.toContain(foreignScope.id);
  });

  it("invalidates source-backed memory and fences in-flight context after forgetting", async () => {
    await store.ingest(message("Sensitive fixture evidence", 411));
    const taskId = await start();
    const model = await claimModel();
    const source = model.input.sources[0];
    if (!source) throw new Error("Source missing");
    await command({ kind: "remember", content: "Evidence-backed fact", evidenceIds: [source.id], candidate: false });
    await command({ kind: "forget_sources", sourceIds: [source.id] }, "manager");
    await store.finishModel(model, turn("Sensitive fixture evidence"));
    const view = await store.task(scope.id, "member", taskId);
    expect(view.task.result).toBeNull();
    expect(view.sources).toHaveLength(0);
    expect((await store.view(scope.id, "member")).memories[0]?.state).toBe("invalidated");
    const fresh = await claimModel();
    expect(JSON.stringify(fresh.input)).not.toContain("Sensitive fixture evidence");
  });

  it("invalidates shared-source descendants and keeps late receipts from restoring removed content", async () => {
    expect((await command({ kind: "set_scope", workspacePublic: true }, "manager")).kind).toBe("denied");
    expect((await command({ kind: "set_scope", workspacePublic: true }, "owner")).kind).toBe("accepted");
    await store.ingest(message("Shared sensitive fixture evidence", 421));
    const sourceView = await store.view(scope.id, "member");
    const sharedSource = sourceView.tasks[0]?.sources.find(source => source.messageId === 421) ?? null;
    const db = new DatabaseSync(options.databasePath);
    let sharedId = sharedSource?.id;
    try {
      const result = db.prepare("SELECT id FROM sources WHERE workspace_id=? AND scope_id=? AND data->>'messageId'=421").get(seed.workspaceId, scope.id);
      sharedId = typeof result?.id === "string" ? result.id : undefined;
    } finally { db.close(); }
    if (!sharedId) throw new Error("Shared source missing");
    await command({ kind: "remember", content: "Approved curated shared fact", evidenceIds: [sharedId], candidate: false });
    const taskReceipt = await store.command({ scopeId: otherScope.id, userId: "other", key: randomUUID(), command: { kind: "start", instruction: "Use the shared evidence", topicId: null } });
    if (!taskReceipt.taskId) throw new Error("Shared-context task missing");
    const crossScopeModel = await claimModel();
    const shared = crossScopeModel.input.sources.find(source => source.id === sharedId);
    if (!shared) throw new Error("Shared source missing");
    expect(JSON.stringify(crossScopeModel.input)).not.toContain("Shared sensitive fixture evidence");
    expect(crossScopeModel.input.memories.some(memory => memory.content === "Approved curated shared fact")).toBe(true);
    await store.finishModel(crossScopeModel, turn("Shared sensitive fixture evidence", { sourceIds: [shared.id] }));
    await command({ kind: "forget_sources", sourceIds: [shared.id] }, "manager");
    const invalidated = await store.task(otherScope.id, "other", taskReceipt.taskId);
    expect(invalidated.task.result).toBeNull();
    expect(invalidated.events.some(event => event.kind === "dependent_context_invalidated")).toBe(true);
    const draft = await draftWrite();
    await command({ kind: "decide", approvalId: draft.approval.id, decision: "approve" }, "manager");
    const dispatch = await claimEffect();
    await store.ingest(message("Evidence supporting the pending effect", 422));
    const source = (await store.task(scope.id, "member", draft.taskId)).sources.find(source => source.messageId === 422);
    if (!source) throw new Error("Pending source missing");
    await command({ kind: "forget_sources", sourceIds: [source.id] }, "manager");
    await store.finishEffect(dispatch, { providerId: "late-after-removal", url: null, content: "Evidence supporting the pending effect" });
    const view = await store.task(scope.id, "member", draft.taskId);
    expect(view.effects[0]?.state).toBe("succeeded");
    expect(view.effects[0]?.providerId).toBe("late-after-removal");
    expect(JSON.stringify(view)).not.toContain("Evidence supporting the pending effect");
    expect(view.effects[0]?.call.name === "github_create_issue" && view.effects[0].call.input.body).toBe("[Content removed]");
  });

  it("reconciles late model usage after failure and bounds dispatches by turn count", async () => {
    const taskId = await start();
    const model = await claimModel();
    await store.fail(model, "provider timeout with secret");
    expect((await store.view(scope.id, "member")).usage.spentMicros).toBe(1000);
    await store.finishModel(model, turn("Late result must be fenced", { usage: { inputTokens: 1, outputTokens: 1, costMicros: 300, simulated: true, pricingRevision: "fixture-v1" } }));
    expect((await store.view(scope.id, "member")).usage.spentMicros).toBe(300);
    const view = await store.task(scope.id, "member", taskId);
    expect(view.task.state).toBe("failed");
    expect(view.task.result).toBeNull();
    expect(view.task.turns).toBe(1);
  });

  it.each(["correct", "reject", "invalidate"] as const)("removes a consumed shared fact from completed consumer history after memory %s", async change => {
    await command({ kind: "set_scope", workspacePublic: true }, "owner");
    const oldFact = `OLD PRIVATE CURATED FACT ${randomUUID()}`;
    await command({ kind: "remember", content: oldFact, evidenceIds: [], candidate: false });
    const memory = (await store.view(scope.id, "member")).memories[0];
    if (!memory) throw new Error("Shared memory missing");
    const receipt = await store.command({ scopeId: otherScope.id, userId: "other", key: randomUUID(), command: { kind: "start", instruction: "Summarize shared facts", topicId: null } });
    if (!receipt.taskId) throw new Error("Consumer missing");
    const consumed = await claimModel();
    expect(consumed.input.memories.some(item => item.id === memory.id && item.content === oldFact)).toBe(true);
    await store.finishModel(consumed, turn(`Summary included ${oldFact}`));
    expect((await store.task(otherScope.id, "other", receipt.taskId)).task.result?.text).toContain(oldFact);
    const update: Command = change === "correct" ? { kind: "correct_memory", memoryId: memory.id, expectedRevision: memory.revision, content: "CURRENT corrected shared fact" } : { kind: "set_memory", memoryId: memory.id, state: change === "reject" ? "rejected" : "invalidated" };
    expect((await command(update)).kind).toBe("accepted");
    expect((await store.task(otherScope.id, "other", receipt.taskId)).task.result).toBeNull();
    await store.command({ scopeId: otherScope.id, userId: "other", key: randomUUID(), command: { kind: "steer", taskId: receipt.taskId, text: "Continue using only current facts" } });
    const next = await store.claim("memory-regression-worker", "model");
    expect(next?.kind).toBe("model");
    if (next?.kind !== "model") throw new Error("Consumer continuation missing");
    expect(JSON.stringify(next.input)).not.toContain(oldFact);
    if (change === "correct") expect(next.input.memories.some(item => item.id === memory.id && item.revision === 2 && item.content === "CURRENT corrected shared fact")).toBe(true);
    else expect(next.input.memories.some(item => item.id === memory.id)).toBe(false);
  });

  it("allows authorized retained-data cleanup while collection remains inactive", async () => {
    await store.ingest(message("Retained source requiring deletion", 431));
    const taskId = await start("Consume retained data");
    const model = await claimModel();
    const source = model.input.sources.find(item => item.messageId === 431);
    if (!source) throw new Error("Retained source missing");
    await command({ kind: "remember", content: "Retained memory requiring invalidation", evidenceIds: [source.id], candidate: false });
    const memory = (await store.view(scope.id, "member")).memories[0];
    if (!memory) throw new Error("Retained memory missing");
    await command({ kind: "set_scope", active: false }, "manager");
    expect((await command({ kind: "correct_memory", memoryId: memory.id, expectedRevision: 1, content: "Corrected inactive-scope memory" })).kind).toBe("accepted");
    expect((await command({ kind: "set_memory", memoryId: memory.id, state: "invalidated" })).kind).toBe("accepted");
    expect((await command({ kind: "forget_sources", sourceIds: [source.id] }, "member")).kind).toBe("denied");
    expect((await command({ kind: "forget_sources", sourceIds: [source.id] }, "manager")).kind).toBe("accepted");
    const view = await store.task(scope.id, "member", taskId);
    expect(view.sources).toHaveLength(0);
    expect((await store.view(scope.id, "member")).scope.active).toBe(false);
    expect(await claimNonDelivery()).toBeNull();
  });

  it("redacts memory-derived effects while keeping exact in-flight recovery payloads", async () => {
    await command({ kind: "set_scope", workspacePublic: true }, "owner");
    const oldFact = `Sensitive shared fact ${randomUUID()}`;
    await command({ kind: "remember", content: oldFact, evidenceIds: [], candidate: false });
    const memory = (await store.view(scope.id, "member")).memories[0];
    if (!memory) throw new Error("Shared memory missing");
    await store.seed({ ...seed, scopes: [], memberships: [{ scopeId: otherScope.id, userId: "other_manager", role: "manager" }], grants: [{ ...seed.grants[0] as Exclude<typeof seed.grants[number], { kind: "notion_scope" }>, id: randomUUID(), scopeId: otherScope.id, repository: "fixture/engineering", read: true, write: true, active: true, revision: 1 }] });
    const receipt = await store.command({ scopeId: otherScope.id, userId: "other", key: randomUUID(), command: { kind: "start", instruction: "Draft issue using shared facts", topicId: null } });
    if (!receipt.taskId) throw new Error("Consumer missing");
    const model = await claimModel();
    await store.finishModel(model, turn("", { outcome: "tools", message: { role: "assistant", content: [{ type: "tool_use", id: randomUUID(), name: "github_create_issue", input: { repository: "fixture/engineering", title: "Memory-derived issue", body: oldFact, labels: [] } }] } }));
    const approval = (await store.task(otherScope.id, "other", receipt.taskId)).approvals[0];
    if (!approval) throw new Error("Consumer approval missing");
    await store.command({ scopeId: otherScope.id, userId: "other_manager", key: randomUUID(), command: { kind: "decide", approvalId: approval.id, decision: "approve" } });
    const dispatched = await claimEffect();
    await command({ kind: "set_memory", memoryId: memory.id, state: "invalidated" });
    const redacted = await store.task(otherScope.id, "other", receipt.taskId);
    expect(JSON.stringify(redacted)).not.toContain(oldFact);
    expect(redacted.effects[0]?.hash).toBe(dispatched.effect.hash);
    await store.unknownEffect(dispatched, "Ambiguous result after memory removal");
    now += 2001;
    const reconcile = await claimEffect();
    expect(reconcile.reconcile).toBe(true);
    expect(reconcile.effect.hash).toBe(dispatched.effect.hash);
    expect(reconcile.effect.call).toEqual(dispatched.effect.call);
    await store.finishEffect(reconcile, { providerId: "original-memory-derived-write", url: null, content: oldFact });
    const fresh = await claimModel();
    expect(JSON.stringify(fresh.input)).not.toContain(oldFact);
    expect((await store.task(otherScope.id, "other", receipt.taskId)).effects[0]?.state).toBe("succeeded");
  });

  it("stores edits as notes and preserves bindings and reply links through migration", async () => {
    const accepted = await store.ingest(message("Original instruction", 501, { mentioned: true }));
    await store.ingest(message("Edited text with mention", 501, { mentioned: true, edited: true }));
    await store.ingest(message("New mention added by edit", 502, { mentioned: true, edited: true }));
    const before = await store.view(scope.id, "member");
    expect(before.tasks).toHaveLength(1);
    expect(before.tasks[0]?.task.instruction).toBe("Original instruction");
    const newChatId = randomUUID();
    await store.ingest({ kind: "migration", botId: seed.botId, updateId: ++updateId, chatId: scope.chatId, newChatId });
    expect((await store.resolveChat(seed.botId, newChatId))?.id).toBe(scope.id);
    expect((await store.resolveChat(seed.botId, scope.chatId))?.id).toBe(scope.id);
    const reply = await store.ingest(message("New reply steers after migration", 503, { chatId: newChatId, replyTo: 501 }));
    expect(reply.taskId).toBe(accepted.taskId);
    const model = await claimModel();
    const text = model.input.history.flatMap(row => row.content).filter(block => block.type === "text").map(block => block.text).join("\n");
    expect(text).toContain("Source edit note");
    expect(text).toContain("New reply steers after migration");
  });

  it("creates one daily wall-clock occurrence across restart and skips paused backlog", async () => {
    await command({ kind: "create_routine", instruction: "Daily fixture digest", timezone: "America/New_York", nextAt: now + 1000, intervalMs: 86_400_000, budgetMicros: 5000 }, "manager");
    const routine = (await store.view(scope.id, "member")).routines[0];
    if (!routine) throw new Error("Routine missing");
    now += 1001;
    const first = await claimModel();
    await store.finishModel(first, turn("Digest completed"));
    await store.close();
    store = await openStore(options);
    expect(await claimNonDelivery()).toBeNull();
    expect((await store.view(scope.id, "member")).tasks).toHaveLength(1);
    await command({ kind: "set_routine", routineId: routine.id, state: "paused" }, "manager");
    now += 3 * 86_400_000;
    expect(await claimNonDelivery()).toBeNull();
    await command({ kind: "set_routine", routineId: routine.id, state: "active" }, "manager");
    expect(await claimNonDelivery()).toBeNull();
    const resumed = (await store.view(scope.id, "member")).routines[0];
    expect(resumed?.nextAt).toBeGreaterThan(now);
    expect(resumed?.intervalMs).toBe(86_400_000);
  });

  it("keeps the local time of a daily routine across a daylight saving change", async () => {
    const first = Date.UTC(2026, 9, 31, 13, 30); // 09:30 America/New_York, still EDT (UTC-4)
    now = first - 1000;
    await command({ kind: "create_routine", instruction: "DST digest", timezone: "America/New_York", nextAt: first, intervalMs: 86_400_000, budgetMicros: 5000 }, "manager");
    now = first;
    await store.materializeRoutines();
    const afterFirst = (await store.view(scope.id, "member")).routines[0];
    expect(afterFirst?.nextAt).toBe(Date.UTC(2026, 10, 1, 14, 30)); // 09:30 EST (UTC-5) after the Nov 1 change
    now = Date.UTC(2026, 10, 1, 14, 30);
    await store.materializeRoutines();
    const afterSecond = (await store.view(scope.id, "member")).routines[0];
    expect(afterSecond?.nextAt).toBe(Date.UTC(2026, 10, 2, 14, 30));
    expect((await store.view(scope.id, "member")).tasks).toHaveLength(2);
  });

  it("materializes routines independently of job claiming", async () => {
    await command({ kind: "create_routine", instruction: "Independent digest", timezone: "America/New_York", nextAt: now + 1000, intervalMs: 86_400_000, budgetMicros: 5000 }, "manager");
    const routine = (await store.view(scope.id, "member")).routines[0];
    if (!routine) throw new Error("Routine missing");
    now += 1001;
    await store.materializeRoutines();
    const tasks = (await store.view(scope.id, "member")).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.task.requesterId).toBe(`routine:${routine.id}`);
    expect(tasks[0]?.task.state).toBe("queued");
  });

  it("retries delivery only after a completed task and bounds retry delay", async () => {
    const taskId = await start();
    const model = await claimModel();
    await store.finishModel(model, turn("Saved complete answer"));
    const delivery = await store.claim("delivery-worker");
    if (delivery?.kind !== "delivery") throw new Error("Result delivery missing");
    expect(delivery.delivery.format).toBe("markdown");
    await store.fail(delivery, "secret-bearing delivery error");
    expect((await store.task(scope.id, "member", taskId)).task.state).toBe("completed");
    expect(await store.claim("delivery-worker")).toBeNull();
    now += 2001;
    const retry = await store.claim("delivery-worker");
    expect(retry?.kind).toBe("delivery");
    if (retry?.kind !== "delivery") throw new Error("Retry missing");
    expect(retry.delivery.id).toBe(delivery.delivery.id);
    expect(retry.delivery.format).toBe("markdown");
    await store.finishDelivery(retry, 600);
    expect(await claimNonDelivery()).toBeNull();
    expect((await store.task(scope.id, "member", taskId)).task.turns).toBe(1);
  });
  it("serializes claims across two connections to the same SQLite file", async () => {
    const second = await openStore({ ...options, databasePath: join(directory, ".", "store.sqlite") });
    try {
      const tasks = await Promise.all([start("First concurrent task"), start("Second concurrent task"), start("Third concurrent task")]);
      for (let index = 0; index < 3; index += 1) {
        const delivery = await store.claim("delivery-worker");
        if (delivery?.kind !== "delivery") throw new Error("Expected accepted-task delivery");
        await store.finishDelivery(delivery, ++deliveryMessageId);
      }
      const claims = await Promise.all([store.claim("connection-one"), second.claim("connection-two")]);
      expect(claims.every(job => job?.kind === "model")).toBe(true);
      const models = claims.filter((job): job is ModelJob => job?.kind === "model");
      expect(new Set(models.map(job => job.lease.id)).size).toBe(2);
      expect(new Set(models.map(job => job.lease.token)).size).toBe(2);
      expect((await store.view(scope.id, "member")).usage.heldMicros).toBe(2000);
      expect(await second.claim("scope-capacity-worker")).toBeNull();
      await store.finishModel(models[0]!, turn("First task finished"));
      now += 251;
      const remaining = await claimModel();
      expect(tasks).toContain(remaining.input.task.id);
      expect(models.map(job => job.input.task.id)).not.toContain(remaining.input.task.id);
      expect((await second.view(scope.id, "member")).usage.heldMicros).toBe(2000);
    } finally { await second.close(); }
  });

  it("reserves a shared workspace budget atomically across two SQLite connections", async () => {
    const second = await openStore(options);
    const db = new DatabaseSync(options.databasePath);
    try {
      db.prepare("UPDATE workspaces SET budget=1000 WHERE id=?").run(seed.workspaceId);
      await Promise.all([start("Budget competitor one"), start("Budget competitor two")]);
      for (let index = 0; index < 2; index += 1) {
        const delivery = await store.claim("delivery-worker");
        if (delivery?.kind !== "delivery") throw new Error("Expected accepted-task delivery");
        await store.finishDelivery(delivery, ++deliveryMessageId);
      }
      const claims = await Promise.all([store.claim("budget-one"), second.claim("budget-two")]);
      expect(claims.filter(job => job?.kind === "model")).toHaveLength(1);
      expect(db.prepare("SELECT held,spent FROM workspaces WHERE id=?").get(seed.workspaceId)).toMatchObject({ held: 1000, spent: 0 });
      const view = await second.view(scope.id, "member");
      expect(view.tasks.filter(item => item.task.state === "blocked")).toHaveLength(1);
      expect(view.usage.heldMicros).toBe(1000);
    } finally { db.close(); await second.close(); }
  });

  it("isolates duplicate task, source, job and reservation IDs across workspaces", async () => {
    await store.ingest(message("OWN WORKSPACE EVIDENCE", 980));
    const taskId = await start("Original tenant instruction");
    const model = await claimModel();
    const source = model.input.sources[0];
    if (!source) throw new Error("Evidence missing");
    const foreignWorkspace = randomUUID();
    const foreignScope: Scope = { ...scope, id: randomUUID(), workspaceId: foreignWorkspace, chatId: randomUUID() };
    await store.seed({ ...seed, workspaceId: foreignWorkspace, scopes: [foreignScope], memberships: [{ scopeId: foreignScope.id, userId: "foreign", role: "member" }], grants: [] });
    const db = new DatabaseSync(options.databasePath);
    db.exec("PRAGMA foreign_keys=ON");
    try {
      const foreignTask = { ...model.input.task, workspaceId: foreignWorkspace, scopeId: foreignScope.id, requesterId: "foreign", instruction: "FOREIGN TENANT INSTRUCTION" };
      db.prepare("INSERT INTO tasks(workspace_id,scope_id,id,data) VALUES(?,?,?,?)").run(foreignWorkspace, foreignScope.id, taskId, JSON.stringify(foreignTask));
      db.prepare("INSERT INTO sources(workspace_id,scope_id,task_id,id,data) VALUES(?,?,?,?,?)").run(foreignWorkspace, foreignScope.id, taskId, source.id, JSON.stringify({ ...source, scopeId: foreignScope.id, text: "FOREIGN TENANT EVIDENCE" }));
      db.prepare("INSERT INTO transcripts(workspace_id,scope_id,task_id,sequence,data) VALUES(?,?,?,?,?)").run(foreignWorkspace, foreignScope.id, taskId, 100, JSON.stringify({ role: "user", content: [{ type: "text", text: "FOREIGN TENANT HISTORY" }] }));
      db.prepare("INSERT INTO notes(workspace_id,scope_id,task_id,id,sequence,at,text) VALUES(?,?,?,?,?,?,?)").run(foreignWorkspace, foreignScope.id, taskId, randomUUID(), 50, now, "FOREIGN TENANT NOTE");
      db.prepare("INSERT INTO jobs(workspace_id,scope_id,task_id,id,entity_id,kind,data,state,ready_at,token,expires_at) VALUES(?,?,?,?,?,'model','{}','leased',?,?,?)").run(foreignWorkspace, foreignScope.id, taskId, model.lease.id, taskId, now, model.lease.token, now + options.leaseMs);
      db.prepare("INSERT INTO reservations(workspace_id,scope_id,task_id,token,amount,epoch,authority_revision,sources,memories) VALUES(?,?,?,?,1000,0,1,'[]','[]')").run(foreignWorkspace, foreignScope.id, taskId, model.lease.token);
      expect(() => db.prepare("INSERT INTO messages(workspace_id,scope_id,chat_id,message_id,task_id) VALUES(?,?,?,?,?)").run(foreignWorkspace, scope.id, "foreign", 42, taskId)).toThrow("FOREIGN KEY constraint failed");
      await store.finishModel(model, turn("Own tenant complete", { usage: { inputTokens: 1, outputTokens: 1, costMicros: 300, simulated: true, pricingRevision: "fixture" } }));
      expect((await store.task(scope.id, "member", taskId)).task.state).toBe("completed");
      const foreign = await store.task(foreignScope.id, "foreign", taskId);
      expect(foreign.task.state).toBe("running");
      expect(foreign.task.instruction).toBe("FOREIGN TENANT INSTRUCTION");
      expect(foreign.sources.map(item => item.text)).toEqual(["FOREIGN TENANT EVIDENCE"]);
      expect(foreign.events).toHaveLength(0);
      expect(db.prepare("SELECT settled,charged FROM reservations WHERE workspace_id=? AND token=?").get(foreignWorkspace, model.lease.token)).toMatchObject({ settled: 0, charged: 0 });
      expect(db.prepare("SELECT state FROM jobs WHERE workspace_id=? AND id=?").get(foreignWorkspace, model.lease.id)?.state).toBe("leased");
      await command({ kind: "forget_sources", sourceIds: [source.id] }, "manager");
      expect((await store.task(foreignScope.id, "foreign", taskId)).sources[0]?.text).toBe("FOREIGN TENANT EVIDENCE");
      expect(db.prepare("SELECT data FROM transcripts WHERE workspace_id=? AND task_id=?").get(foreignWorkspace, taskId)?.data).toContain("FOREIGN TENANT HISTORY");
      expect(db.prepare("SELECT text FROM notes WHERE workspace_id=? AND task_id=?").get(foreignWorkspace, taskId)?.text).toBe("FOREIGN TENANT NOTE");
      expect(JSON.stringify(await store.task(scope.id, "member", taskId))).not.toContain("FOREIGN TENANT");
    } finally { db.close(); }
  });

});
