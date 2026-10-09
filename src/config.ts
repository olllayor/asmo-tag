import { resolve } from "node:path";
import { z } from "zod";
import { readModelConfig } from "./providers/provider-config.js";
import { readIntegrationConfig } from "./integrations/config.js";

const integer = (env: NodeJS.ProcessEnv, key: string, fallback: number) => {
  const result = z.coerce.number().int().positive().safeParse(env[key] ?? fallback);
  if (!result.success) throw new Error(`${key} must be a positive integer.`);
  return result.data;
};
const required = (env: NodeJS.ProcessEnv, key: string) => {
  const value = env[key];
  if (!value) throw new Error(`Missing configuration: ${key}`);
  return value;
};
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsedMode = z.enum(["fixture", "live"]).safeParse(env.ASMO_MODE);
  if (!parsedMode.success) throw new Error("ASMO_MODE must be fixture or live.");
  const mode = parsedMode.data;
  if (!env.ASMO_DATABASE_PATH && (env.ASMO_DATABASE_URL || env.ASMO_MIGRATION_DATABASE_URL)) throw new Error("ASMO_DATABASE_URL is no longer supported. Set ASMO_DATABASE_PATH to a SQLite file.");
  if (env.ASMO_DATABASE_PATH !== undefined && (!env.ASMO_DATABASE_PATH.trim() || /^[a-z][a-z0-9+.-]*:\/\//i.test(env.ASMO_DATABASE_PATH))) throw new Error("ASMO_DATABASE_PATH must be a local SQLite file path");
  const common = {
    mode, databasePath: resolve(env.ASMO_DATABASE_PATH ?? (mode === "fixture" ? "work/asmo-fixture.sqlite" : "work/asmo-pilot.sqlite")),
    port: integer(env, "ASMO_PORT", 8787), host: env.ASMO_HOST ?? "127.0.0.1",
    fixtureDirectory: resolve(env.ASMO_FIXTURE_DIRECTORY ?? "work/fixtures"),
    maxOutputTokens: integer(env, "ASMO_MAX_OUTPUT_TOKENS", 2048),
    maxTurns: integer(env, "ASMO_MAX_TURNS", 12), leaseMs: integer(env, "ASMO_LEASE_MS", 60000),
    taskBudgetMicros: integer(env, "ASMO_TASK_BUDGET_MICROS", 2000000),
    modelReserveMicros: integer(env, "ASMO_MODEL_RESERVE_MICROS", 100000),
    miniAppLink: env.ASMO_MINIAPP_LINK,
  };
  if (mode === "fixture") {
    if (!["127.0.0.1", "localhost", "::1"].includes(common.host)) throw new Error("Fixture mode must listen on loopback.");
    return { ...common, mode } as const;
  }
  const live = {
    ...common, mode,
    botToken: required(env, "TELEGRAM_BOT_TOKEN"),
    webhookSecret: required(env, "TELEGRAM_WEBHOOK_SECRET"),
    ...readModelConfig(env),
    integrations: readIntegrationConfig(env),
  } as const;
  if (live.maxOutputTokens > 4096) throw new Error("ASMO_MAX_OUTPUT_TOKENS must be at most 4096 for the Responses adapter.");
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(live.webhookSecret)) throw new Error("TELEGRAM_WEBHOOK_SECRET must contain 16 to 256 safe characters.");
  const upperBound = Math.ceil(100000 * Math.max(live.inputUsdPerMillion, live.cachedInputUsdPerMillion) + live.maxOutputTokens * live.outputUsdPerMillion);
  if (live.modelReserveMicros < upperBound) throw new Error(`ASMO_MODEL_RESERVE_MICROS must be at least ${upperBound} for the configured request bounds and prices.`);
  if (live.miniAppLink && !/^https:\/\/t\.me\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+$/.test(live.miniAppLink)) throw new Error("ASMO_MINIAPP_LINK must be the configured Telegram Mini App direct link.");
  return live;
}
export type Config = ReturnType<typeof readConfig>;
