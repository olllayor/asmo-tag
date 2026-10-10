import { z } from 'zod';

export const id = z.string().min(1).max(128);
export const micros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const roleSchema = z.enum(['owner', 'manager', 'member']);
export const scopeSchema = z.object({
  id,
  workspaceId: id,
  kind: z.enum(['group', 'dm', 'workspace']),
  chatId: z.string(),
  ownerId: z.string().nullable(),
  name: z.string(),
  active: z.boolean(),
  workspacePublic: z.boolean(),
  timezone: z.string(),
  policyRevision: z.number().int().positive(),
  collectedSince: z.number(),
  budgetMicros: micros,
});
export type Scope = z.infer<typeof scopeSchema>;
export const sourceSchema = z.object({
  id,
  scopeId: id,
  text: z.string(),
  revision: z.number().int().positive(),
  messageId: z.number().int().nullable(),
  capturedAt: z.number(),
  kind: z.enum(['message', 'text_file', 'tool']),
});
export type Source = z.infer<typeof sourceSchema>;
export const memorySchema = z.object({
  id,
  scopeId: id,
  content: z.string(),
  evidenceIds: z.array(id),
  revision: z.number().int().positive(),
  state: z.enum(['active', 'candidate', 'rejected', 'invalidated']),
  authorId: id,
  correctedByHuman: z.boolean(),
});

export type Memory = z.infer<typeof memorySchema>;

export const answerSchema = z.object({
  text: z.string(),
  sourceIds: z.array(id),
  limitations: z.array(z.string()),
});

export type Answer = z.infer<typeof answerSchema>;

export const taskSchema = z.object({
  id,
  workspaceId: id,
  scopeId: id,
  requesterId: id,
  topicId: z.number().int().nullable(),
  instruction: z.string(),
  state: z.enum([
    'queued',
    'running',
    'waiting_for_input',
    'waiting_for_approval',
    'stopping',
    'paused',
    'blocked',
    'completed',
    'failed',
    'canceled',
  ]),
  revision: z.number().int().positive(),
  epoch: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive(),
  budgetMicros: micros,
  result: answerSchema.nullable(),
  reason: z.string().nullable(),
  createdAt: z.number(),
});
export type Task = z.infer<typeof taskSchema>;

