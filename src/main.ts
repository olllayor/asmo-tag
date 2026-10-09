import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { Api } from "grammy";
import { readConfig } from "./config.js";
import { openApplication } from "./app.js";
import { createHttpServer } from "./server.js";
import { migrateDatabase } from "./store/index.js";
import { scopeSchema, grantSchema, roleSchema } from "./core.js";
import { enrichFixture, fixtureScope, startFixtureTask } from "./fixture.js";

if (existsSync(".env")) loadEnvFile(".env");
const action = process.argv[2] ?? "help";
async function main() {
  if (action === "help") {
    console.log("Asmo Tag\nCommands: migrate, bootstrap <seed.json>, demo, serve, worker-once\nSet ASMO_MODE explicitly to fixture or live. Fixture mode is simulated.");
    return;
  }
  if (action === "migrate") {
    const path = process.env.ASMO_DATABASE_PATH;
    if (!path) throw new Error("Missing configuration: ASMO_DATABASE_PATH");
    await migrateDatabase(path);
    console.log("Asmo database migration passed."); return;
  }
  if (!["bootstrap", "demo", "serve", "worker-once"].includes(action)) throw new Error("Unknown command. Run help.");
  const config = readConfig();
  const app = await openApplication(config);
  if (action === "bootstrap") {
    try {
      if (config.mode !== "live") throw new Error("Live bootstrap requires explicit live mode.");
      const path = process.argv[3];
      if (!path) throw new Error("Supply a reviewed workspace seed JSON file.");
      const seed = z.object({
        botId: z.string(), workspaceId: z.string(), name: z.string(), ownerId: z.string(), budgetMicros: z.number().int().positive(),
        scopes: z.array(scopeSchema), memberships: z.array(z.object({ scopeId: z.string(), userId: z.string(), role: roleSchema })), grants: z.array(grantSchema),
      }).parse(JSON.parse(await readFile(path, "utf8")));
      if (seed.botId !== app.bot.id) throw new Error("Seed bot identity differs from the configured bot.");
      const api = new Api(config.botToken);
      for (const scope of seed.scopes) {
        if (scope.kind !== "group") throw new Error("The first live bootstrap supports reviewed group bindings only.");
        const bot = await api.getChatMember(scope.chatId, Number(app.bot.id));
        const owner = await api.getChatMember(scope.chatId, Number(seed.ownerId));
        if (bot.status !== "administrator" || !["administrator", "creator"].includes(owner.status)) throw new Error("Bot and workspace owner need verified administrator membership for bootstrap.");
        if (!seed.memberships.some(m => m.scopeId === scope.id && m.userId === seed.ownerId && m.role === "owner")) throw new Error("Each scope needs an explicit current owner membership.");
        if (seed.grants.length) throw new Error("Live bootstrap starts without connector grants. Connect GitHub through Configure after binding the group.");
      }
      for (const scope of seed.scopes.filter(item => item.active)) {
        await api.sendMessage(scope.chatId, "Asmo Tag setup has been approved. Collection starts when the group binding is saved. It captures messages received from that point for scoped tasks and memory. Earlier Telegram history is unavailable. Group managers can pause collection and inspect stored sources through Configure. Shared workspace facts require owner approval. Tool writes require review; Stop does not undo completed actions.");
      }
      await app.store.seed(seed);
      console.log("Verified workspace bindings saved. Collection and capabilities follow the reviewed seed. Live acceptance gates still need to run.");
    } finally { await app.close(); }
    return;
  }
  if (config.mode === "fixture") {
    console.log("SIMULATED fixture mode. No Telegram, model, or GitHub call will occur.");
    await startFixtureTask(app.store);
    await enrichFixture(app.store);
  }
  if (action === "demo") {
    try {
      if (config.mode !== "fixture") throw new Error("Demo requires explicit fixture mode.");
      await app.worker.drain();
      let view = await app.store.view(fixtureScope, "102");
      const approval = view.tasks.flatMap(task => task.approvals).find(item => item.state === "pending");
      if (approval) await app.store.command({ scopeId: fixtureScope, userId: "102", key: `demo-approve-${approval.id}`, command: { kind: "decide", approvalId: approval.id, decision: "approve" } });
      await app.worker.drain();
      view = await app.store.view(fixtureScope, "102");
      console.log(JSON.stringify({ simulated: true, tasks: view.tasks.map(item => ({ id: item.task.id, state: item.task.state, result: item.task.result, effects: item.effects.map(effect => ({ id: effect.id, state: effect.state, providerId: effect.providerId, simulated: true })) })), usage: view.usage }, null, 2));
    } finally { await app.close(); }
    return;
  }
  if (action === "worker-once") {
    try { console.log(JSON.stringify({ worked: await app.worker.step(`worker-${process.pid}`), simulated: config.mode === "fixture" })); }
    finally { await app.close(); }
    return;
  }
  if (action !== "serve") { await app.close(); throw new Error("Unknown command. Run help."); }
  const server = createHttpServer(app);
  const shutdown = new AbortController();
  try {
    await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(config.port, config.host, accept); });
  } catch (error) { await app.close(); throw error; }
  const runWorker = async (kind?: "delivery") => {
    while (!shutdown.signal.aborted) {
      try {
        const worked = await app.worker.step(`server-${process.pid}${kind ? "-delivery" : ""}`, shutdown.signal, kind);
        if (!worked) await setTimeout(500, undefined, { signal: shutdown.signal });
      } catch {
        if (!shutdown.signal.aborted) { console.error("Worker step failed. Inspect database health and task audit."); await setTimeout(1000); }
      }
    }
  };
  const runScheduler = async () => {
    while (!shutdown.signal.aborted) {
      try {
        await app.store.materializeRoutines();
        await setTimeout(1000, undefined, { signal: shutdown.signal });
      } catch {
        if (!shutdown.signal.aborted) { console.error("Scheduler step failed. Inspect database health and routine audit."); await setTimeout(2000); }
      }
    }
  };
  // Keep the durable outbox and scheduled routines responsive while the model or a connector is awaiting HTTP.
  const loops = [runWorker(), runWorker("delivery"), runScheduler()];
  console.log(`Asmo Tag listening at http://${config.host}:${config.port}/${config.mode === "fixture" ? "?fixture=1" : ""}`);
  const stop = () => { shutdown.abort(); server.close(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await Promise.all(loops);
  await app.close();
}
main().catch(error => {
  const message = error instanceof Error && /^(Missing configuration:|ASMO_|Fixture mode|Demo requires|Supply a reviewed|Unknown command)/.test(error.message) ? error.message : "Asmo startup failed. Check configuration, database migration, file access, and service availability.";
  console.error(message);
  process.exitCode = 1;
});
