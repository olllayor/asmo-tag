import { openStore } from "../src/store/index.js";
import { createFixtureConnector } from "../src/connectors/fixture.js";

const databasePath = process.env.ASMO_TEST_DATABASE_PATH;
const workspaceId = process.env.ASMO_CRASH_WORKSPACE;
const directory = process.env.ASMO_CRASH_LEDGER;
if (!databasePath || !workspaceId || !directory || !process.send) throw new Error("Disposable crash harness configuration missing.");
const store = await openStore({ databasePath, modelReserveMicros: 1000, maxOutputTokens: 1024, maxTurns: 8, taskBudgetMicros: 100000, leaseMs: 500, simulated: true, workspaceIds: [workspaceId] });
const connector = createFixtureConnector({ directory, failAfterApply: true });
for (;;) {
  const job = await store.claim("disposable-crash-process");
  if (!job) throw new Error("Crash harness expected approved effect.");
  if (job.kind === "delivery") { await store.finishDelivery(job, 1111); continue; }
  if (job.kind !== "effect" || job.effect.call.name !== "github_create_issue") throw new Error("Crash harness expected a write effect.");
  try { await connector.invoke(job.effect, new AbortController().signal); throw new Error("Expected injected receipt-loss failure."); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Simulated crash after fixture effect applied")) throw error;
  }
  process.send({ durableEffect: job.effect.id });
  await new Promise<never>(() => undefined);
}