export const toolInputs = {
  notion_search: z.object({ query: z.string().min(1).max(1000) }).strict(),
  notion_read_page: z.object({ pageId: z.uuid() }).strict(),
  github_read_issues: z.object({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }).strict(),
  github_create_issue: z
    .object({
      repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      title: z.string().min(1).max(256),
      body: z.string().min(1).max(20000),
      labels: z.array(z.string().min(1).max(50)).max(10).default([]),
    })
    .strict(),
};
export type ToolName = keyof typeof toolInputs;
export const toolCallSchema = z.discriminatedUnion('name', [
  z.object({ id, name: z.literal('notion_search'), input: toolInputs.notion_search }),
  z.object({ id, name: z.literal('notion_read_page'), input: toolInputs.notion_read_page }),
  z.object({ id, name: z.literal('github_read_issues'), input: toolInputs.github_read_issues }),
  z.object({ id, name: z.literal('github_create_issue'), input: toolInputs.github_create_issue }),
]);
export type ToolCall = z.infer<typeof toolCallSchema>;
export const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id, name: z.string(), input: z.json() }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: id,
    content: z.string(),
    is_error: z.boolean().default(false),
  }),
]);
export const transcriptSchema = z.object({
  role: z.enum(['user', 'assistant']), content: z.array(blockSchema),
  providerState: z.object({
    protocol: z.literal('responses'), provider: z.enum(['openai', 'deepseek']),
    endpoint: z.string(), model: z.string(), items: z.array(z.json()).max(128),
  }).optional(),
});
export type Transcript = z.infer<typeof transcriptSchema>;
export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative(),
  costMicros: micros,
  simulated: z.boolean(),
  pricingRevision: z.string(),
});
export type Usage = z.infer<typeof usageSchema>;
export const turnSchema = z.object({
  message: transcriptSchema,
  usage: usageSchema,
  requestId: z.string(),
  outcome: z.enum(['complete', 'tools', 'needs_input', 'incomplete']),
  sourceIds: z.array(id),
  limitations: z.array(z.string()),
});
export type Turn = z.infer<typeof turnSchema>;
export const effectSchema = z.object({
  id,
  workspaceId: id,
  taskId: id,
  scopeId: id,
  call: toolCallSchema,
  state: z.enum(['prepared', 'waiting_for_approval', 'ready', 'dispatching', 'succeeded', 'unknown', 'denied']),
  taskRevision: z.number().int(),
  policyRevision: z.number().int(),
  grantRevision: z.number().int(),
  connectionId: id.optional(),
  connectionVersion: z.number().int().positive().optional(),
  hash: z.string(),
  result: z.string().nullable(),
  providerId: z.string().nullable(),
  url: z.string().nullable(),
  reason: z.string().nullable(),
});
export type Effect = z.infer<typeof effectSchema>;
export const approvalSchema = z.object({
  id,
  taskId: id,
  effectId: id,
  hash: z.string(),
  expiresAt: z.number(),
  state: z.enum(['pending', 'approved', 'denied', 'invalidated', 'expired']),
  decidedBy: z.string().nullable(),
});
export type Approval = z.infer<typeof approvalSchema>;
export const grantSchema = z.object({
  kind: z.literal('github_repository').optional(),
  id,
  scopeId: id,
  repository: z.string(),
  read: z.boolean(),
  write: z.boolean(),
  active: z.boolean(),
  revision: z.number().int().positive(),
  connectionId: id.optional(),
  connectionVersion: z.number().int().positive().optional(),
}).or(z.object({
  kind: z.literal('notion_scope'), id, scopeId: id,
  repository: z.literal('').default(''), read: z.boolean(), write: z.literal(false).default(false),
  active: z.boolean(), revision: z.number().int().positive(),
  connectionId: id, connectionVersion: z.number().int().positive(), notionWorkspaceId: id,
}));
export type Grant = z.infer<typeof grantSchema>;
export const routineSchema = z.object({
  id,
  scopeId: id,
  instruction: z.string(),
  createdBy: id,
  state: z.enum(['active', 'paused', 'revoked']),
  timezone: z.string(),
  nextAt: z.number(),
  intervalMs: z.number().int().positive(),
  budgetMicros: micros,
});
export type Routine = z.infer<typeof routineSchema>;
export const eventSchema = z.object({
  id,
  taskId: z.string().nullable(),
  scopeId: id,
  kind: z.string(),
  actorId: z.string().nullable(),
  at: z.number(),
  detail: z.json(),
});
export type AuditEvent = z.infer<typeof eventSchema>;
export const taskViewSchema = z.object({
  task: taskSchema,
  effects: z.array(effectSchema),
  approvals: z.array(approvalSchema),
  events: z.array(eventSchema),
  sources: z.array(sourceSchema),
});
export type TaskView = z.infer<typeof taskViewSchema>;
export const workspaceViewSchema = z.object({
  scope: scopeSchema,
  role: roleSchema,
  tasks: z.array(taskViewSchema),
  memories: z.array(memorySchema),
  routines: z.array(routineSchema),
  grants: z.array(grantSchema),
  usage: z.object({ heldMicros: micros, spentMicros: micros, simulated: z.boolean() }),
});
export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

