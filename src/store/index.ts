import { createHash, randomUUID } from "node:crypto";
import { connectDatabase, inDatabaseTransaction } from "./connection.js";
import type { Db } from "./connection.js";
import { z } from "zod";
import { conversationAnswer } from "../conversation.js";
import {
  approvalSchema, commandSchema, effectSchema, eventSchema, grantSchema, memorySchema,
  nextWallClockInstant, routineSchema, scopeSchema, sourceSchema, taskSchema, taskViewSchema, transcriptSchema,
  turnSchema, toolCallSchema, workspaceViewSchema,
} from "../core.js";
import type {
  Approval, AuditEvent, Command, CommandInput, ConnectorReceipt, Delivery, Effect, Grant,
  Job, Memory, ModelInput, NormalizedUpdate, Receipt, Routine, Scope, Seed, Source, Store,
  StoreOptions, Task, TaskView, ToolCall, ToolName, Transcript, Turn,
} from "../core.js";


type Table = "scopes" | "tasks" | "sources" | "effects" | "approvals" | "events" | "memories" | "routines" | "grants";
type CommandContext = { db: Db; scope: Scope; userId: string; role: string; denied: (message?: string) => Receipt };
const inactiveScopeCommands = new Set<Command["kind"]>(["set_scope", "stop", "cancel", "forget_sources", "correct_memory", "set_memory"]);

type RoutineOccurrenceWalk =
  | { truncated: false; occurrence: number; nextAt: number }
  | { truncated: true; nextAt: number };

// Scheduled occurrence at or before now, walked in wall-clock steps. When the walk
// exceeds 50 intervals, the backlog is truncated and the routine advances directly
// to the next future run without replaying stale occurrences.
function walkWallClockOccurrence(routine: Routine, now: number): RoutineOccurrenceWalk {
  let occurrence = routine.nextAt;
  let next = nextWallClockInstant(occurrence, routine.intervalMs, routine.timezone);
  let walked = 0;
  while (next <= now && walked < 50) {
    occurrence = next;
    next = nextWallClockInstant(occurrence, routine.intervalMs, routine.timezone);
    walked += 1;
  }
  if (next <= now) {
    let fast = occurrence;
    const jumps = Math.max(1, Math.floor((now - fast) / routine.intervalMs) - 1);
    fast += jumps * routine.intervalMs;
    while (fast <= now) {
      fast = nextWallClockInstant(fast, routine.intervalMs, routine.timezone);
    }
    return { truncated: true, nextAt: fast };
  }
  return { truncated: false, occurrence, nextAt: next };
}
function grantForCall(grants: Grant[], call: ToolCall): Grant | undefined {
  if (call.name === "notion_search" || call.name === "notion_read_page") return grants.find(grant => grant.active && grant.kind === "notion_scope" && grant.read);
  return grants.find(grant => grant.active && grant.kind !== "notion_scope" && grant.repository === call.input.repository && (call.name === "github_read_issues" ? grant.read : grant.write));
}
type Location = z.infer<typeof locationSchema>;
const locationSchema = z.object({ workspace_id: z.string(), scope_id: z.string() });
const receiptSchema = z.object({ kind: z.enum(["accepted", "duplicate", "ignored", "denied"]), taskId: z.string().optional(), message: z.string().optional() });
const deliverySchema = z.object({ id: z.string(), taskId: z.string().nullable(), scopeId: z.string(), chatId: z.string(), topicId: z.number().int().nullable(), text: z.string(), buttons: z.array(z.object({ text: z.string(), data: z.string() })), messageId: z.number().int().nullable(), replyTo: z.number().int().optional(), format: z.literal("markdown").optional(), purpose: z.enum(["acknowledgement", "progress", "settings"]).optional() });
const jobRowSchema = z.object({ workspace_id: z.string(), scope_id: z.string(), task_id: z.string().nullable(), id: z.string(), entity_id: z.string(), kind: z.enum(["model", "effect", "delivery"]), data: z.unknown(), state: z.enum(["ready", "leased", "done", "held"]), token: z.string().nullable(), worker_id: z.string().nullable(), expires_at: z.coerce.number().nullable(), attempts: z.number() });
const workspaceRowSchema = z.object({ budget: z.coerce.number(), held: z.coerce.number(), spent: z.coerce.number(), authority_revision: z.number() });
const totalsSchema = z.object({ held: z.coerce.number(), spent: z.coerce.number() });
const dependencySchema = z.object({ id: z.string(), revision: z.number().int().positive() });
const reservationSchema = z.object({ token: z.string(), amount: z.coerce.number(), charged: z.coerce.number(), expired: z.boolean(), epoch: z.number(), authority_revision: z.number(), sources: z.array(dependencySchema), memories: z.array(dependencySchema), settled: z.boolean() });
const uuid = () => randomUUID();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const liveStates = new Set<Task["state"]>(["queued", "running", "waiting_for_input", "waiting_for_approval"]);
const manager = (role: string | null) => role === "owner" || role === "manager";
const pendingJobLimitPerWorkspace = 500;
const modelLeaseLimitPerScope = 2;
const deferredClaimMs = 250;
const scopeSourceWindowLimit = 300;

async function rows<T>(db: Db, sql: string, parameters: unknown[], schema: z.ZodType<T>): Promise<T[]> {
  const result = await db.query<Record<string, unknown>>(sql, parameters);
  return result.rows.map(row => schema.parse(row));
}
async function records<T>(db: Db, table: Table, schema: z.ZodType<T>, clause: string, parameters: unknown[]): Promise<T[]> {
  const result = await db.query<{ data: unknown }>(`SELECT data FROM ${table} WHERE workspace_id=$workspace AND ${clause}`, parameters);
  return result.rows.map(row => schema.parse(row.data));
}
async function save<T extends { id: string }>(db: Db, table: Table, value: T): Promise<void> {
  await db.query(`UPDATE ${table} SET data=$2 WHERE workspace_id=$workspace AND id=$1`, [value.id, JSON.stringify(value)]);
}
function first<T>(items: T[]): T {
  const value = items[0];
  if (!value) throw new Error("Record unavailable");
  return value;
}
async function taskRecord(db: Db, scopeId: string, taskId: string): Promise<Task> {
  return first(await records(db, "tasks", taskSchema, "scope_id=$1 AND id=$2", [scopeId, taskId]));
}
async function roleFor(db: Db, scopeId: string, userId: string): Promise<"owner" | "manager" | "member" | null> {
  const result = await rows(db, "SELECT role FROM memberships WHERE workspace_id=$workspace AND scope_id=$1 AND user_id=$2", [scopeId, userId], z.object({ role: z.enum(["owner", "manager", "member"]) }));
  return result[0]?.role ?? null;
}
async function append(db: Db, task: Task, transcript: Transcript): Promise<number> {
  const result = await rows(db, "INSERT INTO transcripts(workspace_id,scope_id,task_id,sequence,data) SELECT $1,$2,$3,COALESCE(MAX(sequence),0)+1,$4 FROM transcripts WHERE workspace_id=$workspace AND task_id=$3 RETURNING sequence", [task.workspaceId, task.scopeId, task.id, JSON.stringify(transcript)], z.object({ sequence: z.number() }));
  return first(result).sequence;
}
async function history(db: Db, taskId: string): Promise<Transcript[]> {
  const result = await db.query<{ data: unknown }>("SELECT data FROM transcripts WHERE workspace_id=$workspace AND task_id=$1 ORDER BY sequence", [taskId]);
  return result.rows.map(row => transcriptSchema.parse(row.data));
}
async function event(db: Db, scope: Scope, taskId: string | null, actorId: string | null, kind: string, detail: z.infer<typeof eventSchema>["detail"], at: number): Promise<void> {
  const value: AuditEvent = { id: uuid(), scopeId: scope.id, taskId, actorId, kind, detail, at };
  await db.query("INSERT INTO events(workspace_id,scope_id,task_id,id,data) VALUES($1,$2,$3,$4,$5)", [scope.workspaceId, scope.id, taskId, value.id, JSON.stringify(value)]);
}
async function queue(db: Db, scope: Scope, taskId: string | null, kind: Job["kind"], entityId: string, data: unknown, now: number): Promise<void> {
  const existing = await rows(db, "SELECT state FROM jobs WHERE workspace_id=$workspace AND kind=$1 AND entity_id=$2", [kind, entityId], z.object({ state: z.string() }));
  if (existing[0]?.state === "ready" || existing[0]?.state === "leased") return;
  const pending = first(await rows(db, "SELECT count(*) AS count FROM jobs WHERE workspace_id=$workspace AND state IN ('ready','leased')", [], z.object({ count: z.coerce.number().int() }))).count;
  const state = pending >= pendingJobLimitPerWorkspace ? "held" : "ready";
  await db.query("INSERT INTO jobs(workspace_id,scope_id,task_id,id,entity_id,kind,data,state,ready_at) VALUES($1,$2,$3,$4,$5,$6,$7,$9,$8) ON CONFLICT(workspace_id,kind,entity_id) DO UPDATE SET state=$9,ready_at=$8,data=$7,token=NULL,worker_id=NULL,expires_at=NULL WHERE jobs.state IN ('done','held')", [scope.workspaceId, scope.id, taskId, uuid(), entityId, kind, JSON.stringify(data), now, state]);
  if (state === "held") {
    if (taskId && kind !== "delivery") { const task = await taskRecord(db, scope.id, taskId); if (liveStates.has(task.state)) await save(db, "tasks", { ...task, state: "blocked", reason: "Workspace pending-job limit reached. Resume after capacity becomes available." }); }
    await event(db, scope, taskId, null, "queue_capacity_held", { kind, limit: pendingJobLimitPerWorkspace }, now);
  }
}
async function notice(db: Db, scope: Scope, task: Task | null, text: string, now: number, buttons: Delivery["buttons"] = [], purpose?: Delivery["purpose"], format?: Delivery["format"]): Promise<void> {
  const delivery: Delivery = { id: uuid(), scopeId: scope.id, taskId: task?.id ?? null, chatId: scope.chatId, topicId: task?.topicId ?? null, text, buttons, messageId: null, ...(purpose ? { purpose } : {}), ...(format ? { format } : {}) };
  await queue(db, scope, task?.id ?? null, "delivery", delivery.id, delivery, now);
}

// One durable progress message per task. Never post a late working notice after the answer.
async function progress(db: Db, scope: Scope, task: Task, text: string, now: number, delayMs = 0): Promise<void> {
  const id = `progress:${task.id}`;
  const existing = (await rows(db, "SELECT * FROM jobs WHERE workspace_id=$workspace AND kind='delivery' AND entity_id=$1", [id], jobRowSchema))[0];
  if (existing?.state === "leased") return;
  const previous = existing ? deliverySchema.parse(existing.data) : undefined;
  const active = task.state === "queued" || task.state === "running";
  const delivery: Delivery = { id, scopeId: scope.id, taskId: task.id, chatId: scope.chatId, topicId: task.topicId, text, buttons: active ? [{ text: "Stop", data: `stop:${task.id}` }] : [], messageId: previous?.messageId ?? null, purpose: "progress" };
  if (existing?.state === "done" && previous?.text === delivery.text && JSON.stringify(previous.buttons) === JSON.stringify(delivery.buttons)) return;
  if (!active && delivery.messageId === null) {
    if (existing) await db.query("UPDATE jobs SET state='done',data=$2 WHERE workspace_id=$workspace AND id=$1", [existing.id, JSON.stringify(delivery)]);
    return;
  }
  if (existing?.state === "ready") await db.query("UPDATE jobs SET data=$2 WHERE workspace_id=$workspace AND id=$1", [existing.id, JSON.stringify(delivery)]);
  await queue(db, scope, task.id, "delivery", id, delivery, now);
  if (delayMs) await db.query("UPDATE jobs SET ready_at=$2 WHERE workspace_id=$workspace AND kind='delivery' AND entity_id=$1 AND state='ready'", [id, now + delayMs]);
}

function settledProgress(task: Task): string {
  if (task.state === "completed") return "Finished. My answer is below.";
  if (task.state === "waiting_for_approval") return "Waiting for a manager to review the proposed action.";
  if (task.state === "waiting_for_input") return "Waiting for your reply.";
  if (task.state === "stopping") return "Stopping. An operation may still be in flight.";
  return "I'm not working on this right now.";
}

export async function migrateDatabase(databasePath: string): Promise<void> {
  const connection = connectDatabase(databasePath);
  try { await inDatabaseTransaction(connection, async () => undefined); }
  finally { connection.close(); }
}

