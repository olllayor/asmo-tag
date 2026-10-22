import { describe, it, expect } from "vitest";
import { Result, Option } from "effect";
import {
  IdSchema,
  MicrosSchema,
  ScopeSchema,
  SourceSchema,
  MemorySchema,
  AnswerSchema,
  TaskSchema,
  ToolResultBlockSchema,
  TranscriptSchema,
  ApprovalSchema,
  decodeScopeResult,
  decodeScopeSync,
  decodeSourceResult,
  decodeMemoryResult,
  decodeAnswerResult,
  decodeTaskResult,
  decodeTaskSync,
  decodeApprovalResult,
  decodeTranscriptResult,
  decodeBlockSync,
} from "../src/core-effect.js";
import { truncateOption, boundOption } from "../src/limits.js";
import { greetingReplyOption } from "../src/conversation.js";

describe("Effect v4 Core Domain Schemas & Decoders", () => {
  it("validates IdSchema lower and upper bounds (1-128 chars)", () => {
    const valid = decodeScopeResult({
      id: "valid-id",
      workspaceId: "ws-1",
      kind: "group",
      chatId: "123",
      ownerId: null,
      name: "Test Group",
      active: true,
      workspacePublic: false,
      timezone: "UTC",
      policyRevision: 1,
      collectedSince: 1000,
      budgetMicros: 5000,
    });
    expect(Result.isSuccess(valid)).toBe(true);

    // Empty string (< 1 char)
    const emptyId = decodeScopeResult({
      id: "",
      workspaceId: "ws-1",
      kind: "group",
      chatId: "123",
      ownerId: null,
      name: "Test Group",
      active: true,
      workspacePublic: false,
      timezone: "UTC",
      policyRevision: 1,
      collectedSince: 1000,
      budgetMicros: 5000,
    });
    expect(Result.isFailure(emptyId)).toBe(true);
    if (Result.isFailure(emptyId)) {
      expect(emptyId.failure.message).toContain("length of at least 1");
    }

    // Over 128 chars
    const oversizedId = decodeScopeResult({
      id: "a".repeat(129),
      workspaceId: "ws-1",
      kind: "group",
      chatId: "123",
      ownerId: null,
      name: "Test Group",
      active: true,
      workspacePublic: false,
      timezone: "UTC",
      policyRevision: 1,
      collectedSince: 1000,
      budgetMicros: 5000,
    });
    expect(Result.isFailure(oversizedId)).toBe(true);
    if (Result.isFailure(oversizedId)) {
      expect(oversizedId.failure.message).toContain("length of at most 128");
    }
  });

  it("decodes ScopeSync returning typed plain object", () => {
    const scope = decodeScopeSync({
      id: "scope-main",
      workspaceId: "ws-1",
      kind: "workspace",
      chatId: "chat-001",
      ownerId: "user-42",
      name: "Engineering",
      active: true,
      workspacePublic: true,
      timezone: "America/New_York",
      policyRevision: 2,
      collectedSince: 1700000000000,
      budgetMicros: 1000000,
      captureBoundedAt: null,
    });

    expect(scope.id).toBe("scope-main");
    expect(scope.kind).toBe("workspace");
    expect(scope.budgetMicros).toBe(1000000);
  });

  it("decodes Source with correct discriminated kind", () => {
    const res = decodeSourceResult({
      id: "source-1",
      scopeId: "scope-1",
      text: "System captured message",
      revision: 1,
      messageId: 456,
      capturedAt: Date.now(),
      kind: "message",
    });

    expect(Result.isSuccess(res)).toBe(true);
    if (Result.isSuccess(res)) {
      expect(res.success.kind).toBe("message");
      expect(res.success.messageId).toBe(456);
    }
  });

  it("decodes Memory with evidence references", () => {
    const res = decodeMemoryResult({
      id: "mem-1",
      scopeId: "scope-1",
      content: "Team uses Effect v4 for backend runtime",
      evidenceIds: ["source-1", "source-2"],
      revision: 1,
      state: "active",
      authorId: "agent-1",
      correctedByHuman: false,
    });

    expect(Result.isSuccess(res)).toBe(true);
    if (Result.isSuccess(res)) {
      expect(res.success.evidenceIds).toEqual(["source-1", "source-2"]);
      expect(res.success.state).toBe("active");
    }
  });

  it("handles Answer with sources and limitations", () => {
    const res = decodeAnswerResult({
      text: "Migration completed smoothly.",
      sourceIds: ["source-1"],
      limitations: ["Bounded by scope context"],
    });

    expect(Result.isSuccess(res)).toBe(true);
    if (Result.isSuccess(res)) {
      expect(res.success.limitations).toHaveLength(1);
    }
  });

  it("decodes complex Task and validates negative budget constraint", () => {
    const validTask = decodeTaskSync({
      id: "task-001",
      workspaceId: "ws-1",
      scopeId: "scope-1",
      requesterId: "user-1",
      topicId: 10,
      instruction: "Perform Effect v4 migration review",
      state: "running",
      revision: 1,
      epoch: 0,
      turns: 2,
      maxTurns: 10,
      budgetMicros: 50000,
      result: null,
      reason: null,
      createdAt: Date.now(),
    });

    expect(validTask.state).toBe("running");
    expect(validTask.turns).toBe(2);

    // Negative budget must fail
    const invalidBudget = decodeTaskResult({
      ...validTask,
      budgetMicros: -1,
    });
    expect(Result.isFailure(invalidBudget)).toBe(true);
  });

  it("decodes ToolResultBlock with is_error defaulting to false when omitted (Defect 2 parity)", () => {
    const decoded = decodeBlockSync({
      type: "tool_result",
      tool_use_id: "tool-use-1",
      content: "output data",
    });

    expect(decoded.type).toBe("tool_result");
    if (decoded.type === "tool_result") {
      expect(decoded.is_error).toBe(false);
    }

    const explicitTrue = decodeBlockSync({
      type: "tool_result",
      tool_use_id: "tool-use-1",
      content: "failed execution",
      is_error: true,
    });
    if (explicitTrue.type === "tool_result") {
      expect(explicitTrue.is_error).toBe(true);
    }
  });

  it("strictly rejects non-JSON values in ToolUseBlock input (Defect 3 parity)", () => {
    const validJson = decodeBlockSync({
      type: "tool_use",
      id: "tool-1",
      name: "notion_search",
      input: { query: "Effect v4", count: 10 },
    });
    expect(validJson.type).toBe("tool_use");

    // Function is not valid JSON
    expect(() =>
      decodeBlockSync({
        type: "tool_use",
        id: "tool-1",
        name: "notion_search",
        input: { fn: () => {} },
      })
    ).toThrow();
  });

  it("strictly rejects NaN and Infinity in timestamp fields (Defect 4 parity)", () => {
    const nanScope = decodeScopeResult({
      id: "scope-nan",
      workspaceId: "ws-1",
      kind: "group",
      chatId: "123",
      ownerId: null,
      name: "NaN Test",
      active: true,
      workspacePublic: false,
      timezone: "UTC",
      policyRevision: 1,
      collectedSince: NaN,
      budgetMicros: 1000,
    });
    expect(Result.isFailure(nanScope)).toBe(true);

    const infScope = decodeScopeResult({
      id: "scope-inf",
      workspaceId: "ws-1",
      kind: "group",
      chatId: "123",
      ownerId: null,
      name: "Inf Test",
      active: true,
      workspacePublic: false,
      timezone: "UTC",
      policyRevision: 1,
      collectedSince: Infinity,
      budgetMicros: 1000,
    });
    expect(Result.isFailure(infScope)).toBe(true);
  });

  it("enforces TranscriptSchema providerState items maximum limit of 128 (Defect 1 parity)", () => {
    const validTranscript = decodeTranscriptResult({
      role: "assistant",
      content: [{ type: "text", text: "Ready." }],
      providerState: {
        protocol: "responses",
        provider: "openai",
        endpoint: "https://api.openai.com",
        model: "gpt-4o",
        items: new Array(128).fill({ role: "system" }),
      },
    });
    expect(Result.isSuccess(validTranscript)).toBe(true);

    const oversizedTranscript = decodeTranscriptResult({
      role: "assistant",
      content: [{ type: "text", text: "Ready." }],
      providerState: {
        protocol: "responses",
        provider: "openai",
        endpoint: "https://api.openai.com",
        model: "gpt-4o",
        items: new Array(129).fill({ role: "system" }),
      },
    });
    expect(Result.isFailure(oversizedTranscript)).toBe(true);
  });

  it("decodes Approval schema and validates states", () => {
    const approval = decodeApprovalResult({
      id: "app-1",
      taskId: "task-1",
      effectId: "eff-1",
      hash: "sha256-hash",
      expiresAt: 1700000000000,
      state: "pending",
      decidedBy: null,
    });
    expect(Result.isSuccess(approval)).toBe(true);
    if (Result.isSuccess(approval)) {
      expect(approval.success.state).toBe("pending");
    }
  });

  it("integrates Effect Option with truncateOption in limits (Defect 5 parity)", () => {
    // Fits in budget -> Option.none()
    const fit = truncateOption("short string", 100, " [cut]");
    expect(Option.isNone(fit)).toBe(true);

    // Over budget -> Option.some(truncated)
    const truncated = truncateOption("very long string exceeding small budget", 15, " [cut]");
    expect(Option.isSome(truncated)).toBe(true);
    if (Option.isSome(truncated)) {
      expect(truncated.value).toContain("[cut]");
      expect(Buffer.byteLength(truncated.value)).toBeLessThanOrEqual(15);
    }

    // Alias boundOption works identically
    expect(Option.isNone(boundOption("short string", 100, " [cut]"))).toBe(true);
  });

  it("integrates greetingReplyOption in conversation", () => {
    const greeting = greetingReplyOption("@asmo_ai_bot hi");
    expect(Option.isSome(greeting)).toBe(true);
    if (Option.isSome(greeting)) {
      expect(greeting.value).toBe("Hi!");
    }

    const nonGreeting = greetingReplyOption("some random task instruction");
    expect(Option.isNone(nonGreeting)).toBe(true);
  });
});
