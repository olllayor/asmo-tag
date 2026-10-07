import { Api } from "grammy";
import { join } from "node:path";
import { createResponsesModel, createFixtureModel } from "./providers/index.js";
import { createFixtureConnector } from "./connectors/index.js";
import { IntegrationService, type IntegrationScope } from "./integrations/index.js";
import { createIntegrationToolConnector } from "./integrations/tool-connector.js";
import { openStore } from "./store/index.js";
import type { Config } from "./config.js";
import { seedFixture, fixtureBot } from "./fixture.js";
import { createFixtureMessenger, createTelegramMessenger, TelegramAuthority } from "./telegram/messenger.js";
import { Worker } from "./worker.js";
import { createTelegramFileGateway } from "./telegram/files.js";

export async function openApplication(config: Config) {
  const store = await openStore({
    databasePath: config.databasePath, simulated: config.mode === "fixture",
    modelReserveMicros: config.modelReserveMicros, maxOutputTokens: config.maxOutputTokens,
    maxTurns: config.maxTurns, taskBudgetMicros: config.taskBudgetMicros, leaseMs: config.leaseMs,
    ...(config.mode === "fixture" ? { workspaceIds: ["ws_atlas", "ws_other"] } : {}),
  });
  let integrations: IntegrationService | undefined;
  try {
    const model = config.mode === "fixture" ? createFixtureModel() : createResponsesModel(config);
    const messenger = config.mode === "fixture" ? createFixtureMessenger(join(config.fixtureDirectory, "deliveries")) : createTelegramMessenger(config.botToken, config.miniAppLink);
    const bot = config.mode === "fixture" ? fixtureBot : await new Api(config.botToken).getMe().then(me => ({ id: String(me.id), username: me.username }));
    const authority = config.mode === "live" ? new TelegramAuthority(config.botToken, bot.id, store) : null;
    integrations = new IntegrationService({ databasePath: config.databasePath, ...(config.mode === "live" ? config.integrations : {}), authorize: async (actorId, context, action) => {
      try {
        const scope = (await store.scopes(actorId)).find(item => item.id === context.scopeId && item.workspaceId === context.workspaceId);
        if (!scope || !scope.active) return false;
        const expected = integrationScope(scope);
        if (expected.kind !== context.kind || expected.ownerId !== context.ownerId) return false;
        await authority?.refresh(scope, actorId);
        const view = await store.view(scope.id, actorId);
        return action === "read" || view.role !== "member";
      } catch { return false; }
    } });
    const connector = config.mode === "fixture" ? createFixtureConnector({ directory: join(config.fixtureDirectory, "issues"), failAfterApply: process.env.ASMO_FIXTURE_FAIL_AFTER_APPLY === "1" }) : createIntegrationToolConnector(integrations);
    const files = config.mode === "live" ? createTelegramFileGateway(config.botToken) : null;
    const telegram = config.mode === "live" ? new Api(config.botToken, { timeoutSeconds: 20 }) : null;
    if (config.mode === "fixture") await seedFixture(store);
    const service = integrations;
    return { store, worker: new Worker(store, model, connector, messenger), bot, authority, files, telegram, integrations: service, config, close: async () => { service.close(); await store.close(); } };
  } catch (error) {
    integrations?.close();
    await store.close();
    throw error;
  }
}
export type Application = Awaited<ReturnType<typeof openApplication>>;
export function integrationScope(scope: import("./core.js").Scope): IntegrationScope {
  return { workspaceId: scope.workspaceId, scopeId: scope.id, kind: scope.kind === "dm" ? "private" : "shared", ownerId: scope.kind === "dm" ? scope.ownerId : null };
}
