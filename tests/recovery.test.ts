import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { Job, Scope, StoreOptions } from "../src/core.js";
import { openStore } from "../src/store/index.js";
import { createFixtureConnector } from "../src/connectors/fixture.js";


describe("Real process death between provider apply and database receipt", () => {
  it("recovers the durable external receipt and applies one issue only", async () => {
    const workspaceId = randomUUID();
    const directory = await mkdtemp(join(tmpdir(), "asmo-crash-"));
    const options: StoreOptions = { databasePath: join(directory, "recovery.sqlite"), modelReserveMicros: 1000, maxOutputTokens: 1024, maxTurns: 8, taskBudgetMicros: 100000, leaseMs: 500, simulated: true, workspaceIds: [workspaceId] };
    let store = await openStore(options);
    let child: ReturnType<typeof fork> | undefined;
    const scope: Scope = { id: randomUUID(), workspaceId, name: "Disposable crash proof", kind: "group", chatId: `-${randomUUID()}`, ownerId: null, active: true, workspacePublic: false, timezone: "UTC", policyRevision: 1, collectedSince: Date.now(), budgetMicros: 100000 };
    const next = async (): Promise<Job | null> => {
      for (let index = 0; index < 30; index++) {
        const job = await store.claim("crash-proof-parent");
        if (!job || job.kind !== "delivery") return job;
        await store.finishDelivery(job, 2222);
      }
      throw new Error("Too many synthetic deliveries");
    };
    try {
      await store.seed({ botId: randomUUID(), workspaceId, name: "Synthetic crash proof", ownerId: "owner", budgetMicros: 200000, scopes: [scope], memberships: [{ scopeId: scope.id, userId: "owner", role: "owner" }, { scopeId: scope.id, userId: "member", role: "member" }], grants: [{ id: randomUUID(), scopeId: scope.id, repository: "fixture/recovery", read: true, write: true, active: true, revision: 1 }] });
      const start = await store.command({ scopeId: scope.id, userId: "member", key: randomUUID(), command: { kind: "start", instruction: "Create a simulated recovery issue", topicId: null } });
      if (!start.taskId) throw new Error("Task missing");
      const model = await next();
      if (model?.kind !== "model") throw new Error("Expected model claim");
      await store.finishModel(model, { message: { role: "assistant", content: [{ type: "tool_use", id: "synthetic-write", name: "github_create_issue", input: { repository: "fixture/recovery", title: "One durable synthetic issue", body: "Crash proof with no live provider call.", labels: [] } }] }, outcome: "tools", sourceIds: [], limitations: ["Simulated"], requestId: randomUUID(), usage: { inputTokens: 10, outputTokens: 20, costMicros: 1000, simulated: true, pricingRevision: "fixture" } });
      const before = await store.task(scope.id, "member", start.taskId);
      const approval = before.approvals[0];
      if (!approval) throw new Error("Approval missing");
      await store.command({ scopeId: scope.id, userId: "owner", key: randomUUID(), command: { kind: "decide", approvalId: approval.id, decision: "approve" } });
      child = fork(join(process.cwd(), "scripts/crash-worker.ts"), [], { execArgv: ["--import", "tsx"], env: { ...process.env, ASMO_TEST_DATABASE_PATH: options.databasePath, ASMO_CRASH_WORKSPACE: workspaceId, ASMO_CRASH_LEDGER: directory }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const processHandle = child;
      await new Promise<void>((accept, reject) => {
        const timer = globalThis.setTimeout(() => reject(new Error("Crash proof timed out before durable application")), 10000);
        processHandle.once("message", value => { if (typeof value === "object" && value !== null && "durableEffect" in value) { globalThis.clearTimeout(timer); accept(); } });
        processHandle.once("exit", code => { globalThis.clearTimeout(timer); reject(new Error(`Crash child exited early ${code}`)); });
        processHandle.once("error", reject);
      });
      const exited = new Promise<NodeJS.Signals | null>(accept => processHandle.once("exit", (_code, signal) => accept(signal)));
      processHandle.kill("SIGKILL");
      expect(await exited).toBe("SIGKILL");
      await store.close();
      await setTimeout(650);
      store = await openStore(options);
      const recovered = await next();
      expect(recovered?.kind).toBe("effect");
      if (recovered?.kind !== "effect") throw new Error("Recovery effect missing");
      expect(recovered.reconcile).toBe(true);
      const connector = createFixtureConnector({ directory });
      const reconciliation = await connector.reconcile(recovered.effect, new AbortController().signal);
      expect(reconciliation.kind).toBe("found");
      if (reconciliation.kind !== "found") throw new Error("Receipt was not recovered");
      await store.finishEffect(recovered, reconciliation.receipt);
      const after = await store.task(scope.id, "member", start.taskId);
      expect(after.effects[0]?.state).toBe("succeeded");
      expect(after.effects[0]?.providerId).toBe(reconciliation.receipt.providerId);
      const repeated = await connector.invoke(recovered.effect, new AbortController().signal);
      expect(repeated.providerId).toBe(reconciliation.receipt.providerId);
      expect((await readdir(directory)).filter(file => file.endsWith(".json"))).toHaveLength(1);
      await store.command({ scopeId: scope.id, userId: "member", key: randomUUID(), command: { kind: "cancel", taskId: start.taskId } });
    } finally { child?.kill("SIGKILL"); await store.close(); await rm(directory, { recursive: true, force: true }); }
  }, 20000);
});
