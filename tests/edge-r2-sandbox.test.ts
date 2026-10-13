import { describe, expect, it, vi } from "vitest";
import { EdgeArtifactStore } from "../src/edge/r2.js";
import type { R2Bucket, R2Object, R2ObjectBody } from "../src/edge/r2.js";
import {
  EphemeralHttpSandboxConnector,
  InMemorySandboxConnector,
  createSandboxConnector,
} from "../src/edge/sandbox.js";

function createMockR2(): R2Bucket & { storage: Map<string, { data: Uint8Array; metadata: Record<string, string> }> } {
  const storage = new Map<string, { data: Uint8Array; metadata: Record<string, string> }>();
  return {
    storage,
    async get(key: string): Promise<R2ObjectBody | null> {
      const item = storage.get(key);
      if (!item) return null;
      return {
        key,
        version: "v1",
        size: item.data.byteLength,
        etag: "etag1",
        httpEtag: "httpEtag1",
        uploaded: new Date(),
        customMetadata: item.metadata,
        body: new ReadableStream(),
        bodyUsed: false,
        async arrayBuffer() { return item.data.buffer as ArrayBuffer; },
        async text() { return new TextDecoder().decode(item.data); },
        async json<T>() { return JSON.parse(new TextDecoder().decode(item.data)) as T; },
        async blob() { return new Blob([item.data as any]); },
      };
    },
    async put(key: string, value: any, options?: any): Promise<R2Object> {
      const data = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
      storage.set(key, { data, metadata: options?.customMetadata ?? {} });
      return {
        key,
        version: "v1",
        size: data.byteLength,
        etag: "etag1",
        httpEtag: "httpEtag1",
        uploaded: new Date(),
        customMetadata: options?.customMetadata,
      };
    },
    async delete(key: string | string[]): Promise<void> {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) storage.delete(k);
    },
    async list(): Promise<any> {
      return { objects: [], truncated: false };
    },
  };
}

describe("EdgeArtifactStore (Cloudflare R2)", () => {
  it("stores and retrieves artifacts with SHA-256 digest validation", async () => {
    const mockR2 = createMockR2();
    const store = new EdgeArtifactStore(mockR2);

    const artifactContent = "# Task Log\nExecuted successfully at " + Date.now();
    const result = await store.putArtifact("artifacts/task-123.log", artifactContent, {
      taskId: "task-123",
      author: "dev-42",
    });

    expect(result.key).toBe("artifacts/task-123.log");
    expect(result.size).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);

    const retrieved = await store.getArtifact("artifacts/task-123.log");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.text()).toBe(artifactContent);
    expect(retrieved!.metadata.taskId).toBe("task-123");
    expect(retrieved!.metadata.sha256).toBe(result.sha256);

    await store.deleteArtifact("artifacts/task-123.log");
    expect(await store.getArtifact("artifacts/task-123.log")).toBeNull();
  });
});

describe("Ephemeral Sandbox Connector", () => {
  it("executes commands in InMemorySandboxConnector", async () => {
    const connector = new InMemorySandboxConnector();
    const result = await connector.execute({
      command: "python3 test.py",
      files: { "test.py": "print('hello from sandbox')" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("python3 test.py");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("calls remote ephemeral sandbox API with proper auth and payload", async () => {
    const mockFetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          exitCode: 0,
          stdout: "pytest passed: 10 tests",
          stderr: "",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const connector = new EphemeralHttpSandboxConnector(
      "https://sandbox.internal/execute",
      "sb_key_999",
      mockFetcher as any
    );

    const result = await connector.execute({
      command: "pytest tests/",
      files: { "conftest.py": "# fixtures" },
      timeoutMs: 5000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("pytest passed: 10 tests");
    expect(mockFetcher).toHaveBeenCalledWith(
      "https://sandbox.internal/execute",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sb_key_999",
        }),
      })
    );
  });

  it("creates appropriate connector via factory", () => {
    const inMem = createSandboxConnector();
    expect(inMem).toBeInstanceOf(InMemorySandboxConnector);

    const remote = createSandboxConnector("https://sandbox.api", "key");
    expect(remote).toBeInstanceOf(EphemeralHttpSandboxConnector);
  });
});