export const commandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('start'),
    instruction: z.string().min(1).max(16000),
    topicId: z.number().int().nullable().default(null),
  }),
  z.object({ kind: z.literal('steer'), taskId: id, text: z.string().min(1).max(16000) }),
  z.object({ kind: z.enum(['stop', 'resume', 'cancel']), taskId: id }),
  z.object({ kind: z.literal('decide'), approvalId: id, decision: z.enum(['approve', 'deny']) }),
  z.object({
    kind: z.literal('remember'),
    content: z.string().min(1).max(4000),
    evidenceIds: z.array(id).default([]),
    candidate: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('correct_memory'),
    memoryId: id,
    expectedRevision: z.number().int().positive(),
    content: z.string().min(1).max(4000),
  }),
  z.object({ kind: z.literal('set_memory'), memoryId: id, state: z.enum(['active', 'rejected', 'invalidated']) }),
  z.object({ kind: z.literal('forget_sources'), sourceIds: z.array(id).min(1).max(100) }),
  z.object({
    kind: z.literal('create_routine'),
    instruction: z.string().min(1).max(4000),
    timezone: z.string(),
    nextAt: z.number(),
    intervalMs: z.number().int().min(60000),
    budgetMicros: micros,
  }),
  z.object({ kind: z.literal('set_routine'), routineId: id, state: z.enum(['active', 'paused', 'revoked']) }),
  z.object({ kind: z.literal('revoke_grant'), grantId: id }),
  z.object({
    kind: z.literal('set_scope'),
    active: z.boolean().optional(),
    workspacePublic: z.boolean().optional(),
    timezone: z.string().optional(),
    budgetMicros: micros.optional(),
  }),
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandInput = { scopeId: string; userId: string; key: string; command: Command };
export type Receipt = { kind: 'accepted' | 'duplicate' | 'ignored' | 'denied'; taskId?: string; message?: string };
export type NormalizedUpdate =
  | {
      kind: 'message';
      botId: string;
      updateId: number;
      chatId: string;
      userId: string | null;
      messageId: number;
      topicId: number | null;
      text: string;
      mentioned: boolean;
      replyTo: number | null;
      edited: boolean;
      file?: { name: string; text: string };
    }
  | {
      kind: 'callback';
      botId: string;
      updateId: number;
      chatId: string;
      userId: string;
      messageId: number;
      data: string;
    }
  | {
      kind: 'membership';
      botId: string;
      updateId: number;
      chatId: string;
      userId: string;
      role: z.infer<typeof roleSchema> | null;
      botRemoved: boolean;
    }
  | { kind: 'migration'; botId: string; updateId: number; chatId: string; newChatId: string };
export type Seed = {
  botId: string;
  workspaceId: string;
  name: string;
  ownerId: string;
  budgetMicros: number;
  scopes: Scope[];
  memberships: { scopeId: string; userId: string; role: z.infer<typeof roleSchema> }[];
  grants: Grant[];
};
export type ModelInput = {
  task: Task;
  history: Transcript[];
  sources: Source[];
  memories: Memory[];
  collectedSince: number;
  tools: ToolName[];
  maxOutputTokens: number;
};
export interface ModelProvider {
  readonly simulated: boolean;
  turn(input: ModelInput, signal: AbortSignal): Promise<Turn>;
}
export type ConnectorReceipt = { providerId: string; url: string | null; content: string };
export type Reconciliation =
  | { kind: 'found'; receipt: ConnectorReceipt }
  | { kind: 'absent'; proof: string }
  | { kind: 'unknown'; reason: string };
export interface IssueConnector {
  readonly simulated: boolean;
  invoke(effect: Effect, signal: AbortSignal): Promise<ConnectorReceipt>;
  reconcile(effect: Effect, signal: AbortSignal): Promise<Reconciliation>;
}
export type Delivery = {
  id: string;
  taskId: string | null;
  scopeId: string;
  chatId: string;
  topicId: number | null;
  text: string;
  buttons: { text: string; data: string }[];
  messageId: number | null;
  replyTo?: number;
  format?: 'markdown';
  purpose?: 'acknowledgement' | 'progress' | 'settings';
};
export interface Messenger {
  readonly simulated: boolean;
  send(delivery: Delivery, signal: AbortSignal): Promise<{ messageId: number }>;
}
export type Lease = { id: string; token: string; workerId: string; expiresAt: number };
export type Job =
  | { kind: 'model'; lease: Lease; input: ModelInput }
  | { kind: 'effect'; lease: Lease; effect: Effect; reconcile: boolean }
  | { kind: 'delivery'; lease: Lease; delivery: Delivery };
