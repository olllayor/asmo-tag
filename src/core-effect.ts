/**
 * Effect v4 Core Domain Schemas & Validation
 *
 * Implements core data models using pure Effect v4 Schema and Result primitives.
 * Provides zero-runtime-dependency type decoding, encoding, and functional error handling.
 */

import { Schema, Effect } from "effect";

// Base primitives
export const IdSchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128))
);
export type Id = Schema.Schema.Type<typeof IdSchema>;

export const MicrosSchema = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0))
);
export type Micros = Schema.Schema.Type<typeof MicrosSchema>;

export const RoleSchema = Schema.Literals(["owner", "manager", "member"]);
export type Role = Schema.Schema.Type<typeof RoleSchema>;

// Scope definition
export const ScopeKindSchema = Schema.Literals(["group", "dm", "workspace"]);

export const ScopeSchema = Schema.Struct({
  id: IdSchema,
  workspaceId: IdSchema,
  kind: ScopeKindSchema,
  chatId: Schema.String,
  ownerId: Schema.NullOr(Schema.String),
  name: Schema.String,
  active: Schema.Boolean,
  workspacePublic: Schema.Boolean,
  timezone: Schema.String,
  policyRevision: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  collectedSince: Schema.Finite,
  budgetMicros: MicrosSchema,
  captureBoundedAt: Schema.optional(Schema.NullOr(Schema.Finite)),
});
export type Scope = Schema.Schema.Type<typeof ScopeSchema>;

// Source definition
export const SourceKindSchema = Schema.Literals(["message", "text_file", "tool"]);

export const SourceSchema = Schema.Struct({
  id: IdSchema,
  scopeId: IdSchema,
  text: Schema.String,
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  messageId: Schema.NullOr(Schema.Int),
  capturedAt: Schema.Finite,
  kind: SourceKindSchema,
});
export type Source = Schema.Schema.Type<typeof SourceSchema>;

// Memory definition
export const MemoryStateSchema = Schema.Literals(["active", "candidate", "rejected", "invalidated"]);

export const MemorySchema = Schema.Struct({
  id: IdSchema,
  scopeId: IdSchema,
  content: Schema.String,
  evidenceIds: Schema.Array(IdSchema),
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  state: MemoryStateSchema,
  authorId: IdSchema,
  correctedByHuman: Schema.Boolean,
});
export type Memory = Schema.Schema.Type<typeof MemorySchema>;

// Answer definition
export const AnswerSchema = Schema.Struct({
  text: Schema.String,
  sourceIds: Schema.Array(IdSchema),
  limitations: Schema.Array(Schema.String),
});
export type Answer = Schema.Schema.Type<typeof AnswerSchema>;

// Task definition
export const TaskStateSchema = Schema.Literals([
  "queued",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "stopping",
  "paused",
  "blocked",
  "completed",
  "failed",
  "canceled",
]);
export type TaskState = Schema.Schema.Type<typeof TaskStateSchema>;

export const CompactionSchema = Schema.Struct({
  entries: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  summary: Schema.String,
});

export const TaskSchema = Schema.Struct({
  id: IdSchema,
  workspaceId: IdSchema,
  scopeId: IdSchema,
  requesterId: IdSchema,
  topicId: Schema.NullOr(Schema.Int),
  instruction: Schema.String,
  state: TaskStateSchema,
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  epoch: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  turns: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  maxTurns: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  budgetMicros: MicrosSchema,
  result: Schema.NullOr(AnswerSchema),
  reason: Schema.NullOr(Schema.String),
  createdAt: Schema.Finite,
  compaction: Schema.optional(CompactionSchema),
});
export type Task = Schema.Schema.Type<typeof TaskSchema>;

// Transcript block definitions
export const TextBlockSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

export const ToolUseBlockSchema = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: IdSchema,
  name: Schema.String,
  input: Schema.Json,
});

export const ToolResultBlockSchema = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: IdSchema,
  content: Schema.String,
  is_error: Schema.Boolean.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(false))),
});

export const BlockSchema = Schema.Union([
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
]);
export type Block = Schema.Schema.Type<typeof BlockSchema>;

export const TranscriptSchema = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.Array(BlockSchema),
  providerState: Schema.optional(
    Schema.Struct({
      protocol: Schema.Literal("responses"),
      provider: Schema.Literals(["openai", "deepseek"]),
      endpoint: Schema.String,
      model: Schema.String,
      items: Schema.Array(Schema.Json).pipe(Schema.check(Schema.isMaxLength(128))),
    })
  ),
});
export type Transcript = Schema.Schema.Type<typeof TranscriptSchema>;