class SQLiteStore implements Store {
  readonly connection;
  readonly options: StoreOptions;
  readonly now: () => number;
  constructor(options: StoreOptions) {
    this.options = options;
    this.now = options.clock ?? Date.now;
    this.connection = connectDatabase(options.databasePath);
  }
  async transact<T>(workspaceId: string, operation: (db: Db) => Promise<T>): Promise<T> {
    return inDatabaseTransaction(this.connection, () => operation(this.connection.context(workspaceId)));
  }
  async locate(scopeId: string): Promise<Location> {
    return first(await this.connection.discover("SELECT workspace_id,id AS scope_id FROM scopes WHERE id=$1", [scopeId], locationSchema));
  }
  async scopeTransaction<T>(scopeId: string, operation: (db: Db, scope: Scope) => Promise<T>): Promise<T> {
    const location = await this.locate(scopeId);
    return this.transact(location.workspace_id, async db => operation(db, first(await records(db, "scopes", scopeSchema, "id=$1", [scopeId]))));
  }
  async seed(input: Seed): Promise<void> {
    await this.transact(input.workspaceId, async db => {
      await db.query("INSERT INTO workspaces(id,bot_id,owner_id,name,budget) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING", [input.workspaceId, input.botId, input.ownerId, input.name, input.budgetMicros]);
      for (const raw of input.scopes) {
        const scope = scopeSchema.parse(raw);
        if (scope.workspaceId !== input.workspaceId) throw new Error("Scope tenant mismatch");
        await db.query("INSERT INTO scopes(workspace_id,id,bot_id,chat_id,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,id) DO NOTHING", [input.workspaceId, scope.id, input.botId, scope.chatId, JSON.stringify(scope)]);
        await db.query("INSERT INTO bindings(workspace_id,scope_id,bot_id,chat_id) VALUES($1,$2,$3,$4) ON CONFLICT(bot_id,chat_id) DO NOTHING", [input.workspaceId, scope.id, input.botId, scope.chatId]);
      }
      for (const membership of input.memberships) await db.query("INSERT INTO memberships(workspace_id,scope_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [input.workspaceId, membership.scopeId, membership.userId, membership.role]);
      for (const raw of input.grants) {
        const grant = grantSchema.parse(raw);
        await db.query("INSERT INTO grants(workspace_id,scope_id,id,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [input.workspaceId, grant.scopeId, grant.id, JSON.stringify(grant)]);
      }
    });
  }
  async resolveChat(botId: string, chatId: string): Promise<Scope | null> {
    const result = await this.connection.discover("SELECT workspace_id,scope_id FROM bindings WHERE bot_id=$1 AND chat_id=$2", [botId, chatId], locationSchema);
    const location = result[0] ?? null;
    return location ? this.transact(location.workspace_id, async db => (await records(db, "scopes", scopeSchema, "id=$1", [location.scope_id]))[0] ?? null) : null;
  }
  async scopes(userId: string): Promise<Scope[]> {
    const result = await this.connection.discover("SELECT workspace_id,scope_id FROM memberships WHERE user_id=$1", [userId], locationSchema);
    const found: Scope[] = [];
    for (const location of result) {
      if (this.options.workspaceIds && !this.options.workspaceIds.includes(location.workspace_id)) continue;
      const scope = await this.scopeTransaction(location.scope_id, async (db, scope) => (await roleFor(db, scope.id, userId)) && (scope.kind !== "dm" || scope.ownerId === userId) ? scope : null);
      if (scope) found.push(scope);
    }
    return found;
  }
  async authorize(db: Db, scope: Scope, userId: string): Promise<"owner" | "manager" | "member"> {
    const role = await roleFor(db, scope.id, userId);
    if (!role || (scope.kind === "dm" && scope.ownerId !== userId)) throw new Error("Access denied");
    return role;
  }
  async taskView(db: Db, scope: Scope, task: Task): Promise<TaskView> {
    const effectRows = await rows(db, "SELECT data,redacted FROM effects WHERE workspace_id=$workspace AND task_id=$1", [task.id], z.object({ data: effectSchema, redacted: z.boolean() }));
    const effects = effectRows.map(row => row.redacted ? this.redactedEffect(row.data) : row.data);
    return taskViewSchema.parse({ task, effects, approvals: await records(db, "approvals", approvalSchema, "task_id=$1", [task.id]), events: await records(db, "events", eventSchema, "task_id=$1 ORDER BY data->>'at',id", [task.id]), sources: await records(db, "sources", sourceSchema, "scope_id=$1 AND NOT deleted ORDER BY data->>'capturedAt'", [scope.id]) });
  }
  redactedEffect(effect: Effect): Effect {
    return { ...effect, call: effect.call.name === "github_create_issue" ? { ...effect.call, input: { repository: effect.call.input.repository, title: "[Content removed]", body: "[Content removed]", labels: [] } } : effect.call.name === "notion_search" ? { ...effect.call, input: { query: "[Content removed]" } } : effect.call, result: effect.result === null ? null : "[Effect content removed following source invalidation]" };
  }
  async view(scopeId: string, userId: string) {
    return this.scopeTransaction(scopeId, async (db, scope) => {
      const role = await this.authorize(db, scope, userId);
      const tasks = await records(db, "tasks", taskSchema, "scope_id=$1 ORDER BY data->>'createdAt' DESC", [scopeId]);
      const usage = first(await rows(db, "SELECT held,spent FROM scopes WHERE workspace_id=$workspace AND id=$1", [scopeId], totalsSchema));
      const taskViews: TaskView[] = [];
      for (const task of tasks) taskViews.push(await this.taskView(db, scope, task));
      return workspaceViewSchema.parse({ scope, role, tasks: taskViews, memories: await records(db, "memories", memorySchema, "scope_id=$1", [scopeId]), routines: await records(db, "routines", routineSchema, "scope_id=$1", [scopeId]), grants: await records(db, "grants", grantSchema, "scope_id=$1", [scopeId]), usage: { heldMicros: usage.held, spentMicros: usage.spent, simulated: this.options.simulated } });
    });
  }
  async connectRepositoryGrants(scopeId: string, userId: string, connectionId: string, connectionVersion: number, repositories: string[]): Promise<void> {
    const names = z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(500).parse(repositories);
    z.string().min(1).max(128).parse(connectionId);
    z.number().int().positive().parse(connectionVersion);
    await this.scopeTransaction(scopeId, async (db, scope) => {
      const role = await this.authorize(db, scope, userId);
      if (role === "member" || !scope.active) throw new Error("Connector management denied");
      const grants = await records(db, "grants", grantSchema, "scope_id=$1", [scopeId]);
      for (const grant of grants.filter(item => item.kind !== "notion_scope")) await save(db, "grants", { ...grant, active: false, revision: grant.revision + 1 });
      for (const repository of new Set(names)) {
        const previous = grants.find(item => item.kind !== "notion_scope" && item.connectionId === connectionId && item.repository === repository);
        const grant = grantSchema.parse({ id: previous?.id ?? uuid(), scopeId, repository, read: true, write: true, active: true, revision: (previous?.revision ?? 0) + 1, connectionId, connectionVersion });
        await db.query("INSERT INTO grants(workspace_id,scope_id,id,data) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,id) DO UPDATE SET data=excluded.data", [scope.workspaceId, scopeId, grant.id, JSON.stringify(grant)]);
      }
      await this.fenceScope(db, scope, "Connector authorization changed.");
      await event(db, scope, null, userId, "connector_grants_connected", { connectionId, connectionVersion, repositories: names }, this.now());
    });
  }
  async connectNotionGrant(scopeId: string, userId: string, connectionId: string, connectionVersion: number, notionWorkspaceId: string): Promise<void> {
    await this.scopeTransaction(scopeId, async (db, scope) => {
      if (await this.authorize(db, scope, userId) === "member" || !scope.active) throw new Error("Connector management denied");
      const grants = await records(db, "grants", grantSchema, "scope_id=$1", [scopeId]);
      for (const grant of grants.filter(item => item.kind === "notion_scope")) await save(db, "grants", { ...grant, active: false, revision: grant.revision + 1 });
      const previous = grants.find(item => item.kind === "notion_scope" && item.connectionId === connectionId);
      const grant = grantSchema.parse({ kind: "notion_scope", id: previous?.id ?? uuid(), scopeId, read: true, active: true, revision: (previous?.revision ?? 0) + 1, connectionId, connectionVersion, notionWorkspaceId });
      await db.query("INSERT INTO grants(workspace_id,scope_id,id,data) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,id) DO UPDATE SET data=excluded.data", [scope.workspaceId, scopeId, grant.id, JSON.stringify(grant)]);
      await this.fenceScope(db, scope, "Notion authorization changed.");
      await event(db, scope, null, userId, "notion_grant_connected", { connectionId, connectionVersion, notionWorkspaceId }, this.now());
    });
  }
  async disconnectRepositoryGrants(scopeId: string, userId: string, connectionId: string): Promise<void> {
    await this.scopeTransaction(scopeId, async (db, scope) => {
      if (await this.authorize(db, scope, userId) === "member") throw new Error("Connector management denied");
      for (const grant of await records(db, "grants", grantSchema, "scope_id=$1", [scopeId])) if (grant.connectionId === connectionId) await save(db, "grants", { ...grant, active: false, revision: grant.revision + 1 });
      await this.fenceScope(db, scope, "Connector disconnected.");
      await event(db, scope, null, userId, "connector_grants_disconnected", { connectionId }, this.now());
    });
  }
  async task(scopeId: string, userId: string, taskId: string): Promise<TaskView> {
    return this.scopeTransaction(scopeId, async (db, scope) => { await this.authorize(db, scope, userId); return this.taskView(db, scope, await taskRecord(db, scopeId, taskId)); });
  }
  async createTask(db: Db, scope: Scope, userId: string, instruction: string, topicId: number | null, budget = this.options.taskBudgetMicros): Promise<Task> {
    const task: Task = { id: uuid(), workspaceId: scope.workspaceId, scopeId: scope.id, requesterId: userId, topicId, instruction, state: "queued", revision: 1, epoch: 0, turns: 0, maxTurns: this.options.maxTurns, budgetMicros: budget, result: null, reason: null, createdAt: this.now() };
    await db.query("INSERT INTO tasks(workspace_id,scope_id,id,data) VALUES($1,$2,$3,$4)", [scope.workspaceId, scope.id, task.id, JSON.stringify(task)]);
    await append(db, task, { role: "user", content: [{ type: "text", text: instruction }] });
    await event(db, scope, task.id, userId, "task_started", { revision: task.revision }, this.now());
    await queue(db, scope, task.id, "model", task.id, {}, this.now());
    await notice(db, scope, task, "On it.", this.now(), [], "acknowledgement");
    await progress(db, scope, task, "I'm still working on this.", this.now(), 8000);
    return task;
  }
  async admissionReason(db: Db, requiredJobs: number): Promise<string | null> {
    const pending = first(await rows(db, "SELECT count(*) AS count FROM jobs WHERE workspace_id=$workspace AND state IN ('ready','leased')", [], z.object({ count: z.coerce.number().int() }))).count;
    return pending + requiredJobs > pendingJobLimitPerWorkspace ? "Workspace pending-job limit reached." : null;
  }
  async command(input: CommandInput): Promise<Receipt> {
    const command = commandSchema.parse(input.command);
    return this.scopeTransaction(input.scopeId, (db, scope) => this.commandIn(db, scope, { ...input, command }));
  }
  async commandIn(db: Db, scope: Scope, input: CommandInput): Promise<Receipt> {
    const previous = await rows(db, "SELECT hash,receipt FROM commands WHERE workspace_id=$workspace AND scope_id=$1 AND user_id=$2 AND key=$3", [scope.id, input.userId, input.key], z.object({ hash: z.string(), receipt: receiptSchema }));
    const hash = digest(input.command);
    if (previous[0]) return previous[0].hash === hash ? { ...previous[0].receipt, kind: "duplicate" } : { kind: "denied", message: "Command key already identifies a different action." };
    let receipt: Receipt;
    const role = await roleFor(db, scope.id, input.userId);
    if (!role || (scope.kind === "dm" && scope.ownerId !== input.userId)) receipt = { kind: "denied", message: "Access denied." };
    else receipt = await this.applyCommand(db, scope, input.userId, role, input.command);
    await db.query("INSERT INTO commands(workspace_id,scope_id,user_id,key,hash,receipt) VALUES($1,$2,$3,$4,$5,$6)", [scope.workspaceId, scope.id, input.userId, input.key, hash, JSON.stringify(receipt)]);
    return receipt;
  }
  async invalidateEffects(db: Db, scope: Scope, task: Task, reason: string): Promise<void> {
    const effects = await records(db, "effects", effectSchema, "task_id=$1", [task.id]);
    for (const effect of effects) {
      if (["prepared", "waiting_for_approval", "ready"].includes(effect.state)) {
        await save(db, "effects", { ...effect, state: "denied", reason, result: reason });
        await db.query("UPDATE jobs SET state='held' WHERE workspace_id=$workspace AND kind='effect' AND entity_id=$1", [effect.id]);
      }
    }
    for (const approval of await records(db, "approvals", approvalSchema, "task_id=$1", [task.id])) if (approval.state === "pending" || approval.state === "approved") await save(db, "approvals", { ...approval, state: "invalidated" });
    await this.completeToolResults(db, scope, task);
  }
  async completeToolResults(db: Db, scope: Scope, task: Task): Promise<boolean> {
    const transcripts = await history(db, task.id);
    const lastAssistant = transcripts.findLastIndex(row => row.role === "assistant" && row.content.some(block => block.type === "tool_use"));
    if (lastAssistant < 0) return true;
    const assistant = transcripts[lastAssistant];
    if (!assistant) return true;
    const uses = assistant.content.filter(block => block.type === "tool_use");
    const results = new Set(transcripts.slice(lastAssistant + 1).flatMap(row => row.content.filter(block => block.type === "tool_result").map(block => block.tool_use_id)));
    if (uses.every(use => results.has(use.id))) return true;
    const effects = await records(db, "effects", effectSchema, "task_id=$1", [task.id]);
    const pending = uses.filter(use => !results.has(use.id)).map(use => ({ use, effect: effects.find(effect => effect.call.id === use.id) }));
    if (pending.some(({ effect }) => !effect || !["succeeded", "denied"].includes(effect.state))) return false;
    await append(db, task, { role: "user", content: pending.map(({ use, effect }) => ({ type: "tool_result", tool_use_id: use.id, content: effect?.result ?? "Tool denied.", is_error: effect?.state !== "succeeded" })) });
    await this.flushNotes(db, task);
    return true;
  }
  async flushNotes(db: Db, task: Task): Promise<void> {
    const notes = await rows(db, "SELECT id,text FROM notes WHERE workspace_id=$workspace AND task_id=$1 ORDER BY sequence", [task.id], z.object({ id: z.string(), text: z.string() }));
    for (const note of notes) { await append(db, task, { role: "user", content: [{ type: "text", text: note.text }] }); await db.query("DELETE FROM notes WHERE workspace_id=$workspace AND id=$1", [note.id]); }
  }
  async note(db: Db, scope: Scope, task: Task, text: string): Promise<void> {
    const counter = first(await rows(db, "UPDATE tasks SET note_sequence=note_sequence+1 WHERE workspace_id=$workspace AND id=$1 RETURNING note_sequence", [task.id], z.object({ note_sequence: z.coerce.number().int().positive() })));
    await db.query("INSERT INTO notes(workspace_id,scope_id,task_id,id,at,text,sequence) VALUES($1,$2,$3,$4,$5,$6,$7)", [scope.workspaceId, scope.id, task.id, uuid(), this.now(), text, counter.note_sequence]);
    if (await this.completeToolResults(db, scope, task)) await this.flushNotes(db, task);
  }
  async applyCommand(db: Db, scope: Scope, userId: string, role: string, command: Command): Promise<Receipt> {
    const denied = (message = "Action denied."): Receipt => ({ kind: "denied", message });
    if (!scope.active && !inactiveScopeCommands.has(command.kind)) return denied("Scope inactive.");
    const context: CommandContext = { db, scope, userId, role, denied };
    switch (command.kind) {
      case "start": return this.commandStart(command, context);
      case "steer":
      case "stop":
      case "resume":
      case "cancel": return this.commandTaskControl(command, context);
      case "decide": return this.commandDecide(command, context);
      case "remember": return this.commandRemember(command, context);
      case "correct_memory":
      case "set_memory": return this.commandEditMemory(command, context);
      case "forget_sources": return this.commandForgetSources(command, context);
      case "create_routine": return this.commandCreateRoutine(command, context);
      case "set_routine": return this.commandSetRoutine(command, context);
      case "revoke_grant": return this.commandRevokeGrant(command, context);
      case "set_scope": return this.commandSetScope(command, context);
      default: { const unhandled: never = command; throw new Error(`Unhandled command ${JSON.stringify(unhandled)}`); }
    }
  }
  private async commandStart(command: Extract<Command, { kind: "start" }>, context: CommandContext): Promise<Receipt> {
    const { db, scope, userId, denied } = context;
    const reason = await this.admissionReason(db, 3);
    if (reason) return denied(reason);
    const task = await this.createTask(db, scope, userId, command.instruction, command.topicId);
    return { kind: "accepted", taskId: task.id };
  }
  private async commandTaskControl(command: Extract<Command, { kind: "steer" | "stop" | "resume" | "cancel" }>, context: CommandContext): Promise<Receipt> {
    const { db, scope, userId, denied } = context;
    const task = (await records(db, "tasks", taskSchema, "scope_id=$1 AND id=$2", [scope.id, command.taskId]))[0];
    if (!task) return denied();
    if (task.state === "canceled") return denied("Task canceled. Start a new task.");
    if (command.kind === "steer") {
      if (!liveStates.has(task.state)) { const reason = await this.admissionReason(db, 1); if (reason) return denied(reason); }
      const updated: Task = { ...task, epoch: task.epoch + 1, revision: task.revision + 1, state: "queued", reason: null };
      await save(db, "tasks", updated);
      await this.invalidateEffects(db, scope, updated, "Action invalidated by steering.");
      await this.note(db, scope, updated, `Instruction from ${userId}: ${command.text}`);
      await db.query("UPDATE jobs SET state='held' WHERE workspace_id=$workspace AND kind='model' AND entity_id=$1", [task.id]);
      await queue(db, scope, task.id, "model", task.id, {}, this.now());
      await event(db, scope, task.id, userId, "steering_recorded", { text: command.text, revision: updated.revision }, this.now());
      await notice(db, scope, updated, "Got it.", this.now(), [], "acknowledgement");
      await progress(db, scope, updated, "I'm working through your update.", this.now(), 8000);
    } else if (command.kind === "stop" || command.kind === "cancel") {
      const inflight = (await records(db, "effects", effectSchema, "task_id=$1 AND data->>'state' IN ('dispatching','unknown')", [task.id])).length;
      const running = await rows(db, "SELECT id FROM jobs WHERE workspace_id=$workspace AND task_id=$1 AND kind='model' AND state='leased' AND expires_at>$2", [task.id, this.now()], z.object({ id: z.string() }));
      const updated: Task = { ...task, epoch: task.epoch + 1, revision: task.revision + 1, state: command.kind === "cancel" ? "canceled" : inflight || running.length ? "stopping" : "paused", reason: inflight ? "An external effect is still in flight or unknown." : null };
      await save(db, "tasks", updated);
      await this.invalidateEffects(db, scope, updated, "Dispatch stopped.");
      await db.query("UPDATE jobs SET state='held' WHERE workspace_id=$workspace AND task_id=$1 AND kind='model' AND state='ready'", [task.id]);
      await event(db, scope, task.id, userId, command.kind === "stop" ? "stop_requested" : "task_canceled", { inFlightEffects: inflight }, this.now());
      await notice(db, scope, updated, `${updated.state === "stopping" ? "I’m stopping." : updated.state === "canceled" ? "I’ve canceled this work." : "I’ve stopped."}${inflight ? " An external action is still pending. I’ll confirm its outcome before any retry." : " Completed actions are retained."}`, this.now());
      await progress(db, scope, updated, settledProgress(updated), this.now());
    } else {
      if (!["paused", "stopping", "blocked", "failed", "waiting_for_input"].includes(task.state)) return denied("Task is not resumable.");
      const admission = await this.admissionReason(db, 1);
      if (admission) return denied(admission);
      const updated: Task = { ...task, epoch: task.epoch + 1, revision: task.revision + 1, state: "queued", reason: null };
      await save(db, "tasks", updated);
      await this.invalidateEffects(db, scope, updated, "Resume requires a fresh action review.");
      for (const effect of await records(db, "effects", effectSchema, "task_id=$1 AND data->>'state'='unknown'", [task.id])) await queue(db, scope, task.id, "effect", effect.id, {}, this.now());
      await db.query("UPDATE jobs SET state='held' WHERE workspace_id=$workspace AND kind='model' AND entity_id=$1", [task.id]);
      await queue(db, scope, task.id, "model", task.id, {}, this.now());
      await event(db, scope, task.id, userId, "task_resumed", { revision: updated.revision }, this.now());
      await notice(db, scope, updated, "I'll pick this back up.", this.now(), [], "acknowledgement");
      await progress(db, scope, updated, "I'm continuing the work.", this.now(), 8000);
    }
    return { kind: "accepted", taskId: task.id };
  }
  private async commandDecide(command: Extract<Command, { kind: "decide" }>, context: CommandContext): Promise<Receipt> {
    const { db, scope, userId, denied } = context;
    if (!manager(context.role)) return denied("A current manager must approve this action.");
    const approval = (await records(db, "approvals", approvalSchema, "scope_id=$1 AND id=$2", [scope.id, command.approvalId]))[0];
    if (!approval) return denied();
    if (approval.state === "approved" || approval.state === "denied") return { kind: "duplicate", taskId: approval.taskId };
    if (approval.state !== "pending") return denied("Approval is no longer valid.");
    const task = await taskRecord(db, scope.id, approval.taskId);
    const effect = first(await records(db, "effects", effectSchema, "id=$1", [approval.effectId]));
    const valid = approval.expiresAt > this.now() && approval.hash === effect.hash && digest(effect.call) === effect.hash && await this.effectAllowed(db, scope, task, effect);
    if (!valid) { await save(db, "approvals", { ...approval, state: approval.expiresAt <= this.now() ? "expired" : "invalidated" }); await save(db, "effects", { ...effect, state: "denied", result: "Approval expired or invalidated.", reason: "Approval expired or invalidated." }); await this.advance(db, scope, task); return denied("Approval expired or invalidated."); }
    await save(db, "approvals", { ...approval, state: command.decision === "approve" ? "approved" : "denied", decidedBy: userId });
    await save(db, "effects", { ...effect, state: command.decision === "approve" ? "ready" : "denied", result: command.decision === "deny" ? "Manager denied this action." : null });
    await event(db, scope, task.id, userId, "approval_decided", { approvalId: approval.id, effectId: effect.id, hash: effect.hash, decision: command.decision, taskRevision: effect.taskRevision, policyRevision: effect.policyRevision, grantRevision: effect.grantRevision }, this.now());
    if (command.decision === "approve") await queue(db, scope, task.id, "effect", effect.id, {}, this.now());
    else await this.advance(db, scope, task);
    return { kind: "accepted", taskId: task.id };
  }
  private async commandRemember(command: Extract<Command, { kind: "remember" }>, context: CommandContext): Promise<Receipt> {
    const { db, scope, userId, denied } = context;
    const evidence = await records(db, "sources", sourceSchema, "scope_id=$1 AND NOT deleted AND id IN (SELECT value FROM json_each($2))", [scope.id, command.evidenceIds]);
    if (evidence.length !== new Set(command.evidenceIds).size) return denied("Evidence unavailable in this scope.");
    const memory: Memory = { id: uuid(), scopeId: scope.id, content: command.content, evidenceIds: command.evidenceIds, revision: 1, state: command.candidate ? "candidate" : "active", authorId: userId, correctedByHuman: false };
    await db.query("INSERT INTO memories(workspace_id,scope_id,id,data) VALUES($1,$2,$3,$4)", [scope.workspaceId, scope.id, memory.id, JSON.stringify(memory)]);
    await event(db, scope, null, userId, "memory_saved", { memoryId: memory.id }, this.now());
    return { kind: "accepted" };
  }
  private async commandEditMemory(command: Extract<Command, { kind: "correct_memory" | "set_memory" }>, context: CommandContext): Promise<Receipt> {
    const { db, scope, userId, denied } = context;
    const memory = (await records(db, "memories", memorySchema, "scope_id=$1 AND id=$2", [scope.id, command.memoryId]))[0];
    if (!memory) return denied();
    if (command.kind === "correct_memory" && command.expectedRevision !== memory.revision) return denied("Memory changed. Reload before correcting.");
    const updated: Memory = command.kind === "correct_memory" ? { ...memory, content: command.content, revision: memory.revision + 1, correctedByHuman: true, state: "active" } : { ...memory, state: command.state, revision: memory.revision + 1 };
    await save(db, "memories", updated);
    await this.invalidateContextDependencies(db, scope, { sourceIds: [], memoryIds: [memory.id] });
    await event(db, scope, null, userId, "memory_changed", { memoryId: memory.id, revision: updated.revision }, this.now());
    return { kind: "accepted" };
  }
  private async commandForgetSources(command: Extract<Command, { kind: "forget_sources" }>, context: CommandContext): Promise<Receipt> {
    const { db, scope, userId, denied } = context;
    if (!manager(context.role)) return denied("Manager authority required.");
    const sources = await records(db, "sources", sourceSchema, "scope_id=$1 AND id IN (SELECT value FROM json_each($2)) AND NOT deleted", [scope.id, command.sourceIds]);
    if (sources.length !== new Set(command.sourceIds).size) return denied("Source unavailable in this scope.");
    for (const source of sources) { await save(db, "sources", { ...source, text: "[Source removed]", revision: source.revision + 1 }); await db.query("UPDATE sources SET deleted=true WHERE workspace_id=$workspace AND id=$1", [source.id]); }
    await this.invalidateContextDependencies(db, scope, { sourceIds: command.sourceIds, memoryIds: [] });
    await event(db, scope, null, userId, "sources_invalidated", { sourceIds: command.sourceIds }, this.now());
    return { kind: "accepted", message: "Sources and dependent context invalidated. Exact unresolved-effect payloads remain restricted to recovery. External provider copies may remain." };
  }
  private async commandCreateRoutine(command: Extract<Command, { kind: "create_routine" }>, context: CommandContext): Promise<Receipt> {
    const { db, scope, userId, denied } = context;
    if (!manager(context.role)) return denied("Manager authority required.");
    try { new Intl.DateTimeFormat("en", { timeZone: command.timezone }).format(); } catch { return denied("Invalid timezone."); }
    const routine: Routine = { id: uuid(), scopeId: scope.id, createdBy: userId, instruction: command.instruction, state: "active", timezone: command.timezone, nextAt: command.nextAt, intervalMs: command.intervalMs, budgetMicros: command.budgetMicros };
    await db.query("INSERT INTO routines(workspace_id,scope_id,id,data) VALUES($1,$2,$3,$4)", [scope.workspaceId, scope.id, routine.id, JSON.stringify(routine)]);
    await event(db, scope, null, userId, "routine_created", { routineId: routine.id, timezone: routine.timezone, utcOccurrence: routine.nextAt, intervalMs: routine.intervalMs, basis: "wall_clock" }, this.now());
    return { kind: "accepted", message: `Wall-clock schedule saved in ${routine.timezone}. Runs at the same local time each interval.` };
  }
  private async commandSetRoutine(command: Extract<Command, { kind: "set_routine" }>, context: CommandContext): Promise<Receipt> {
    const { db, scope, userId, denied } = context;
    if (!manager(context.role)) return denied("Manager authority required.");
    const routine = (await records(db, "routines", routineSchema, "scope_id=$1 AND id=$2", [scope.id, command.routineId]))[0];
    if (!routine || routine.state === "revoked") return denied();
    const walk = walkWallClockOccurrence(routine, this.now());
    const nextAt = command.state === "active" && routine.nextAt <= this.now() ? walk.nextAt : routine.nextAt;
    await save(db, "routines", { ...routine, state: command.state, nextAt });
    await event(db, scope, null, userId, "routine_changed", { routineId: routine.id, state: command.state }, this.now());
    return { kind: "accepted" };
  }
  private async commandRevokeGrant(command: Extract<Command, { kind: "revoke_grant" }>, context: CommandContext): Promise<Receipt> {
    const { db, scope, userId, denied } = context;
    if (!manager(context.role)) return denied("Manager authority required.");
    const grant = (await records(db, "grants", grantSchema, "scope_id=$1 AND id=$2", [scope.id, command.grantId]))[0];
    if (!grant) return denied();
    await save(db, "grants", { ...grant, active: false, revision: grant.revision + 1 });
    await this.fenceScope(db, scope, "Connector grant revoked.");
    await event(db, scope, null, userId, "grant_revoked", { grantId: grant.id }, this.now());
    return { kind: "accepted" };
  }
  private async commandSetScope(command: Extract<Command, { kind: "set_scope" }>, context: CommandContext): Promise<Receipt> {
    const { db, scope, userId, denied } = context;
    if (!manager(context.role)) return denied("Manager authority required.");
    if (command.workspacePublic !== undefined) {
      const owner = first(await rows(db, "SELECT owner_id FROM workspaces WHERE id=$workspace AND id=$1", [scope.workspaceId], z.object({ owner_id: z.string() })));
      if (owner.owner_id !== userId) return denied("Only the current workspace owner can change workspace sharing.");
    }
    const { kind: _kind, ...changes } = command;
    const validScope: Scope = { ...scope, ...changes, policyRevision: scope.policyRevision + 1 };
    await save(db, "scopes", validScope);
    await this.fenceScope(db, validScope, "Scope policy changed.");
    if (!validScope.active) for (const routine of await records(db, "routines", routineSchema, "scope_id=$1 AND data->>'state'='active'", [scope.id])) await save(db, "routines", { ...routine, state: "paused" });
    await event(db, scope, null, userId, "scope_policy_changed", { revision: validScope.policyRevision, active: validScope.active }, this.now());
    return { kind: "accepted" };
  }
  async invalidateContextDependencies(db: Db, scope: Scope, changedInputs: { sourceIds: string[]; memoryIds: string[] }): Promise<void> {
    const removed = new Set(changedInputs.sourceIds);
    const changedMemories = new Set(changedInputs.memoryIds);
    const tasks = await records(db, "tasks", taskSchema, "workspace_id=$1", [scope.workspaceId]);
    const linkedInputs = await rows(db, `SELECT DISTINCT m.task_id FROM messages m
      JOIN sources linked ON linked.id=m.source_id AND linked.workspace_id=m.workspace_id AND linked.scope_id=m.scope_id
      JOIN sources removed ON removed.workspace_id=m.workspace_id AND removed.scope_id=m.scope_id AND (
        removed.id=linked.id OR (removed.data->>'kind'='text_file' AND removed.data->>'messageId'=linked.data->>'messageId' AND removed.data->>'capturedAt'=linked.data->>'capturedAt')
      ) WHERE m.workspace_id=$workspace AND removed.id IN (SELECT value FROM json_each($1)) AND m.task_id IS NOT NULL`, [changedInputs.sourceIds], z.object({ task_id: z.string() }));
    const ownedSources = await rows(db, "SELECT DISTINCT task_id FROM sources WHERE workspace_id=$workspace AND id IN (SELECT value FROM json_each($1)) AND task_id IS NOT NULL", [changedInputs.sourceIds], z.object({ task_id: z.string() }));
    const inflightEffects = changedInputs.sourceIds.length ? await rows(db, "SELECT DISTINCT task_id FROM effects WHERE workspace_id=$workspace AND scope_id=$1 AND data->>'state' IN ('dispatching','unknown')", [scope.id], z.object({ task_id: z.string() })) : [];
    const affected = new Set([...linkedInputs, ...ownedSources, ...inflightEffects].map(input => input.task_id));
    const reservations = await rows(db, "SELECT task_id,sources,memories FROM reservations WHERE workspace_id=$workspace", [], z.object({ task_id: z.string(), sources: z.array(dependencySchema), memories: z.array(dependencySchema) }));
    const sources = await rows(db, "SELECT data,task_id FROM sources WHERE workspace_id=$workspace AND NOT deleted", [], z.object({ data: sourceSchema, task_id: z.string().nullable() }));
    const memories = await records(db, "memories", memorySchema, "workspace_id=$1", [scope.workspaceId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const reservation of reservations) if (!affected.has(reservation.task_id) && (reservation.sources.some(source => removed.has(source.id)) || reservation.memories.some(memory => changedMemories.has(memory.id)))) { affected.add(reservation.task_id); changed = true; }
      for (const source of sources) if (source.task_id && affected.has(source.task_id) && !removed.has(source.data.id)) { removed.add(source.data.id); changed = true; }
      for (const memory of memories) if (!changedMemories.has(memory.id) && memory.evidenceIds.some(id => removed.has(id))) { changedMemories.add(memory.id); changed = true; }
    }
    for (const source of sources) if (removed.has(source.data.id)) { await save(db, "sources", { ...source.data, text: "[Source removed]", revision: source.data.revision + 1 }); await db.query("UPDATE sources SET deleted=true WHERE workspace_id=$workspace AND id=$1", [source.data.id]); }
    for (const memory of memories) if (memory.evidenceIds.some(id => removed.has(id))) await save(db, "memories", { ...memory, content: "[Evidence removed]", state: "invalidated", revision: memory.revision + 1 });
    await db.query("UPDATE workspaces SET authority_revision=authority_revision+1 WHERE id=$workspace AND id=$1", [scope.workspaceId]);
    for (const task of tasks) {
      if (!affected.has(task.id)) continue;
      const taskScope = first(await records(db, "scopes", scopeSchema, "id=$1", [task.scopeId]));
      const updated: Task = { ...task, epoch: task.epoch + 1, revision: task.revision + 1, instruction: "Continue with current authorized context.", result: null, state: liveStates.has(task.state) ? taskScope.active ? "queued" : "blocked" : task.state, reason: "Source or memory context invalidated. Exact pending-effect records remain restricted to recovery." };
      await save(db, "tasks", updated);
      await this.invalidateEffects(db, taskScope, updated, "Evidence removed.");
      await db.query("UPDATE effects SET redacted=true WHERE workspace_id=$workspace AND task_id=$1", [task.id]);
      const transcriptRows = await rows(db, "SELECT sequence,data FROM transcripts WHERE workspace_id=$workspace AND task_id=$1 ORDER BY sequence", [task.id], z.object({ sequence: z.number(), data: transcriptSchema }));
      for (const row of transcriptRows) {
        const clean: Transcript = { role: row.data.role, content: [{ type: "text", text: "[Content removed following evidence invalidation]" }] };
        await db.query("UPDATE transcripts SET data=$3 WHERE workspace_id=$workspace AND task_id=$1 AND sequence=$2", [task.id, row.sequence, JSON.stringify(clean)]);
      }
      await db.query("UPDATE events SET data=json_set(data,'$.detail.text','[Instruction content removed]') WHERE workspace_id=$workspace AND task_id=$1 AND data->>'kind'='steering_recorded'", [task.id]);
      await db.query("DELETE FROM notes WHERE workspace_id=$workspace AND task_id=$1", [task.id]);
      await db.query("UPDATE jobs SET state='held' WHERE workspace_id=$workspace AND task_id=$1 AND kind IN ('model','delivery')", [task.id]);
      if (updated.state === "queued") await queue(db, taskScope, task.id, "model", task.id, {}, this.now());
      await event(db, taskScope, task.id, null, "dependent_context_invalidated", { sourceIds: [...removed], memoryIds: [...changedMemories], revision: updated.revision }, this.now());
    }
  }
  async fenceScope(db: Db, scope: Scope, reason: string): Promise<void> {
    await db.query("UPDATE workspaces SET authority_revision=authority_revision+1 WHERE id=$workspace AND id=$1", [scope.workspaceId]);
    for (const task of await records(db, "tasks", taskSchema, "scope_id=$1", [scope.id])) {
      const updated: Task = { ...task, epoch: task.epoch + 1, revision: task.revision + 1, state: liveStates.has(task.state) ? scope.active ? "queued" : "blocked" : task.state, reason: scope.active ? task.reason : reason };
      await save(db, "tasks", updated);
      await this.invalidateEffects(db, scope, updated, reason);
      if (updated.state === "queued") {
        await db.query("UPDATE jobs SET state='held' WHERE workspace_id=$workspace AND task_id=$1 AND kind='model'", [task.id]);
        await queue(db, scope, task.id, "model", task.id, {}, this.now());
      }
    }
  }
  async membership(scopeId: string, userId: string, role: "owner" | "manager" | "member" | null): Promise<void> {
    await this.scopeTransaction(scopeId, async (db, scope) => this.membershipIn(db, scope, userId, role));
  }
  async membershipIn(db: Db, scope: Scope, userId: string, role: "owner" | "manager" | "member" | null): Promise<void> {
    const owner = first(await rows(db, "SELECT owner_id FROM workspaces WHERE id=$workspace AND id=$1", [scope.workspaceId], z.object({ owner_id: z.string() })));
    if (role && owner.owner_id === userId) role = "owner";
    if (await roleFor(db, scope.id, userId) === role) return;
    if (role) await db.query("INSERT INTO memberships(workspace_id,scope_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,scope_id,user_id) DO UPDATE SET role=$4", [scope.workspaceId, scope.id, userId, role]);
    else await db.query("DELETE FROM memberships WHERE workspace_id=$workspace AND scope_id=$1 AND user_id=$2", [scope.id, userId]);
    await this.fenceScope(db, scope, "Membership changed.");
    await event(db, scope, null, userId, "membership_changed", { role }, this.now());
  }
  async ingest(update: NormalizedUpdate): Promise<Receipt> {
    const scope = await this.resolveChat(update.botId, update.chatId);
    if (!scope) return { kind: "ignored", message: "Chat is not bound." };
    return this.scopeTransaction(scope.id, async (db, currentScope) => {
      const previous = await rows(db, "SELECT receipt FROM updates WHERE workspace_id=$workspace AND bot_id=$1 AND update_id=$2", [update.botId, update.updateId], z.object({ receipt: receiptSchema }));
      if (previous[0]) return { ...previous[0].receipt, kind: "duplicate" };
      const receipt = await this.ingestIn(db, currentScope, update);
      await db.query("INSERT INTO updates(workspace_id,scope_id,bot_id,update_id,receipt) VALUES($1,$2,$3,$4,$5)", [scope.workspaceId, scope.id, update.botId, update.updateId, JSON.stringify(receipt)]);
      return receipt;
    });
  }
  async ingestIn(db: Db, scope: Scope, update: NormalizedUpdate): Promise<Receipt> {
    if (update.kind === "migration") {
      const existing = await this.connection.discover("SELECT workspace_id,scope_id FROM bindings WHERE bot_id=$1 AND chat_id=$2", [update.botId, update.newChatId], locationSchema);
      if (existing[0] && existing[0].scope_id !== scope.id) return { kind: "denied", message: "Destination chat already bound." };
      await db.query("INSERT INTO bindings(workspace_id,scope_id,bot_id,chat_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [scope.workspaceId, scope.id, update.botId, update.newChatId]);
      const migrated: Scope = { ...scope, chatId: update.newChatId };
      await db.query("UPDATE scopes SET chat_id=$2,data=$3 WHERE workspace_id=$workspace AND id=$1", [scope.id, update.newChatId, JSON.stringify(migrated)]);
      await db.query("UPDATE jobs SET data=json_set(data,'$.chatId',$2) WHERE workspace_id=$workspace AND scope_id=$1 AND kind='delivery' AND state IN ('ready','held')", [scope.id, update.newChatId]);
      await event(db, migrated, null, null, "chat_migrated", { previousChatId: update.chatId, chatId: update.newChatId }, this.now());
      return { kind: "accepted" };
    }
    if (update.kind === "membership") {
      await this.membershipIn(db, scope, update.userId, update.role);
      if (update.botRemoved) {
        const inactive: Scope = { ...scope, active: false, policyRevision: scope.policyRevision + 1 };
        await save(db, "scopes", inactive);
        await this.fenceScope(db, inactive, "Bot removed from scope.");
        for (const routine of await records(db, "routines", routineSchema, "scope_id=$1 AND data->>'state'='active'", [scope.id])) await save(db, "routines", { ...routine, state: "paused" });
      }
      return { kind: "accepted" };
    }
    if (update.kind === "callback") {
      const [action, reference, extra] = update.data.split(":");
      if (!reference || extra) return { kind: "denied", message: "Invalid callback." };
      const command: Command | null = action === "approve" || action === "deny" ? { kind: "decide", approvalId: reference, decision: action === "approve" ? "approve" : "deny" } : action === "stop" || action === "resume" || action === "cancel" ? { kind: action, taskId: reference } : null;
      if (!command) return { kind: "denied", message: "Invalid callback." };
      return this.commandIn(db, scope, { scopeId: scope.id, userId: update.userId, key: `telegram:${update.botId}:${update.updateId}`, command });
    }
    if (!scope.active || !update.userId || !await roleFor(db, scope.id, update.userId) || (scope.kind === "dm" && scope.ownerId !== update.userId)) return { kind: "ignored", message: "Collection inactive or actor unavailable." };
    if (this.now() < scope.collectedSince) return { kind: "ignored", message: "Collection has not started." };
    const referenceRows = await rows(db, "SELECT task_id,source_id FROM messages WHERE workspace_id=$workspace AND scope_id=$1 AND message_id=$2 ORDER BY (chat_id=$3) DESC LIMIT 1", [scope.id, update.messageId, update.chatId], z.object({ task_id: z.string().nullable(), source_id: z.string().nullable() }));
    const existing = referenceRows[0];
    if (update.edited) {
      if (existing?.source_id) {
        const source = (await records(db, "sources", sourceSchema, "id=$1 AND NOT deleted", [existing.source_id]))[0];
        if (!source) return { kind: "ignored", message: "Removed source remains removed." };
        if (source.text !== update.text) {
          const replacement = { ...source, text: update.text, revision: source.revision + 1 };
          await save(db, "sources", replacement);
          for (const memory of await records(db, "memories", memorySchema, "scope_id=$1", [scope.id])) if (memory.evidenceIds.includes(source.id)) await save(db, "memories", { ...memory, state: "invalidated", revision: memory.revision + 1 });
          await db.query("UPDATE workspaces SET authority_revision=authority_revision+1 WHERE id=$workspace AND id=$1", [scope.workspaceId]);
          if (existing.task_id) {
            const task = await taskRecord(db, scope.id, existing.task_id);
            await this.note(db, scope, task, `Source edit note. Previous text: ${source.text}\nEdited text: ${update.text}\nThis edit is context only. It does not change task instructions.`);
            await event(db, scope, task.id, update.userId, "source_edited", { sourceId: source.id, revision: replacement.revision, instructionChanged: false }, this.now());
          }
        }
      }
      return { kind: "ignored", message: "Edit stored as context only. Reply to steer." };
    }
    if (existing) return { kind: "duplicate", ...(existing.task_id ? { taskId: existing.task_id } : {}) };
    const source: Source = { id: uuid(), scopeId: scope.id, text: update.text, revision: 1, messageId: update.messageId, capturedAt: this.now(), kind: "message" };
    await db.query("INSERT INTO sources(workspace_id,scope_id,id,data) VALUES($1,$2,$3,$4)", [scope.workspaceId, scope.id, source.id, JSON.stringify(source)]);
    if (update.file) {
      const file: Source = { ...source, id: uuid(), text: update.file.text, kind: "text_file" };
      await db.query("INSERT INTO sources(workspace_id,scope_id,id,data) VALUES($1,$2,$3,$4)", [scope.workspaceId, scope.id, file.id, JSON.stringify(file)]);
    }
    const linked = update.replyTo === null ? null : (await rows(db, "SELECT task_id FROM messages WHERE workspace_id=$workspace AND scope_id=$1 AND message_id=$2 AND task_id IS NOT NULL ORDER BY (chat_id=$3) DESC LIMIT 1", [scope.id, update.replyTo, update.chatId], z.object({ task_id: z.string() })))[0]?.task_id ?? null;
    const match = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(update.text.trim());
    let receipt: Receipt = { kind: "ignored" };
    if (match) {
      const name = match[1];
      const argument = match[2]?.trim() ?? "";
      const reference = argument || linked;
      if (["stop", "resume", "cancel"].includes(name ?? "")) {
        if (!reference || !["stop", "resume", "cancel"].includes(name ?? "")) receipt = { kind: "denied", message: "Reply to a task or provide one task ID." };
        else if (name === "stop" || name === "resume" || name === "cancel") receipt = await this.commandIn(db, scope, { scopeId: scope.id, userId: update.userId, key: `telegram:${update.botId}:${update.updateId}`, command: { kind: name, taskId: reference } });
      } else if (name === "status") {
        const task = reference ? (await records(db, "tasks", taskSchema, "scope_id=$1 AND id=$2", [scope.id, reference]))[0] : null;
        receipt = task ? { kind: "accepted", taskId: task.id } : { kind: "denied", message: "Reply to a task or provide one task ID." };
        if (task) await notice(db, scope, task, `Current state: ${task.state.replaceAll("_", " ")}.${task.reason ? ` ${task.reason}` : ""}`, this.now());
      } else if (name === "remember" && argument) receipt = await this.commandIn(db, scope, { scopeId: scope.id, userId: update.userId, key: `telegram:${update.botId}:${update.updateId}`, command: { kind: "remember", content: argument, evidenceIds: [source.id], candidate: false } });
      else if (name === "memory" || name === "routines") {
        const items = name === "memory" ? (await records(db, "memories", memorySchema, "scope_id=$1", [scope.id])).map(memory => `${memory.id} [${memory.state} r${memory.revision}] ${memory.content}`) : (await records(db, "routines", routineSchema, "scope_id=$1", [scope.id])).map(routine => `${routine.id} [${routine.state}] ${routine.instruction}`);
        await notice(db, scope, null, items.join("\n") || `No ${name} in this scope.`, this.now());
        receipt = { kind: "accepted" };
      } else if (name === "settings" || name === "configure") {
        await notice(db, scope, null, "Open Configure to see this group's tools, access, and memory. Group managers can change connections.", this.now(), [], "settings");
        receipt = { kind: "accepted" };
      } else if (name === "help" || name === "start") { await notice(db, scope, null, "Mention me with a question or task. Reply to one of my messages to keep working together. Use /settings for tools and access. Reply with /stop, /resume, or /status to control or inspect that work.", this.now()); receipt = { kind: "accepted" }; }
      else receipt = { kind: "denied", message: "Command unavailable or missing argument." };
    } else if (linked || update.mentioned || scope.kind === "dm") {
      const command: Command = linked ? { kind: "steer", taskId: linked, text: update.text || "Use the attached text as task context." } : { kind: "start", instruction: update.text || "Inspect the attached text.", topicId: update.topicId };
      receipt = await this.commandIn(db, scope, { scopeId: scope.id, userId: update.userId, key: `telegram:${update.botId}:${update.updateId}`, command });
    }
    await db.query("INSERT INTO messages(workspace_id,scope_id,chat_id,message_id,task_id,source_id) VALUES($1,$2,$3,$4,$5,$6)", [scope.workspaceId, scope.id, update.chatId, update.messageId, receipt.taskId ?? null, source.id]);
    return receipt;
  }
  async effectAllowed(db: Db, scope: Scope, task: Task, effect: Effect): Promise<boolean> {
    if (!scope.active || !liveStates.has(task.state) || task.revision !== effect.taskRevision || scope.policyRevision !== effect.policyRevision) return false;
    if (!await this.requesterAllowed(db, scope, task)) return false;
    return this.effectResourceAllowed(db, scope, effect);
  }
  async effectResourceAllowed(db: Db, scope: Scope, effect: Effect): Promise<boolean> {
    const grants = await records(db, "grants", grantSchema, "scope_id=$1", [scope.id]);
    const grant = grantForCall(grants, effect.call);
    return !!grant && grant.revision === effect.grantRevision && grant.connectionId === effect.connectionId && grant.connectionVersion === effect.connectionVersion;
  }
  async requesterAllowed(db: Db, scope: Scope, task: Task): Promise<boolean> {
    if (task.requesterId.startsWith("routine:")) {
      const routine = (await records(db, "routines", routineSchema, "scope_id=$1 AND id=$2", [scope.id, task.requesterId.slice(8)]))[0];
      return routine?.state === "active";
    }
    return Boolean(await roleFor(db, scope.id, task.requesterId)) && (scope.kind !== "dm" || scope.ownerId === task.requesterId);
  }
  async advance(db: Db, scope: Scope, original: Task): Promise<void> {
    const task = await taskRecord(db, scope.id, original.id);
    const complete = await this.completeToolResults(db, scope, task);
    if (complete && (liveStates.has(task.state) || (task.state === "blocked" && task.reason === "External outcome unknown. Reconciliation required." && scope.active && await this.requesterAllowed(db, scope, task)))) {
      if (task.state === "blocked") {
        const admission = await this.admissionReason(db, 1);
        if (admission) {
          const blocked: Task = { ...task, reason: `${admission} Resume after capacity becomes available.` };
          await save(db, "tasks", blocked);
          await progress(db, scope, blocked, settledProgress(blocked), this.now());
          await event(db, scope, task.id, null, "recovery_admission_blocked", { reason: admission, completedEffectsRetained: true }, this.now());
          await notice(db, scope, blocked, `I can’t continue yet. ${blocked.reason}`, this.now());
          return;
        }
      }
      const updated: Task = { ...task, state: "queued", reason: null };
      await save(db, "tasks", updated);
      await queue(db, scope, task.id, "model", task.id, {}, this.now());
    } else if (task.state === "stopping") {
      const unresolved = await records(db, "effects", effectSchema, "task_id=$1 AND data->>'state' IN ('dispatching','unknown')", [task.id]);
      const model = await rows(db, "SELECT id FROM jobs WHERE workspace_id=$workspace AND task_id=$1 AND kind='model' AND state='leased' AND expires_at>$2", [task.id, this.now()], z.object({ id: z.string() }));
      if (!unresolved.length && !model.length) { const paused: Task = { ...task, state: "paused", reason: null }; await save(db, "tasks", paused); await event(db, scope, task.id, null, "stop_settled", {}, this.now()); await notice(db, scope, paused, "I’ve stopped. Completed actions are retained.", this.now()); }
    }
  }
  async materializeRoutines(): Promise<void> {
    const result = await this.connection.discover("SELECT workspace_id,scope_id,id FROM routines WHERE ($2 IS NULL OR workspace_id IN (SELECT value FROM json_each($2))) AND data->>'state'='active' AND data->>'nextAt'<=$1 LIMIT 20", [this.now(), this.options.workspaceIds ?? null], locationSchema.extend({ id: z.string() }));
    for (const location of result) {
      await this.scopeTransaction(location.scope_id, async (db, scope) => {
        const routine = (await records(db, "routines", routineSchema, "id=$1", [location.id]))[0];
        if (!routine || routine.state !== "active" || routine.nextAt > this.now()) return;
        if (!scope.active) { await save(db, "routines", { ...routine, state: "paused" }); return; }
        const walk = walkWallClockOccurrence(routine, this.now());
        if (walk.truncated) {
          await save(db, "routines", { ...routine, nextAt: walk.nextAt });
          await event(db, scope, null, null, "routine_backlog_skipped", { routineId: routine.id, resumedAt: walk.nextAt }, this.now());
          return;
        }
        const occurrence = walk.occurrence;
        const existing = await rows(db, "SELECT task_id FROM occurrences WHERE workspace_id=$workspace AND routine_id=$1 AND at=$2", [routine.id, occurrence], z.object({ task_id: z.string() }));
        if (!existing.length) {
          const admission = await this.admissionReason(db, 2);
          if (admission) await event(db, scope, null, null, "routine_capacity_skipped", { routineId: routine.id, occurrence, reason: admission }, this.now());
          else {
            const task = await this.createTask(db, scope, `routine:${routine.id}`, routine.instruction, null, routine.budgetMicros);
            await db.query("INSERT INTO occurrences(workspace_id,scope_id,routine_id,at,task_id) VALUES($1,$2,$3,$4,$5)", [scope.workspaceId, scope.id, routine.id, occurrence, task.id]);
            await event(db, scope, task.id, null, "routine_occurrence", { routineId: routine.id, occurrence, basis: "wall_clock" }, this.now());
          }
        }
        await save(db, "routines", { ...routine, nextAt: walk.nextAt });
      });
    }
  }
  async modelContext(db: Db, scope: Scope, task: Task): Promise<ModelInput> {
    const scopes = await records(db, "scopes", scopeSchema, "workspace_id=$1", [scope.workspaceId]);
    const memoryScopes = scopes.filter(candidate => candidate.active && (candidate.id === scope.id || (candidate.workspacePublic && candidate.kind !== "dm"))).map(candidate => candidate.id);
    const ownSources = await records(db, "sources", sourceSchema, `scope_id=$1 AND NOT deleted AND id IN (
      SELECT s.id FROM sources s WHERE s.workspace_id=$workspace AND s.scope_id=$1 AND NOT s.deleted
      ORDER BY
        (s.id=COALESCE((SELECT m.source_id FROM messages m JOIN sources initial ON initial.id=m.source_id AND initial.workspace_id=m.workspace_id
          WHERE m.workspace_id=$workspace AND m.scope_id=$1 AND m.task_id=$2 AND NOT initial.deleted
          ORDER BY initial.data->>'capturedAt',m.message_id,m.source_id LIMIT 1),'')) DESC,
        (COALESCE(s.task_id=$2,false) OR EXISTS(
          SELECT 1 FROM messages m JOIN sources linked ON linked.id=m.source_id AND linked.workspace_id=m.workspace_id
          WHERE m.workspace_id=$workspace AND m.scope_id=$1 AND m.task_id=$2 AND (
            m.source_id=s.id OR (s.data->>'kind'='text_file' AND s.data->>'messageId'=linked.data->>'messageId' AND s.data->>'capturedAt'=linked.data->>'capturedAt')
          )
        )) DESC,
        s.data->>'capturedAt' DESC,s.id DESC LIMIT $3
      ) ORDER BY data->>'capturedAt',id`, [scope.id, task.id, scopeSourceWindowLimit]);
    const memoryCandidates = await records(db, "memories", memorySchema, "scope_id IN (SELECT value FROM json_each($1)) AND data->>'state'='active'", [memoryScopes]);
    const evidenceIds = [...new Set(memoryCandidates.flatMap(memory => memory.evidenceIds))];
    const evidence = await records(db, "sources", sourceSchema, "scope_id IN (SELECT value FROM json_each($1)) AND id IN (SELECT value FROM json_each($2)) AND NOT deleted", [memoryScopes, evidenceIds]);
    const memories = memoryCandidates.filter(memory => memory.evidenceIds.every(id => evidence.some(source => source.id === id && source.scopeId === memory.scopeId)));
    const memoryEvidenceIds = new Set(memories.flatMap(memory => memory.evidenceIds));
    const selectedSourceIds = new Set(ownSources.map(source => source.id));
    const sources = [...ownSources, ...evidence.filter(source => !selectedSourceIds.has(source.id) && memoryEvidenceIds.has(source.id)).map(source => ({ ...source, text: source.scopeId === scope.id ? "Evidence reference for an active curated fact. Original source content is outside the selected source window." : "Evidence reference for an explicitly shared curated fact. Original source content remains restricted to its source scope." }))];
    const grants = await records(db, "grants", grantSchema, "scope_id=$1 AND data->>'active'=1", [scope.id]);
    const tools: ToolName[] = [];
    if (grants.some(grant => grant.kind !== "notion_scope" && grant.read)) tools.push("github_read_issues");
    if (grants.some(grant => grant.kind !== "notion_scope" && grant.write)) tools.push("github_create_issue");
    if (grants.some(grant => grant.kind === "notion_scope" && grant.read)) tools.push("notion_search", "notion_read_page");
    return { task, history: await history(db, task.id), sources, memories, collectedSince: scope.collectedSince, tools, maxOutputTokens: this.options.maxOutputTokens };
  }
  async claim(workerId: string, kind?: Job["kind"]): Promise<Job | null> {
    if (kind !== "delivery") await this.materializeRoutines();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const token = uuid();
      const job = await inDatabaseTransaction(this.connection, async (): Promise<Job | null | undefined> => {
        const candidates = await this.connection.discover("SELECT workspace_id,scope_id,id FROM jobs WHERE ($2 IS NULL OR workspace_id IN (SELECT value FROM json_each($2))) AND ($3 IS NULL OR kind=$3) AND ((state='ready' AND ready_at<=$1) OR (state='leased' AND expires_at<=$1)) ORDER BY CASE kind WHEN 'effect' THEN 0 WHEN 'delivery' THEN 1 ELSE 2 END,ready_at LIMIT 1", [this.now(), this.options.workspaceIds ?? null, kind ?? null], locationSchema.extend({ id: z.string() }));
        const location = candidates[0];
        if (!location) return undefined;
        const db = this.connection.context(location.workspace_id);
        const scope = first(await records(db, "scopes", scopeSchema, "id=$1", [location.scope_id]));
        await db.query("UPDATE jobs SET state='leased',token=$2,worker_id=$3,expires_at=$4,attempts=attempts+1 WHERE workspace_id=$workspace AND id=$1", [location.id, token, workerId, this.now() + this.options.leaseMs]);
        const row = first(await rows(db, "SELECT * FROM jobs WHERE workspace_id=$workspace AND id=$1", [location.id], jobRowSchema));
        if (row.token !== token || row.state !== "leased") return null;
        const lease = { id: row.id, token, workerId, expiresAt: row.expires_at ?? this.now() + this.options.leaseMs };
        const task = row.task_id ? await taskRecord(db, scope.id, row.task_id) : null;
        if (row.kind === "delivery") {
          const delivery = deliverySchema.parse(row.data);
          if (!scope.active || (task && !await this.requesterAllowed(db, scope, task))) { await db.query("UPDATE jobs SET state='held' WHERE workspace_id=$workspace AND id=$1", [row.id]); await event(db, scope, task?.id ?? null, null, "delivery_held", { reason: "Current destination or requester access unavailable." }, this.now()); return null; }
          if (delivery.purpose === "progress" && task && task.state !== "queued" && task.state !== "running") {
            if (delivery.messageId === null) { await db.query("UPDATE jobs SET state='done' WHERE workspace_id=$workspace AND id=$1", [row.id]); return null; }
            delivery.buttons = []; delivery.text = settledProgress(task);
          }
          const incoming = task ? (await rows(db, "SELECT message_id FROM messages WHERE workspace_id=$workspace AND scope_id=$1 AND chat_id=$2 AND task_id=$3 AND source_id IS NOT NULL ORDER BY message_id DESC LIMIT 1", [scope.id, scope.chatId, task.id], z.object({ message_id: z.number().int() })))[0] : undefined;
          return { kind: "delivery", lease, delivery: { ...delivery, chatId: scope.chatId, ...(delivery.replyTo === undefined && incoming ? { replyTo: incoming.message_id } : {}) } };
        }
        if (!task) throw new Error("Job task unavailable");
        if (row.kind === "effect") {
          let effect = first(await records(db, "effects", effectSchema, "id=$1", [row.entity_id]));
          if (effect.state === "dispatching" || effect.state === "unknown") {
            effect = { ...effect, state: "unknown", reason: "External outcome is unknown; reconcile before retry." };
            await save(db, "effects", effect);
            return { kind: "effect", lease, effect, reconcile: true };
          }
          let allowed = effect.state === "ready" && await this.effectAllowed(db, scope, task, effect);
          if (allowed && effect.call.name === "github_create_issue") {
            const approval = (await records(db, "approvals", approvalSchema, "effect_id=$1", [effect.id]))[0];
            allowed = Boolean(approval && approval.state === "approved" && approval.expiresAt > this.now() && approval.hash === effect.hash && approval.decidedBy && manager(await roleFor(db, scope.id, approval.decidedBy)) && digest(effect.call) === effect.hash);
          }
          if (!allowed) { await save(db, "effects", { ...effect, state: effect.state === "succeeded" ? "succeeded" : "denied", result: effect.result ?? "Current authorization denies dispatch.", reason: "Current authorization denies dispatch." }); await db.query("UPDATE jobs SET state='done' WHERE workspace_id=$workspace AND id=$1", [row.id]); await this.advance(db, scope, task); return null; }
          const dispatched: Effect = { ...effect, state: "dispatching", reason: null };
          await save(db, "effects", dispatched);
          await db.query("INSERT INTO dispatches(workspace_id,scope_id,task_id,effect_id,token) VALUES($1,$2,$3,$4,$5)", [scope.workspaceId, scope.id, task.id, effect.id, token]);
          await event(db, scope, task.id, null, "effect_dispatched", { effectId: effect.id, hash: effect.hash }, this.now());
          return { kind: "effect", lease, effect: dispatched, reconcile: false };
        }
        await this.expireReservations(db, scope, task, token);
        const activeModels = first(await rows(db, "SELECT count(*) AS count FROM jobs WHERE workspace_id=$workspace AND scope_id=$1 AND kind='model' AND state='leased' AND expires_at>$2", [scope.id, this.now()], z.object({ count: z.coerce.number().int() }))).count;
        if (activeModels > modelLeaseLimitPerScope) { await db.query("UPDATE jobs SET state='ready',ready_at=$2,token=NULL,worker_id=NULL,expires_at=NULL WHERE workspace_id=$workspace AND id=$1 AND token=$3", [row.id, this.now() + deferredClaimMs, token]); return null; }
        if (!scope.active || !liveStates.has(task.state) || !await this.requesterAllowed(db, scope, task)) { await db.query("UPDATE jobs SET state='held' WHERE workspace_id=$workspace AND id=$1", [row.id]); if (liveStates.has(task.state)) await save(db, "tasks", { ...task, state: "blocked", reason: "Current scope or requester access unavailable." }); await this.advance(db, scope, task); return null; }
        if (!await this.completeToolResults(db, scope, task)) { await db.query("UPDATE jobs SET state='held' WHERE workspace_id=$workspace AND id=$1", [row.id]); const effects = await records(db, "effects", effectSchema, "task_id=$1 AND data->>'state'='unknown'", [task.id]); if (effects.length) await save(db, "tasks", { ...task, state: "blocked", reason: "External outcome unknown. Reconciliation required." }); return null; }
        await this.flushNotes(db, task);
        const workspace = first(await rows(db, "SELECT budget,held,spent,authority_revision FROM workspaces WHERE id=$workspace AND id=$1", [scope.workspaceId], workspaceRowSchema));
        const scopeTotals = first(await rows(db, "SELECT held,spent FROM scopes WHERE workspace_id=$workspace AND id=$1", [scope.id], totalsSchema));
        const taskTotals = first(await rows(db, "SELECT held,spent FROM tasks WHERE workspace_id=$workspace AND id=$1", [task.id], totalsSchema));
        const amount = this.options.modelReserveMicros;
        if (task.turns >= task.maxTurns || workspace.held + workspace.spent + amount > workspace.budget || scopeTotals.held + scopeTotals.spent + amount > scope.budgetMicros || taskTotals.held + taskTotals.spent + amount > task.budgetMicros) {
          const blocked: Task = { ...task, state: "blocked", reason: task.turns >= task.maxTurns ? "Task turn limit reached." : "Budget reservation unavailable." };
          await save(db, "tasks", blocked);
          await progress(db, scope, blocked, settledProgress(blocked), this.now());
          await db.query("UPDATE jobs SET state='held' WHERE workspace_id=$workspace AND id=$1", [row.id]);
          await event(db, scope, task.id, null, "budget_blocked", { reserveMicros: amount, turnLimit: task.maxTurns }, this.now());
          await notice(db, scope, blocked, `I can’t continue yet. ${blocked.reason}`, this.now());
          return null;
        }
        const running: Task = { ...task, state: "running", turns: task.turns + 1, reason: null };
        await save(db, "tasks", running);
        const input = await this.modelContext(db, scope, running);
        await db.query("INSERT INTO reservations(workspace_id,scope_id,task_id,token,amount,epoch,authority_revision,sources,memories) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [scope.workspaceId, scope.id, task.id, token, amount, task.epoch, workspace.authority_revision, JSON.stringify(input.sources.map(source => ({ id: source.id, revision: source.revision }))), JSON.stringify(input.memories.map(memory => ({ id: memory.id, revision: memory.revision })))]);
        await db.query("UPDATE workspaces SET held=held+$2 WHERE id=$workspace AND id=$1", [scope.workspaceId, amount]);
        await db.query("UPDATE scopes SET held=held+$2 WHERE workspace_id=$workspace AND id=$1", [scope.id, amount]);
        await db.query("UPDATE tasks SET held=held+$2 WHERE workspace_id=$workspace AND id=$1", [task.id, amount]);
        await event(db, scope, task.id, null, "model_dispatched", { epoch: task.epoch, reserveMicros: amount, sourceIds: input.sources.map(source => source.id) }, this.now());
        return { kind: "model", lease, input };
      });
      if (job === undefined) return null;
      if (job) return job;
    }
    return null;
  }
  async expireReservations(db: Db, scope: Scope, task: Task, newToken: string): Promise<void> {
    const reservations = await rows(db, "SELECT * FROM reservations WHERE workspace_id=$workspace AND task_id=$1 AND token<>$2 AND NOT settled AND NOT expired", [task.id, newToken], reservationSchema);
    for (const reservation of reservations) {
      await this.estimateReservation(db, scope, task, reservation.token);
    }
  }
  async estimateReservation(db: Db, scope: Scope, task: Task, token: string): Promise<void> {
    const reservation = (await rows(db, "SELECT * FROM reservations WHERE workspace_id=$workspace AND token=$1 AND task_id=$2 AND NOT settled AND NOT expired", [token, task.id], reservationSchema))[0];
    if (!reservation) return;
    await db.query("UPDATE reservations SET charged=amount,expired=true WHERE workspace_id=$workspace AND token=$1", [token]);
    await db.query("UPDATE workspaces SET held=held-$2,spent=spent+$2 WHERE id=$workspace AND id=$1", [scope.workspaceId, reservation.amount]);
    await db.query("UPDATE scopes SET held=held-$2,spent=spent+$2 WHERE workspace_id=$workspace AND id=$1", [scope.id, reservation.amount]);
    await db.query("UPDATE tasks SET held=held-$2,spent=spent+$2 WHERE workspace_id=$workspace AND id=$1", [task.id, reservation.amount]);
    await event(db, scope, task.id, null, "usage_estimated_after_lost_lease", { reservedMicros: reservation.amount, simulated: this.options.simulated }, this.now());
  }
  async settleReservation(db: Db, scope: Scope, task: Task, token: string, cost: number): Promise<z.infer<typeof reservationSchema> | null> {
    const reservation = (await rows(db, "SELECT * FROM reservations WHERE workspace_id=$workspace AND token=$1 AND task_id=$2", [token, task.id], reservationSchema))[0];
    if (!reservation || reservation.settled) return null;
    const released = reservation.expired ? 0 : reservation.amount;
    const delta = cost - reservation.charged;
    await db.query("UPDATE reservations SET settled=true,charged=$2 WHERE workspace_id=$workspace AND token=$1", [token, cost]);
    await db.query("UPDATE workspaces SET held=held-$2,spent=spent+$3 WHERE id=$workspace AND id=$1", [scope.workspaceId, released, delta]);
    await db.query("UPDATE scopes SET held=held-$2,spent=spent+$3 WHERE workspace_id=$workspace AND id=$1", [scope.id, released, delta]);
    await db.query("UPDATE tasks SET held=held-$2,spent=spent+$3 WHERE workspace_id=$workspace AND id=$1", [task.id, released, delta]);
    return reservation;
  }
  async finishModel(job: Extract<Job, { kind: "model" }>, rawResult: Turn): Promise<void> {
    const result = turnSchema.parse(rawResult);
    await this.scopeTransaction(job.input.task.scopeId, async (db, scope) => {
      const task = await taskRecord(db, scope.id, job.input.task.id);
      const reservation = await this.settleReservation(db, scope, task, job.lease.token, result.usage.costMicros);
      if (!reservation) return;
      await event(db, scope, task.id, null, "usage_reconciled", { ...result.usage, requestId: digest(result.requestId) }, this.now());
      const row = (await rows(db, "SELECT * FROM jobs WHERE workspace_id=$workspace AND id=$1", [job.lease.id], jobRowSchema))[0];
      const workspace = first(await rows(db, "SELECT budget,held,spent,authority_revision FROM workspaces WHERE id=$workspace AND id=$1", [scope.workspaceId], workspaceRowSchema));
      const authorized = scope.active && await this.requesterAllowed(db, scope, task);
      const valid = row?.state === "leased" && row.token === job.lease.token && (row.expires_at ?? 0) >= this.now() && task.epoch === reservation.epoch && workspace.authority_revision === reservation.authority_revision && liveStates.has(task.state) && authorized;
      await db.query("UPDATE jobs SET state='done' WHERE workspace_id=$workspace AND id=$1 AND token=$2", [job.lease.id, job.lease.token]);
      if (!valid) {
        await event(db, scope, task.id, null, "model_result_fenced", { epoch: reservation.epoch, currentEpoch: task.epoch }, this.now());
        if (row?.token === job.lease.token && liveStates.has(task.state) && authorized) { const queued: Task = { ...task, state: "queued" }; await save(db, "tasks", queued); await queue(db, scope, task.id, "model", task.id, {}, this.now()); }
        await this.advance(db, scope, task);
        return;
      }
      const toolIds = result.message.content.filter(block => block.type === "tool_use").map(block => block.id);
      if (result.message.role !== "assistant" || toolIds.length !== new Set(toolIds).size) { await this.blockModel(db, scope, task, "Provider returned an invalid assistant message or repeated tool identifier."); return; }
      const sequence = await append(db, task, result.message);
      const progressed: Task = { ...task };
      await save(db, "tasks", progressed);
      if (result.outcome === "tools") {
        const uses = result.message.content.filter(block => block.type === "tool_use");
        if (!uses.length) { await this.blockModel(db, scope, progressed, "Provider returned tools without a tool call."); return; }
        const pendingJobs = first(await rows(db, "SELECT count(*) AS count FROM jobs WHERE workspace_id=$workspace AND state IN ('ready','leased')", [], z.object({ count: z.coerce.number().int() }))).count;
        if (pendingJobs + uses.length > pendingJobLimitPerWorkspace) {
          await append(db, task, { role: "user", content: uses.map(use => ({ type: "tool_result", tool_use_id: use.id, content: "Workspace queue capacity prevented preparing this tool.", is_error: true })) });
          const blocked: Task = { ...progressed, state: "blocked", reason: "Workspace pending-job limit reached. Resume after capacity becomes available." };
          await save(db, "tasks", blocked);
          await progress(db, scope, blocked, settledProgress(blocked), this.now());
          await event(db, scope, task.id, null, "queue_capacity_blocked", { kind: "effect", limit: pendingJobLimitPerWorkspace }, this.now());
          await notice(db, scope, blocked, `I can’t continue yet. ${blocked.reason}`, this.now());
          return;
        }
        const invalid: Transcript["content"] = [];
        for (const use of uses) {
          const callResult = toolCallSchema.safeParse({ id: use.id, name: use.name, input: use.input });
          if (!callResult.success) { invalid.push({ type: "tool_result", tool_use_id: use.id, content: "Tool or input is unsupported.", is_error: true }); continue; }
          const call = callResult.data;
          const duplicate = await records(db, "effects", effectSchema, "task_id=$1 AND call_id=$2", [task.id, call.id]);
          if (duplicate.length) { invalid.push({ type: "tool_result", tool_use_id: use.id, content: "Tool call identifier was already used. Propose a fresh call.", is_error: true }); continue; }
          const grant = grantForCall(await records(db, "grants", grantSchema, "scope_id=$1", [scope.id]), call);
          const effect: Effect = { id: uuid(), workspaceId: scope.workspaceId, taskId: task.id, scopeId: scope.id, call, state: !grant ? "denied" : call.name === "github_create_issue" ? "waiting_for_approval" : "ready", taskRevision: task.revision, policyRevision: scope.policyRevision, grantRevision: grant?.revision ?? 0, ...(grant?.connectionId ? { connectionId: grant.connectionId, connectionVersion: grant.connectionVersion } : {}), hash: digest(call), result: grant ? null : "No active resource grant permits this tool.", providerId: null, url: null, reason: grant ? null : "No active resource grant permits this tool." };
          await db.query("INSERT INTO effects(workspace_id,scope_id,task_id,id,call_id,sequence,data) VALUES($1,$2,$3,$4,$5,$6,$7)", [scope.workspaceId, scope.id, task.id, effect.id, call.id, sequence, JSON.stringify(effect)]);
          await event(db, scope, task.id, null, "effect_prepared", { effectId: effect.id, hash: effect.hash, resource: "repository" in call.input ? call.input.repository : "pageId" in call.input ? call.input.pageId : "Notion selected pages", operation: call.name, taskRevision: task.revision, policyRevision: scope.policyRevision, grantRevision: effect.grantRevision }, this.now());
          if (effect.state === "ready") await queue(db, scope, task.id, "effect", effect.id, {}, this.now());
          if (effect.state === "waiting_for_approval" && call.name === "github_create_issue") {
            const approval: Approval = { id: uuid(), taskId: task.id, effectId: effect.id, hash: effect.hash, expiresAt: this.now() + 900_000, state: "pending", decidedBy: null };
            await db.query("INSERT INTO approvals(workspace_id,scope_id,task_id,effect_id,id,data) VALUES($1,$2,$3,$4,$5,$6)", [scope.workspaceId, scope.id, task.id, effect.id, approval.id, JSON.stringify(approval)]);
            await notice(db, scope, task, `Approval required for GitHub issue in ${call.input.repository}.\nTitle: ${call.input.title}\nBody:\n${call.input.body}\nLabels: ${call.input.labels.join(", ") || "none"}\nDestination: ${scope.chatId}\nTask revision: ${task.revision}\nAction hash: ${effect.hash}\nExpires in 15 minutes. Current managers may approve this exact action.`, this.now(), [{ text: "Approve", data: `approve:${approval.id}` }, { text: "Deny", data: `deny:${approval.id}` }]);
          }
        }
        if (invalid.length) await append(db, task, { role: "user", content: invalid });
        const effects = await records(db, "effects", effectSchema, "task_id=$1 AND sequence=$2", [task.id, sequence]);
        const persisted = await taskRecord(db, scope.id, task.id);
        if (persisted.state !== "blocked") {
          const working: Task = { ...progressed, state: effects.some(effect => effect.state === "waiting_for_approval") ? "waiting_for_approval" : "running" };
          await save(db, "tasks", working);
          const call = effects.find(effect => effect.state === "ready")?.call;
          const stage = call?.name === "github_read_issues" ? `I'm reading the issues in ${call.input.repository}.` : call?.name === "notion_search" ? "I'm searching the connected Notion pages." : call?.name === "notion_read_page" ? "I'm reading the selected Notion page." : "I'm checking the tool results.";
          await progress(db, scope, working, working.state === "running" ? stage : settledProgress(working), this.now());
        }
        await this.advance(db, scope, progressed);
        return;
      }
      const partialUses = result.message.content.filter(block => block.type === "tool_use");
      if (partialUses.length) await append(db, task, { role: "user", content: partialUses.map(use => ({ type: "tool_result", tool_use_id: use.id, content: "Partial model output did not authorize dispatch.", is_error: true })) });
      const text = result.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      const permittedIds = new Set(job.input.sources.map(source => source.id));
      const cited = result.sourceIds.filter(id => permittedIds.has(id));
      const invalidCitations = result.sourceIds.length !== cited.length;
      const limitations = [...result.limitations, ...(invalidCitations ? ["The provider cited unavailable evidence. Those citations were removed."] : [])];
      const completed: Task = { ...progressed, state: result.outcome === "complete" ? "completed" : result.outcome === "needs_input" ? "waiting_for_input" : "failed", result: { text, sourceIds: cited, limitations }, reason: result.outcome === "incomplete" ? "Provider output incomplete. Resume after checking the limit or refusal." : null };
      await save(db, "tasks", completed);
      await event(db, scope, task.id, null, "model_turn_committed", { outcome: result.outcome, sourceIds: cited, turns: completed.turns }, this.now());
      await progress(db, scope, completed, settledProgress(completed), this.now());
      await notice(db, scope, completed, conversationAnswer(text, limitations, scope.collectedSince), this.now(), [], undefined, "markdown");
    });
  }
  async blockModel(db: Db, scope: Scope, task: Task, reason: string): Promise<void> {
    const failed: Task = { ...task, state: "failed", reason };
    await save(db, "tasks", failed);
    await progress(db, scope, failed, settledProgress(failed), this.now());
    await event(db, scope, task.id, null, "model_output_invalid", { reason }, this.now());
    await notice(db, scope, task, `I couldn’t finish this. ${reason}`, this.now());
  }
  async effectJobValid(db: Db, job: Extract<Job, { kind: "effect" }>): Promise<boolean> {
    const dispatched = await rows(db, "SELECT effect_id FROM dispatches WHERE workspace_id=$workspace AND token=$1 AND effect_id=$2", [job.lease.token, job.effect.id], z.object({ effect_id: z.string() }));
    if (dispatched.length) return true;
    const row = (await rows(db, "SELECT * FROM jobs WHERE workspace_id=$workspace AND id=$1", [job.lease.id], jobRowSchema))[0];
    return job.reconcile && row?.token === job.lease.token && row.entity_id === job.effect.id;
  }
  async finishEffect(job: Extract<Job, { kind: "effect" }>, receipt: ConnectorReceipt): Promise<void> {
    await this.scopeTransaction(job.effect.scopeId, async (db, scope) => {
      if (!await this.effectJobValid(db, job)) return;
      const effect = first(await records(db, "effects", effectSchema, "id=$1", [job.effect.id]));
      if (effect.state === "succeeded") return;
      const task = await taskRecord(db, scope.id, effect.taskId);
      const deniedRead = effect.call.name !== "github_create_issue" && (!scope.active || scope.policyRevision !== effect.policyRevision || !await this.requesterAllowed(db, scope, task) || !await this.effectResourceAllowed(db, scope, effect));
      const redacted = deniedRead || first(await rows(db, "SELECT redacted FROM effects WHERE workspace_id=$workspace AND id=$1", [effect.id], z.object({ redacted: z.boolean() }))).redacted;
      if (redacted) await db.query("UPDATE effects SET redacted=true WHERE workspace_id=$workspace AND id=$1", [effect.id]);
      const content = redacted ? "Effect receipt excluded after evidence or authorization changed." : receipt.content;
      const succeeded: Effect = { ...effect, state: "succeeded", providerId: deniedRead ? null : receipt.providerId, url: deniedRead ? null : receipt.url, result: content, reason: null };
      await save(db, "effects", succeeded);
      const source: Source = { id: uuid(), scopeId: scope.id, text: content, revision: 1, capturedAt: this.now(), messageId: null, kind: "tool" };
      await db.query("INSERT INTO sources(workspace_id,scope_id,task_id,id,data,deleted) VALUES($1,$2,$3,$4,$5,$6)", [scope.workspaceId, scope.id, task.id, source.id, JSON.stringify(source), redacted]);
      await db.query("UPDATE jobs SET state='done' WHERE workspace_id=$workspace AND kind='effect' AND entity_id=$1", [effect.id]);
      await event(db, scope, task.id, null, "effect_succeeded", { effectId: effect.id, providerId: succeeded.providerId, url: succeeded.url, sourceId: source.id, redacted, late: task.revision !== effect.taskRevision }, this.now());
      await this.advance(db, scope, task);
      if (["paused", "stopping", "canceled"].includes(task.state)) await notice(db, scope, task, `The action completed before stopping and is retained.${succeeded.url ? ` ${succeeded.url}` : ""}`, this.now());
    });
  }
  async unknownEffect(job: Extract<Job, { kind: "effect" }>, _reason: string): Promise<void> {
    await this.scopeTransaction(job.effect.scopeId, async (db, scope) => {
      if (!await this.effectJobValid(db, job)) return;
      const effect = first(await records(db, "effects", effectSchema, "id=$1", [job.effect.id]));
      if (effect.state === "succeeded") return;
      const task = await taskRecord(db, scope.id, effect.taskId);
      await save(db, "effects", { ...effect, state: "unknown", reason: "External outcome is unknown; reconcile before retry." });
      if (liveStates.has(task.state)) {
        const blocked: Task = { ...task, state: "blocked", reason: "External outcome unknown. Reconciliation required." };
        await save(db, "tasks", blocked);
        await progress(db, scope, blocked, settledProgress(blocked), this.now());
        await notice(db, scope, blocked, "I couldn't confirm the external action's outcome. I'll check it before any retry; I won't repeat the action blindly.", this.now());
      }
      const row = (await rows(db, "SELECT * FROM jobs WHERE workspace_id=$workspace AND id=$1", [job.lease.id], jobRowSchema))[0];
      if (row?.token === job.lease.token) await db.query("UPDATE jobs SET state=$3,ready_at=$4 WHERE workspace_id=$workspace AND id=$1 AND token=$2", [job.lease.id, job.lease.token, (row.attempts < 4) ? "ready" : "held", this.now() + Math.min(60_000, 1000 * 2 ** row.attempts)]);
      await event(db, scope, task.id, null, "effect_unknown", { effectId: effect.id, dispatchBlocked: true }, this.now());
    });
  }
  async absentEffect(job: Extract<Job, { kind: "effect" }>, proof: string): Promise<void> {
    if (!job.reconcile || !proof.trim()) throw new Error("Absence requires authoritative reconciliation proof");
    await this.scopeTransaction(job.effect.scopeId, async (db, scope) => {
      if (!await this.effectJobValid(db, job)) return;
      const effect = first(await records(db, "effects", effectSchema, "id=$1", [job.effect.id]));
      if (effect.state !== "unknown") return;
      const task = await taskRecord(db, scope.id, effect.taskId);
      const allowed = await this.effectAllowed(db, scope, task, effect);
      await save(db, "effects", { ...effect, state: allowed ? "ready" : "denied", result: allowed ? null : "Reconciliation proved no effect. Current authority prevents retry.", reason: allowed ? null : "Current authority prevents retry." });
      await db.query("UPDATE jobs SET state=$2,ready_at=$3 WHERE workspace_id=$workspace AND id=$1 AND token=$4", [job.lease.id, allowed ? "ready" : "done", this.now(), job.lease.token]);
      await event(db, scope, task.id, null, "effect_absence_proven", { effectId: effect.id, proofHash: digest(proof), retryAllowed: allowed }, this.now());
      if (!allowed) await this.advance(db, scope, task);
    });
  }
  async finishDelivery(job: Extract<Job, { kind: "delivery" }>, messageId: number): Promise<void> {
    if (!Number.isSafeInteger(messageId)) throw new Error("Invalid delivery message ID");
    await this.scopeTransaction(job.delivery.scopeId, async (db, scope) => {
      const row = (await rows(db, "SELECT * FROM jobs WHERE workspace_id=$workspace AND id=$1", [job.lease.id], jobRowSchema))[0];
      if (!row || row.token !== job.lease.token || row.state !== "leased") return;
      await db.query("UPDATE jobs SET state='done',data=$3 WHERE workspace_id=$workspace AND id=$1 AND token=$2", [job.lease.id, job.lease.token, JSON.stringify({ ...job.delivery, messageId })]);
      await db.query("INSERT INTO messages(workspace_id,scope_id,chat_id,message_id,task_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,scope_id,chat_id,message_id) DO UPDATE SET task_id=$5", [scope.workspaceId, scope.id, job.delivery.chatId, messageId, job.delivery.taskId]);
      await event(db, scope, job.delivery.taskId, null, "delivery_succeeded", { deliveryId: job.delivery.id, messageId }, this.now());
      if (job.delivery.purpose === "progress" && job.delivery.taskId) {
        const task = await taskRecord(db, scope.id, job.delivery.taskId);
        if (task.state !== "queued" && task.state !== "running" && job.delivery.buttons.length) await progress(db, scope, task, settledProgress(task), this.now());
      }
    });
  }
  async fail(job: Job, _reason: string): Promise<void> {
    if (job.kind === "effect") { await this.unknownEffect(job, "External outcome unknown."); return; }
    const scopeId = job.kind === "model" ? job.input.task.scopeId : job.delivery.scopeId;
    await this.scopeTransaction(scopeId, async (db, scope) => {
      const row = (await rows(db, "SELECT * FROM jobs WHERE workspace_id=$workspace AND id=$1", [job.lease.id], jobRowSchema))[0];
      if (job.kind === "delivery") {
        if (row?.token !== job.lease.token || row.state !== "leased") return;
        await db.query("UPDATE jobs SET state=$3,ready_at=$4 WHERE workspace_id=$workspace AND id=$1 AND token=$2", [row.id, job.lease.token, row.attempts < 5 ? "ready" : "held", this.now() + Math.min(60_000, 1000 * 2 ** row.attempts)]);
        await event(db, scope, job.delivery.taskId, null, row.attempts < 5 ? "delivery_retry_scheduled" : "delivery_failed", { deliveryId: job.delivery.id, attempts: row.attempts, reason: "Delivery failed; action and task remain recorded." }, this.now());
        return;
      }
      const task = await taskRecord(db, scope.id, job.input.task.id);
      await this.estimateReservation(db, scope, task, job.lease.token);
      if (row?.token !== job.lease.token) return;
      await db.query("UPDATE jobs SET state='done' WHERE workspace_id=$workspace AND id=$1 AND token=$2", [row.id, job.lease.token]);
      if (task.epoch !== job.input.task.epoch || task.state === "stopping" || task.state === "canceled") { await this.advance(db, scope, task); return; }
      const failed: Task = { ...task, state: "failed", reason: "Model call failed. Usage is conservatively estimated until a receipt arrives." };
      await save(db, "tasks", failed);
      await progress(db, scope, failed, settledProgress(failed), this.now());
      await event(db, scope, task.id, null, "model_failed", { reason: failed.reason, estimatedMicros: this.options.modelReserveMicros }, this.now());
      await notice(db, scope, failed, "I couldn’t finish because the model call failed. Check the provider configuration, then reply with /resume to try again.", this.now());
    });
  }
  async close(): Promise<void> {
    try { await inDatabaseTransaction(this.connection, async () => undefined); }
    finally { this.connection.close(); }
  }
}

export async function openStore(options: StoreOptions): Promise<Store> {
  z.object({ databasePath: z.string().min(1), modelReserveMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), maxOutputTokens: z.number().int().positive(), maxTurns: z.number().int().positive(), taskBudgetMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), leaseMs: z.number().int().min(100).max(3_600_000), simulated: z.boolean() }).parse(options);
  const store = new SQLiteStore(options);
  try { await inDatabaseTransaction(store.connection, async () => undefined); return store; }
  catch (error) { store.connection.close(); throw error; }
}