export interface Store {
  connectRepositoryGrants(scopeId: string, userId: string, connectionId: string, connectionVersion: number, repositories: string[]): Promise<void>;
  connectNotionGrant(scopeId: string, userId: string, connectionId: string, connectionVersion: number, notionWorkspaceId: string): Promise<void>;
  disconnectRepositoryGrants(scopeId: string, userId: string, connectionId: string): Promise<void>;
  seed(input: Seed): Promise<void>;
  ingest(update: NormalizedUpdate): Promise<Receipt>;
  command(input: CommandInput): Promise<Receipt>;
  view(scopeId: string, userId: string): Promise<WorkspaceView>;
  task(scopeId: string, userId: string, taskId: string): Promise<TaskView>;
  scopes(userId: string): Promise<Scope[]>;
  resolveChat(botId: string, chatId: string): Promise<Scope | null>;
  membership(scopeId: string, userId: string, role: z.infer<typeof roleSchema> | null): Promise<void>;
  claim(workerId: string, kind?: Job['kind']): Promise<Job | null>;
  materializeRoutines(): Promise<void>;
  finishModel(job: Extract<Job, { kind: 'model' }>, result: Turn): Promise<void>;
  finishEffect(job: Extract<Job, { kind: 'effect' }>, receipt: ConnectorReceipt): Promise<void>;
  unknownEffect(job: Extract<Job, { kind: 'effect' }>, reason: string): Promise<void>;
  absentEffect(job: Extract<Job, { kind: 'effect' }>, proof: string): Promise<void>;
  finishDelivery(job: Extract<Job, { kind: 'delivery' }>, messageId: number): Promise<void>;
  fail(job: Job, reason: string): Promise<void>;
  close(): Promise<void>;
}
export type StoreOptions = {
  databasePath: string;
  workspaceIds?: string[];
  modelReserveMicros: number;
  maxOutputTokens: number;
  maxTurns: number;
  taskBudgetMicros: number;
  leaseMs: number;
  simulated: boolean;
  clock?: () => number;
};

// Routine scheduling runs on wall-clock intent. A routine stores an IANA timezone and a
// first occurrence, and every later occurrence is derived by shifting that wall clock, so
// daylight saving moves the instant and the local time stays put. On a spring-forward gap
// the nearest valid instant is used.
const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = wallClockFormatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  wallClockFormatters.set(timeZone, created);
  return created;
}

function wallClockOffsetMs(instant: number, timeZone: string): number {
  const parts = wallClockFormatter(timeZone).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find(part => part.type === type)?.value;
    if (value === undefined) throw new Error(`Wall-clock part ${type} unavailable for ${timeZone}.`);
    return Number(value);
  };
  const wallAsUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
  return wallAsUtc - Math.floor(instant / 1000) * 1000;
}

/** Instant of the next wall-clock occurrence, derived in timeZone rather than in UTC. */
export function nextWallClockInstant(from: number, intervalMs: number, timeZone: string): number {
  const shifted = new Date(from + wallClockOffsetMs(from, timeZone) + intervalMs);
  const wallAsUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), shifted.getUTCHours(), shifted.getUTCMinutes(), shifted.getUTCSeconds(), shifted.getUTCMilliseconds());
  const firstPass = wallAsUtc - wallClockOffsetMs(wallAsUtc, timeZone);
  return wallAsUtc - wallClockOffsetMs(firstPass, timeZone);
}

/** Instant for a datetime-local value ("YYYY-MM-DDTHH:mm") read as wall-clock time in timeZone. */
export function wallClockInstant(value: string, timeZone: string): number {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!parsed) throw new Error("Choose a valid local date and time.");
  const wallAsUtc = Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3]), Number(parsed[4]), Number(parsed[5]));
  const firstPass = wallAsUtc - wallClockOffsetMs(wallAsUtc, timeZone);
  return wallAsUtc - wallClockOffsetMs(firstPass, timeZone);
}
