import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openStore } from "../src/store/index.js";
import { seedFixture } from "../src/fixture.js";
import { Worker } from "../src/worker.js";
import type { Turn } from "../src/core.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

it("keeps the delivery worker in charge of progress and answer order during slow sends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asmo-delivery-order-"));
  let now = Date.now();
  const store = await openStore({ databasePath: join(directory, "test.sqlite"), modelReserveMicros: 1000, maxOutputTokens: 2000, maxTurns: 12, taskBudgetMicros: 20000, leaseMs: 60000, simulated: true, clock: () => now });
  const answer: Turn = { message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] }, usage: { inputTokens: 1, outputTokens: 1, costMicros: 1, simulated: true, pricingRevision: "fixture" }, requestId: "fixture", outcome: "complete", sourceIds: [], limitations: [] };
  const modelResult = deferred<Turn>();
  const modelStarted = deferred<void>();
  const progressStarted = deferred<void>();
  const progressResponse = deferred<void>();
  const delivered: string[] = [];
  let messageId = 1000;
  const worker = new Worker(store,
    { simulated: true, async turn() { modelStarted.resolve(); return modelResult.promise; } },
    { simulated: true, async invoke() { throw new Error("Unexpected effect"); }, async reconcile() { throw new Error("Unexpected effect"); } },
    { simulated: true, async send(delivery) {
      if (delivery.purpose === "progress" && delivery.messageId === null) { progressStarted.resolve(); await progressResponse.promise; }
      delivered.push(delivery.text);
      return { messageId: delivery.messageId ?? ++messageId };
    } });
  const execute = async () => await worker.step("server", undefined, "effect") || await worker.step("server", undefined, "model");
  try {
    await seedFixture(store);
    await store.command({ scopeId: "engineering", userId: "101", key: "order-start", command: { kind: "start", instruction: "Answer directly", topicId: null } });
    await worker.step("server-delivery", undefined, "delivery");
    const execution = execute();
    await modelStarted.promise;
    now += 8001;
    const outbox = worker.step("server-delivery", undefined, "delivery");
    await progressStarted.promise;
    modelResult.resolve(answer);
    await execution;
    expect(await execute()).toBe(false);
    expect(delivered).toEqual(["On it."]);
    progressResponse.resolve();
    await outbox;
    await worker.step("server-delivery", undefined, "delivery");
    await worker.step("server-delivery", undefined, "delivery");
    expect(delivered).toEqual(["On it.", "I'm still working on this.", "Finished. My answer is below.", "Final answer"]);
  } finally {
    modelResult.resolve(answer);
    progressResponse.resolve();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
