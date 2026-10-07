import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Scope } from "../src/core.js";
import { openStore } from "../src/store/index.js";
import { createHttpServer } from "../src/server.js";
import { readConfig } from "../src/config.js";
import { Worker } from "../src/worker.js";
import { createFixtureModel } from "../src/providers/index.js";
import { createFixtureConnector } from "../src/connectors/index.js";
import { createFixtureMessenger } from "../src/telegram/messenger.js";
import { fixtureBot } from "../src/fixture.js";
import { readStartHint } from "../web/src/navigation.js";
import { IntegrationService } from "../src/integrations/index.js";
import { integrationScope } from "../src/app.js";


describe("HTTP auth and scoped command boundary against SQLite", () => {
  let store: Awaited<ReturnType<typeof openStore>>;
  let server: ReturnType<typeof createHttpServer>;
  let url: string;
  let directory: string;
  let scope: Scope;
  let privateScope: Scope;
  let taskId: string;
  const auth = { Authorization: "Fixture 101" };
  const headers = { ...auth, "Content-Type": "application/json" };
  beforeAll(async () => {
    const workspaceId = randomUUID();
    directory = await mkdtemp(join(tmpdir(), "asmo-http-"));
    store = await openStore({ databasePath: join(directory, "http.sqlite"), modelReserveMicros: 1000, maxOutputTokens: 1024, maxTurns: 4, taskBudgetMicros: 100000, leaseMs: 10000, simulated: true, workspaceIds: [workspaceId] });
    scope = { id: randomUUID(), workspaceId, kind: "group", chatId: String(-Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 12), 16)), ownerId: null, name: "Synthetic HTTP scope", active: true, workspacePublic: false, timezone: "UTC", policyRevision: 1, collectedSince: Date.now(), budgetMicros: 200000 };
    privateScope = { ...scope, id: randomUUID(), chatId: `-${randomUUID()}`, name: "Hidden synthetic scope" };
    await store.seed({ botId: fixtureBot.id, workspaceId, name: "Synthetic HTTP workspace", ownerId: "100", budgetMicros: 300000, scopes: [scope, privateScope], memberships: [{ scopeId: scope.id, userId: "101", role: "member" }, { scopeId: scope.id, userId: "100", role: "owner" }, { scopeId: privateScope.id, userId: "102", role: "member" }], grants: [] });
    const worker = new Worker(store, createFixtureModel(), createFixtureConnector({ directory: join(directory, "issues") }), createFixtureMessenger(join(directory, "delivery")));
    server = createHttpServer({ config: readConfig({ ASMO_MODE: "fixture", ASMO_DATABASE_PATH: join(directory, "http.sqlite") }), store, worker, bot: fixtureBot, authority: null, files: null, telegram: null, integrations: null, close: async () => undefined });
    await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP address missing");
    url = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    if (taskId) await store.command({ scopeId: scope.id, userId: "101", key: randomUUID(), command: { kind: "cancel", taskId } });
    await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  it("rejects missing identity, unknown fixture actors and hidden scopes", async () => {
    expect((await fetch(`${url}/api/session`)).status).toBe(403);
    expect((await fetch(`${url}/api/session`, { headers: { Authorization: "Fixture 999999" } })).status).toBe(403);
    expect((await fetch(`${url}/api/view?scope=${privateScope.id}`, { headers: auth })).status).toBe(403);
    const session = await fetch(`${url}/api/session?start=${privateScope.id}`, { headers: auth });
    const body = await session.json() as { route: unknown; scopes: Scope[] };
    expect(body.route).toBeNull();
    expect(body.scopes.some(item => item.id === privateScope.id)).toBe(false);
  });
  it("derives actor server-side and persists command retry identity", async () => {
    const key = randomUUID();
    const payload = { scopeId: scope.id, key, command: { kind: "start", instruction: "Synthetic HTTP task", topicId: null } };
    expect((await fetch(`${url}/api/command`, { method: "POST", headers, body: JSON.stringify({ ...payload, userId: "100" }) })).status).toBe(400);
    const accepted = await fetch(`${url}/api/command`, { method: "POST", headers, body: JSON.stringify(payload) });
    expect(accepted.status).toBe(200);
    const first = await accepted.json() as { kind: string; taskId: string };
    taskId = first.taskId;
    expect(first.kind).toBe("accepted");
    const repeated = await fetch(`${url}/api/command`, { method: "POST", headers, body: JSON.stringify(payload) });
    expect(await repeated.json()).toMatchObject({ kind: "duplicate", taskId });
    expect((await store.task(scope.id, "101", taskId)).task.requesterId).toBe("101");
  });
  it("resolves only authorized task and scope launch hints", async () => {
    const resolved = await fetch(`${url}/api/session?start=${taskId}`, { headers: auth });
    expect(await resolved.json()).toMatchObject({ route: { scopeId: scope.id, taskId } });
    const directScope = await fetch(`${url}/api/session?start=${scope.id}`, { headers: auth });
    expect(await directScope.json()).toMatchObject({ route: { scopeId: scope.id } });
  });
  it("rejects cross-origin and hostile Host access to fixture authentication", async () => {
    expect((await fetch(`${url}/api/session`, { headers: { ...auth, Origin: "https://untrusted.invalid" } })).status).toBe(403);
    const hostile = await new Promise<number | undefined>((accept, reject) => {
      const req = httpRequest(`${url}/api/session`, { headers: { ...auth, Host: "untrusted.invalid" } }, response => { response.resume(); accept(response.statusCode); });
      req.once("error", reject); req.end();
    });
    expect(hostile).toBe(403);
    expect((await fetch(`${url}/api/session`, { headers: { ...auth, Origin: url } })).status).toBe(200);
    expect((await fetch(`${url}/telegram/webhook`, { method: "POST", body: "{}" })).status).toBe(401);
  });
  it("links Notion through authenticated HTTP and creates only the verified scope grant", async () => {
    const token = "123456:synthetic";
    const config = readConfig({ ASMO_MODE: "live", ASMO_DATABASE_PATH: join(directory, "http.sqlite"), TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: "synthetic-webhook-secret", OPENAI_API_KEY: "synthetic", ASMO_MODEL: "synthetic", ASMO_CACHED_INPUT_USD_PER_MILLION: "0.1", ASMO_INPUT_USD_PER_MILLION: "1", ASMO_OUTPUT_USD_PER_MILLION: "1", ASMO_MODEL_RESERVE_MICROS: "200000" });
    expect(config.mode).toBe("live"); // No manual GitHub token or repository list needed for chat.
    const signed = (id: number) => {
      const fields = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) });
      const data = [...fields.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
      fields.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update(token).digest()).update(data).digest("hex"));
      return { Authorization: `tma ${fields}`, "Content-Type": "application/json" };
    };
    let calls = 0;
    const integrations = new IntegrationService({ databasePath: config.databasePath, vaultKey: randomBytes(32).toString("base64"), notion: { clientId: "fake-client", clientSecret: "fake-secret", redirectUri: "https://asmo.test/connectors/notion/callback" }, authorize: async (userId, context, action) => { try { const view = await store.view(context.scopeId, userId); return context.workspaceId === view.scope.workspaceId && (action === "read" || view.role !== "member"); } catch { return false; } }, fetch: async () => { calls++; return new Response(JSON.stringify({ access_token: "private-access", refresh_token: "private-refresh", bot_id: "notion-bot", workspace_id: "notion-workspace", workspace_name: "Plans" })); } });
    const worker = new Worker(store, createFixtureModel(), createFixtureConnector({ directory: join(directory, "oauth-issues") }), createFixtureMessenger(join(directory, "oauth-deliveries")));
    const transport = createHttpServer({ config, store, worker, bot: fixtureBot, authority: null, files: null, telegram: null, integrations, close: async () => undefined });
    await new Promise<void>(accept => transport.listen(0, "127.0.0.1", accept));
    const address = transport.address(); if (!address || typeof address === "string") throw new Error("HTTP address missing");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const payload = { scopeId: scope.id, provider: "notion" };
      expect((await fetch(`${base}/api/integrations/start`, { method: "POST", headers: signed(101), body: JSON.stringify(payload) })).status).toBe(403);
      expect((await fetch(`${base}/api/integrations/start`, { method: "POST", headers: signed(100), body: JSON.stringify({ ...payload, userId: "101" }) })).status).toBe(400);
      const started = await fetch(`${base}/api/integrations/start`, { method: "POST", headers: signed(100), body: JSON.stringify(payload) });
      expect(started.status).toBe(200);
      const link = await started.json() as { authorizationUrl: string };
      const state = new URL(link.authorizationUrl).searchParams.get("state")!;
      const callback = `${base}/connectors/notion/callback?state=${encodeURIComponent(state)}&code=mock-code`;
      expect((await fetch(callback)).status).toBe(200);
      expect((await fetch(callback)).status).toBe(403);
      expect(calls).toBe(1);
      const listing = await fetch(`${base}/api/integrations?scope=${scope.id}`, { headers: signed(101) });
      const data = await listing.json() as { connections: { id: string }[] };
      expect(JSON.stringify(data)).not.toContain("private-access");
      expect((await store.view(scope.id, "101")).grants).toEqual([expect.objectContaining({ kind: "notion_scope", notionWorkspaceId: "notion-workspace", connectionVersion: 1, active: true })]);
      const id = data.connections[0]!.id;
      expect((await fetch(`${base}/api/integrations/disconnect`, { method: "POST", headers: signed(101), body: JSON.stringify({ scopeId: scope.id, connectionId: id }) })).status).toBe(403);
      expect((await fetch(`${base}/api/integrations/disconnect`, { method: "POST", headers: signed(100), body: JSON.stringify({ scopeId: scope.id, connectionId: id }) })).status).toBe(200);
      expect((await store.view(scope.id, "101")).grants[0]?.active).toBe(false);
      expect((await integrations.list("101", integrationScope(scope)))[0]?.status).toBe("disconnected");
    } finally { await new Promise<void>((accept, reject) => transport.close(error => error ? reject(error) : accept())); integrations.close(); }
  });
  it("does not interrupt a running model when a Telegram reply requests status", async () => {
    const delivery = await store.claim("status-test-link");
    if (delivery?.kind !== "delivery") throw new Error("Expected queued acknowledgement");
    await store.finishDelivery(delivery, 900);
    const control = new AbortController();
    let started: () => void = () => undefined;
    let complete: () => void = () => undefined;
    const entered = new Promise<void>(accept => { started = accept; });
    const model = createFixtureModel();
    const worker = new Worker(store, { simulated: true, async turn(input, signal) {
      started();
      await new Promise<void>((accept, reject) => {
        complete = accept;
        signal.addEventListener("abort", () => reject(new Error("Unexpected status interruption")), { once: true });
      });
      signal.throwIfAborted();
      return model.turn(input, signal);
    } }, createFixtureConnector({ directory: join(directory, "status-issues") }), createFixtureMessenger(join(directory, "status-delivery")));
    const liveConfig = readConfig({ ASMO_MODE: "live", ASMO_DATABASE_PATH: join(directory, "http.sqlite"), TELEGRAM_BOT_TOKEN: "123456:synthetic", TELEGRAM_WEBHOOK_SECRET: "synthetic-webhook-secret", OPENAI_API_KEY: "synthetic", ASMO_MODEL: "synthetic", ASMO_CACHED_INPUT_USD_PER_MILLION: "0.1", ASMO_INPUT_USD_PER_MILLION: "1", ASMO_OUTPUT_USD_PER_MILLION: "1", ASMO_MODEL_RESERVE_MICROS: "200000", GITHUB_INSTALLATION_TOKEN: "synthetic", ASMO_GITHUB_REPOSITORIES: "fixture/http" });
    const transport = createHttpServer({ config: liveConfig, store, worker, bot: fixtureBot, authority: null, files: null, telegram: null, integrations: null, close: async () => undefined });
    await new Promise<void>(accept => transport.listen(0, "127.0.0.1", accept));
    const address = transport.address();
    if (!address || typeof address === "string") throw new Error("HTTP address missing");
    const running = worker.step("status-test-model", control.signal);
    try {
      await entered;
      for (const [index, text] of ["/status", " \n/status "].entries()) {
        const response = await fetch(`http://127.0.0.1:${address.port}/telegram/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "synthetic-webhook-secret" }, body: JSON.stringify({ update_id: index + 1, message: { message_id: 901 + index, from: { id: 101 }, chat: { id: Number(scope.chatId), type: "supergroup" }, text, reply_to_message: { message_id: 900 } } }) });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ kind: "accepted", taskId });
      }
      complete();
      expect(await running).toBe(true);
      expect((await store.task(scope.id, "101", taskId)).task.state).toBe("completed");
    } finally {
      complete(); control.abort(); await running;
      await new Promise<void>((accept, reject) => transport.close(error => error ? reject(error) : accept()));
    }
  }, 10000);
});

describe("Telegram launch parameters carry navigation only", () => {
  it("uses initData precedence and strips Configure intent", () => {
    expect(readStartHint("?tgWebAppStartParam=other", "", "start_param=c_task")).toEqual({ id: "task", configure: true });
    expect(readStartHint("?tgWebAppStartParam=c_scope", "")).toEqual({ id: "scope", configure: true });
    expect(readStartHint("", "#tgWebAppStartParam=task")).toEqual({ id: "task", configure: false });
    expect(readStartHint("?startapp=c_scope", "")).toEqual({ id: "scope", configure: true });
    expect(readStartHint("?scope=secret&role=owner", "")).toBeNull();
  });
});
