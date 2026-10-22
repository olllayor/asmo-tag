/**
 * Effect v4 Core Domain Schemas & Validation
 *
 * Implements core data models using pure Effect v4 Schema and Result primitives.
 * Provides Effect-backed type decoding, encoding, and functional error handling.
 */

import { Schema, Effect } from "effect";

type Type<S> = Schema.Schema.Type<S>;

// Base primitives
export const IdSchema = Schema.String.pipe(
  Schema.check(Schema.isBetweenLength(1, 128))
);
export type Id = Type<typeof IdSchema>;

export const MicrosSchema = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0))
);
export type Micros = Type<typeof MicrosSchema>;

export const RoleSchema = Schema.Literals(["owner", "manager", "member"]);
export type Role = Type<typeof RoleSchema>;

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
export type Scope = Type<typeof ScopeSchema>;

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
export type Source = Type<typeof SourceSchema>;

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
export type Memory = Type<typeof MemorySchema>;

// Answer definition
export const AnswerSchema = Schema.Struct({
  text: Schema.String,
  sourceIds: Schema.Array(IdSchema),
  limitations: Schema.Array(Schema.String),
});
export type Answer = Type<typeof AnswerSchema>;

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
export type TaskState = Type<typeof TaskStateSchema>;

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
export type Task = Type<typeof TaskSchema>;

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
export type Block = Type<typeof BlockSchema>;

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
export type Transcript = Type<typeof TranscriptSchema>;

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
export type Usage = Type<typeof UsageSchema>;

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
export type Turn = Type<typeof TurnSchema>;

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
export type Approval = Type<typeof ApprovalSchema>;

// ============================================================================
// Functional Decoder Primitives (Precompiled Point-Free Effect v4 Decoders)
// ============================================================================

export const decodeScopeResult = Schema.decodeUnknownResult(ScopeSchema);
export const decodeScopeSync = Schema.decodeUnknownSync(ScopeSchema);

export const decodeSourceResult = Schema.decodeUnknownResult(SourceSchema);
export const decodeSourceSync = Schema.decodeUnknownSync(SourceSchema);

export const decodeMemoryResult = Schema.decodeUnknownResult(MemorySchema);
export const decodeMemorySync = Schema.decodeUnknownSync(MemorySchema);

export const decodeAnswerResult = Schema.decodeUnknownResult(AnswerSchema);
export const decodeAnswerSync = Schema.decodeUnknownSync(AnswerSchema);

export const decodeTaskResult = Schema.decodeUnknownResult(TaskSchema);
export const decodeTaskSync = Schema.decodeUnknownSync(TaskSchema);

export const decodeTurnResult = Schema.decodeUnknownResult(TurnSchema);
export const decodeTurnSync = Schema.decodeUnknownSync(TurnSchema);

export const decodeApprovalResult = Schema.decodeUnknownResult(ApprovalSchema);
export const decodeApprovalSync = Schema.decodeUnknownSync(ApprovalSchema);

export const decodeTranscriptResult = Schema.decodeUnknownResult(TranscriptSchema);
export const decodeTranscriptSync = Schema.decodeUnknownSync(TranscriptSchema);

export const decodeUsageResult = Schema.decodeUnknownResult(UsageSchema);
export const decodeUsageSync = Schema.decodeUnknownSync(UsageSchema);

export const decodeBlockResult = Schema.decodeUnknownResult(BlockSchema);
export const decodeBlockSync = Schema.decodeUnknownSync(BlockSchema);