// Token usage
export const UsageSchema = Schema.Struct({
  inputTokens: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  cachedInputTokens: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  cachedInputReported: Schema.optional(Schema.Boolean),
  reasoningOutputTokens: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  outputTokens: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  costMicros: MicrosSchema,
  simulated: Schema.Boolean,
  pricingRevision: Schema.String,
});
export type Usage = Schema.Schema.Type<typeof UsageSchema>;

// Turn
export const TurnOutcomeSchema = Schema.Literals(["complete", "tools", "needs_input", "incomplete"]);

export const TurnSchema = Schema.Struct({
  message: TranscriptSchema,
  usage: UsageSchema,
  requestId: Schema.String,
  outcome: TurnOutcomeSchema,
  sourceIds: Schema.Array(IdSchema),
  limitations: Schema.Array(Schema.String),
  compaction: Schema.optional(
    Schema.Struct({
      entries: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
      summary: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    })
  ),
});
export type Turn = Schema.Schema.Type<typeof TurnSchema>;

// Approval definition
export const ApprovalStateSchema = Schema.Literals(["pending", "approved", "denied", "invalidated", "expired"]);

export const ApprovalSchema = Schema.Struct({
  id: IdSchema,
  taskId: IdSchema,
  effectId: IdSchema,
  hash: Schema.String,
  expiresAt: Schema.Finite,
  state: ApprovalStateSchema,
  decidedBy: Schema.NullOr(Schema.String),
});
export type Approval = Schema.Schema.Type<typeof ApprovalSchema>;

// ============================================================================
// Functional Decoder Primitives (Returning Effect v4 Result)
// ============================================================================

export const decodeScopeResult = (data: unknown) =>
  Schema.decodeUnknownResult(ScopeSchema)(data);

export const decodeScopeSync = (data: unknown): Scope =>
  Schema.decodeUnknownSync(ScopeSchema)(data);

export const decodeSourceResult = (data: unknown) =>
  Schema.decodeUnknownResult(SourceSchema)(data);

export const decodeSourceSync = (data: unknown): Source =>
  Schema.decodeUnknownSync(SourceSchema)(data);

export const decodeMemoryResult = (data: unknown) =>
  Schema.decodeUnknownResult(MemorySchema)(data);

export const decodeMemorySync = (data: unknown): Memory =>
  Schema.decodeUnknownSync(MemorySchema)(data);

export const decodeAnswerResult = (data: unknown) =>
  Schema.decodeUnknownResult(AnswerSchema)(data);

export const decodeAnswerSync = (data: unknown): Answer =>
  Schema.decodeUnknownSync(AnswerSchema)(data);

export const decodeTaskResult = (data: unknown) =>
  Schema.decodeUnknownResult(TaskSchema)(data);

export const decodeTaskSync = (data: unknown): Task =>
  Schema.decodeUnknownSync(TaskSchema)(data);

export const decodeTurnResult = (data: unknown) =>
  Schema.decodeUnknownResult(TurnSchema)(data);

export const decodeTurnSync = (data: unknown): Turn =>
  Schema.decodeUnknownSync(TurnSchema)(data);

export const decodeApprovalResult = (data: unknown) =>
  Schema.decodeUnknownResult(ApprovalSchema)(data);

export const decodeApprovalSync = (data: unknown): Approval =>
  Schema.decodeUnknownSync(ApprovalSchema)(data);

export const decodeTranscriptResult = (data: unknown) =>
  Schema.decodeUnknownResult(TranscriptSchema)(data);

export const decodeTranscriptSync = (data: unknown): Transcript =>
  Schema.decodeUnknownSync(TranscriptSchema)(data);

export const decodeUsageResult = (data: unknown) =>
  Schema.decodeUnknownResult(UsageSchema)(data);

export const decodeUsageSync = (data: unknown): Usage =>
  Schema.decodeUnknownSync(UsageSchema)(data);

export const decodeBlockResult = (data: unknown) =>
  Schema.decodeUnknownResult(BlockSchema)(data);

export const decodeBlockSync = (data: unknown): Block =>
  Schema.decodeUnknownSync(BlockSchema)(data);
