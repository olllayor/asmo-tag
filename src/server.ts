import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { z } from "zod";
import type { Application } from "./app.js";
import { integrationScope } from "./app.js";
import { commandSchema } from "./core.js";
import { fixtureActors } from "./fixture.js";
import { equalSecret, validateInitData } from "./telegram/auth.js";
import { normalizeUpdate, telegramUpdateSchema } from "./telegram/updates.js";
import { attachTextFile } from "./telegram/files.js";

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256000) throw new Error("Request exceeds limit.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
type HttpApplication = Omit<Application, "integrations"> & { integrations: Application["integrations"] | null };
function actor(req: IncomingMessage, app: HttpApplication): string {
  const header = req.headers.authorization ?? "";
  if (app.config.mode === "fixture") {
    if (!header.startsWith("Fixture ") || !fixtureActors.has(header.slice(8))) throw new Error("Authentication required.");
    return header.slice(8);
  }
  if (!header.startsWith("tma ")) throw new Error("Authentication required.");
  return validateInitData(header.slice(4), app.config.botToken);
}

export function createHttpServer(app: HttpApplication) {
  const staticRoot = resolve("web/dist");
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (app.config.mode === "fixture") {
        const host = new URL(`http://${req.headers.host ?? ""}`);
        if (!["127.0.0.1", "localhost", "[::1]"].includes(host.hostname)) throw new Error("Invalid fixture host.");
        if (req.headers.origin && new URL(req.headers.origin).host !== host.host) throw new Error("Cross-origin fixture requests are denied.");
      }
      if (url.pathname === "/health" || url.pathname === "/api/mode") { json(res, 200, { mode: app.config.mode }); return; }
      const callback = /^\/connectors\/(github|notion)\/callback$/.exec(url.pathname);
      if (callback && req.method === "GET") {
        if (!app.integrations || app.config.mode !== "live") throw new Error("Connector unavailable");
        const provider = z.enum(["github", "notion"]).parse(callback[1]);
        const result = await app.integrations.callback(provider, { state: url.searchParams.get("state") ?? "", ...(url.searchParams.has("code") ? { code: url.searchParams.get("code")! } : {}), ...(url.searchParams.has("installation_id") ? { installationId: url.searchParams.get("installation_id")! } : {}), ...(url.searchParams.has("error") ? { error: url.searchParams.get("error")! } : {}) });
        if (result.status === "redirect") { res.writeHead(302, { Location: result.authorizationUrl, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); res.end(); return; }
        {
          const scope = result.connection.scope;
          // The service already checks current manager authority before persisting the proof.
          const actorId = await app.integrations.connectionActor(result.connection.id, result.connection.credentialVersion);
          if (result.connection.provider === "github") await app.store.connectRepositoryGrants(scope.scopeId, actorId, result.connection.id, result.connection.credentialVersion, result.connection.resources);
          else await app.store.connectNotionGrant(scope.scopeId, actorId, result.connection.id, result.connection.credentialVersion, await app.integrations.connectionNotionWorkspaceId(result.connection.id, result.connection.credentialVersion));
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
        res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connected to Asmo Tag</title><body style="background:#000;color:#fff;font:18px system-ui;padding:32px"><h1>Connected</h1><p>Return to Telegram and refresh Tools and access.</p></body></html>'); return;
      }
      if (url.pathname === "/telegram/webhook" && req.method === "POST") {
        if (app.config.mode !== "live" || typeof req.headers["x-telegram-bot-api-secret-token"] !== "string" || !equalSecret(req.headers["x-telegram-bot-api-secret-token"], app.config.webhookSecret)) { json(res, 401, { error: "Webhook authentication failed." }); return; }
        const raw = await body(req);
        let update = normalizeUpdate(raw, app.bot);
        if (!update) { json(res, 200, { kind: "ignored" }); return; }
        if ("userId" in update && update.userId && update.kind !== "membership") {
          const scope = await app.store.resolveChat(app.bot.id, update.chatId);
          if (scope) await app.authority?.refresh(scope, update.userId);
        }
        if (app.files && update.kind === "message") {
          const scope = await app.store.resolveChat(app.bot.id, update.chatId);
          if (scope?.active) update = await attachTextFile(raw, update, app.files);
        }
        const receipt = await app.store.ingest(update);
        const callback = telegramUpdateSchema.parse(raw).callback_query;
        if (callback && app.telegram) {
          try { await app.telegram.answerCallbackQuery(callback.id, { text: receipt.kind === "denied" ? "Action denied. Refresh the task." : "Decision received. Check saved task state." }); }
          catch { console.error("Callback acknowledgement failed. The intake receipt remains saved."); }
        }
        if (receipt.kind === "accepted" && receipt.taskId && update.kind === "message" && !update.edited && (/^\/(stop|cancel)(?:@\w+)?\b/.test(update.text.trim()) || (update.replyTo !== null && !update.text.trim().startsWith("/")))) app.worker.interrupt(receipt.taskId);
        if (receipt.kind === "accepted" && receipt.taskId && update.kind === "callback" && /^(stop|cancel):/.test(update.data)) app.worker.interrupt(receipt.taskId);
        json(res, 200, receipt); return;
      }
      if (url.pathname.startsWith("/api/")) {
        const userId = actor(req, app);
        if (url.pathname === "/api/integrations" && req.method === "GET") {
          if (!app.integrations) throw new Error("Connector unavailable");
          const scopeId = z.string().min(1).max(128).parse(url.searchParams.get("scope"));
          const scope = (await app.store.scopes(userId)).find(item => item.id === scopeId);
          if (!scope) throw new Error("Access denied");
          await app.authority?.refresh(scope, userId);
          json(res, 200, { catalog: app.integrations.catalog(), connections: await app.integrations.list(userId, integrationScope(scope)) }); return;
        }
        if (["/api/integrations/start", "/api/integrations/disconnect"].includes(url.pathname) && req.method === "POST") {
          if (!app.integrations || app.config.mode !== "live") throw new Error("Connector unavailable");
          const input = z.object({ scopeId: z.string().min(1).max(128), provider: z.enum(["github", "notion"]).optional(), connectionId: z.string().min(1).max(128).optional() }).strict().parse(await body(req));
          const scope = (await app.store.scopes(userId)).find(item => item.id === input.scopeId);
          if (!scope) throw new Error("Access denied");
          await app.authority?.refresh(scope, userId);
          if (url.pathname.endsWith("/start")) { json(res, 200, await app.integrations.start(z.enum(["github", "notion"]).parse(input.provider), userId, integrationScope(scope))); return; }
          const connection = (await app.integrations.list(userId, integrationScope(scope))).find(item => item.id === input.connectionId);
          if (!connection) throw new Error("Connection unavailable");
          await app.store.disconnectRepositoryGrants(scope.id, userId, connection.id);
          json(res, 200, await app.integrations.disconnect(userId, integrationScope(scope), connection.id)); return;
        }
        if (url.pathname === "/api/session" && req.method === "GET") {
          const scopes = await app.store.scopes(userId);
          const refreshed = [];
          for (const scope of scopes) {
            try { await app.authority?.refresh(scope, userId); refreshed.push(scope); } catch { continue; }
          }
          const start = z.string().max(128).nullable().parse(url.searchParams.get("start"));
          let route: { scopeId: string; taskId?: string } | null = null;
          if (start) {
            const scope = refreshed.find(item => item.id === start);
            if (scope) route = { scopeId: scope.id };
            else for (const candidate of refreshed) {
              try { await app.store.task(candidate.id, userId, start); route = { scopeId: candidate.id, taskId: start }; break; }
              catch { continue; }
            }
          }
          json(res, 200, { userId, scopes: refreshed, route }); return;
        }
        if (url.pathname === "/api/view" && req.method === "GET") {
          const scopeId = z.string().min(1).max(128).parse(url.searchParams.get("scope"));
          const existing = (await app.store.scopes(userId)).find(scope => scope.id === scopeId);
          if (!existing) throw new Error("Access denied.");
          await app.authority?.refresh(existing, userId);
          json(res, 200, await app.store.view(scopeId, userId)); return;
        }
        if (url.pathname === "/api/command" && req.method === "POST") {
          const input = z.object({ scopeId: z.string().min(1).max(128), key: z.string().min(1).max(128), command: commandSchema }).strict().parse(await body(req));
          const existing = (await app.store.scopes(userId)).find(scope => scope.id === input.scopeId);
          if (!existing) throw new Error("Access denied.");
          await app.authority?.refresh(existing, userId);
          const receipt = await app.store.command({ ...input, userId });
          if (receipt.kind === "accepted" && ["stop", "steer", "cancel"].includes(input.command.kind) && receipt.taskId) app.worker.interrupt(receipt.taskId);
          json(res, receipt.kind === "denied" ? 403 : 200, receipt); return;
        }
        json(res, 404, { error: "Unknown endpoint." }); return;
      }
      if (req.method !== "GET") { json(res, 405, { error: "Method not allowed." }); return; }
      const requested = resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
      if (requested !== staticRoot && !requested.startsWith(`${staticRoot}${sep}`)) { json(res, 404, { error: "Not found." }); return; }
      const path = url.pathname === "/" ? resolve(staticRoot, "index.html") : requested;
      const bytes = await readFile(path);
      res.writeHead(200, { "Content-Type": ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(path)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      res.end(bytes);
    } catch (error) {
      json(res, error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 403, { error: "Request rejected. Check authentication, scope, configuration, and input." });
    }
  });
}
