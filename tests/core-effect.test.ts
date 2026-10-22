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
  decodeScopeResult,
  decodeScopeSync,
  decodeSourceResult,
  decodeMemoryResult,
  decodeAnswerResult,
  decodeTaskResult,
  decodeTaskSync,
} from "../src/core-effect.js";
import { boundOption } from "../src/limits.js";
import { greetingReplyOption, conversationAnswerResult } from "../src/conversation.js";

describe("Effect v4 Core Domain Schemas & Decoders", () => {
  it("validates IdSchema bounds (1-128 chars)", () => {
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

  it("integrates Effect Option with boundOption in limits", () => {
    // Fits in budget -> Option.none()
    const fit = boundOption("short string", 100, " [cut]");
    expect(Option.isNone(fit)).toBe(true);

    // Over budget -> Option.some(truncated)
    const truncated = boundOption("very long string exceeding small budget", 15, " [cut]");
    expect(Option.isSome(truncated)).toBe(true);
    if (Option.isSome(truncated)) {
      expect(truncated.value).toContain("[cut]");
      expect(Buffer.byteLength(truncated.value)).toBeLessThanOrEqual(15);
    }
  });

  it("integrates greetingReplyOption and conversationAnswerResult", () => {
    const greeting = greetingReplyOption("@asmo_ai_bot hi");
    expect(Option.isSome(greeting)).toBe(true);
    if (Option.isSome(greeting)) {
      expect(greeting.value).toBe("Hi!");
    }

    const nonGreeting = greetingReplyOption("some random task instruction");
    expect(Option.isNone(nonGreeting)).toBe(true);

    const answerRes = conversationAnswerResult("The task is complete", [], 0);
    expect(Result.isSuccess(answerRes)).toBe(true);
    if (Result.isSuccess(answerRes)) {
      expect(answerRes.success).toBe("The task is complete");
    }
  });
});
