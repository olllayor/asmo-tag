import React, { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { scopeSchema, workspaceViewSchema } from "../../src/core";
import { wallClockInstant } from "../../src/core";
import type { Command, Effect, Memory, Scope, TaskView, WorkspaceView } from "../../src/core";
import { readStartHint } from "./navigation";
import "./styles.css";

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData: string; ready?: () => void; expand?: () => void; openLink?: (url: string) => void } };
  }
}

const sessionSchema = z.object({ userId: z.string(), scopes: z.array(scopeSchema), route: z.object({ scopeId: z.string(), taskId: z.string().optional() }).nullish() });
const modeSchema = z.object({ mode: z.enum(["fixture", "live"]) });
const receiptSchema = z.object({ kind: z.enum(["accepted", "duplicate", "ignored", "denied"]), taskId: z.string().optional(), message: z.string().optional() });
type Session = z.infer<typeof sessionSchema>;
type Mutate = (command: Command) => Promise<boolean>;
type Section = "task" | "configure" | "admin";
type SettingsTab = "general" | "tools" | "memory" | "routines";
const actors = [{ id: "101", name: "Maya · Member" }, { id: "102", name: "Sam · Manager" }, { id: "100", name: "Owner" }];
const query = new URLSearchParams(window.location.search);
const dollars = (micros: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(micros / 1_000_000);
const date = (at: number) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(at) + " UTC";
const stateName = (state: string) => state.replaceAll("_", " ");
const ids = (value: string) => [...new Set(value.split(/[\s,]+/).filter(Boolean))];

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function amount(value: string): number {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error("Enter a nonnegative dollar amount with up to six decimal places.");
  const result = Math.round(Number(value) * 1_000_000);
  if (!Number.isSafeInteger(result)) throw new Error("The allowance is too large.");
  return result;
}

function secureUrl(value: string | null): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : null; } catch { return null; }
}

async function request(path: string, authorization?: string, signal?: AbortSignal, command?: unknown): Promise<unknown> {
  const headers = new Headers();
  if (authorization) headers.set("Authorization", authorization);
  if (command) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { headers, signal, method: command ? "POST" : "GET", ...(command ? { body: JSON.stringify(command) } : {}) });
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error(`The server returned an unreadable response (${response.status}).`); }
  if (!response.ok) {
    const error = z.object({ error: z.string().optional(), message: z.string().optional() }).safeParse(body);
    throw new ApiError(response.status, response.status === 403 || response.status === 401 ? "This view is unavailable for your current account. Open Asmo Tag from Telegram with access to this group." : error.success ? error.data.error ?? error.data.message ?? `Request failed (${response.status}).` : `Request failed (${response.status}).`);
  }
  return body;
}

function App() {
  const [mode, setMode] = useState<"fixture" | "live" | null>(null);
  const [actor, setActor] = useState("101");
  const [session, setSession] = useState<Session | null>(null);
  const [authorization, setAuthorization] = useState<string | null>(null);
  const [scopeId, setScopeId] = useState(query.get("scope") ?? "");
  const [taskId, setTaskId] = useState(query.get("task") ?? "");
  const [view, setView] = useState<WorkspaceView | null>(null);
  const [section, setSection] = useState<Section>(query.get("view") === "configure" ? "configure" : "task");
  const [tab, setTab] = useState<SettingsTab>("general");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [launch, setLaunch] = useState(false);
  const mutationLock = useRef(false);
  const uncertainCommands = useRef(new Map<string, string>());
  const fixture = mode === "fixture" && query.get("fixture") === "1";

  useEffect(() => {
    const controller = new AbortController();
    request("/api/mode", undefined, controller.signal).then(body => setMode(modeSchema.parse(body).mode)).catch(cause => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "Cannot reach Asmo Tag."); setLoading(false); } });
    window.Telegram?.WebApp?.ready?.();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!mode) return;
    const initData = window.Telegram?.WebApp?.initData;
    const auth = fixture ? `Fixture ${actor}` : initData ? `tma ${initData}` : null;
    setSession(null); setView(null); setError(""); setNotice(""); setAuthorization(auth); setLaunch(!auth);
    if (!auth) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    const hint = readStartHint(window.location.search, window.location.hash, initData);
    const validHint = hint && hint.id.length > 0 && hint.id.length <= 128;
    request(`/api/session${validHint ? `?start=${encodeURIComponent(hint.id)}` : ""}`, auth, controller.signal).then(body => {
      const result = sessionSchema.parse(body);
      if (!controller.signal.aborted) {
        setSession(result);
        if (hint && result.route && result.scopes.some(scope => scope.id === result.route?.scopeId)) {
          setScopeId(result.route.scopeId);
          setTaskId(result.route.taskId ?? "");
          setSection(hint.configure ? "configure" : "task");
        } else {
          setScopeId(previous => result.scopes.some(scope => scope.id === previous) ? previous : query.get("scope") ?? result.scopes[0]?.id ?? "");
          if (hint) { setTaskId("unavailable-linked-task"); setSection("task"); setNotice("The linked destination is unavailable for this account. Select an accessible scope or task."); }
        }
        if (!result.scopes.length) setLoading(false);
      }
    }).catch(cause => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "Could not authenticate."); setLoading(false); } });
    return () => controller.abort();
  }, [mode, fixture, actor]);

  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!authorization || !scopeId) return;
    try {
      const result = workspaceViewSchema.parse(await request(`/api/view?scope=${encodeURIComponent(scopeId)}`, authorization, signal));
      if (!signal?.aborted) setView(result);
    } catch (cause) {
      if (!signal?.aborted && cause instanceof ApiError && [401, 403].includes(cause.status)) setView(null);
      throw cause;
    }
  }, [authorization, scopeId]);

  useEffect(() => {
    if (!session || !authorization || !scopeId) return;
    const controller = new AbortController();
    setView(null); setLoading(true); setError("");
    reload(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load this scope."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [session, authorization, scopeId, reload]);

  useEffect(() => {
    if (!view || busy || !view.tasks.some(({ task }) => ["queued", "running", "stopping"].includes(task.state))) return;
    const controller = new AbortController();
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending || document.hidden || mutationLock.current) return;
      pending = true;
      reload(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Refresh failed. Saved state remains visible."); }).finally(() => { pending = false; });
    }, 4000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [view, busy, reload]);

  const mutate: Mutate = async command => {
    if (!authorization || !scopeId || mutationLock.current) return false;
    mutationLock.current = true; setBusy(true); setError(""); setNotice("");
    const fingerprint = `${session?.userId ?? ""}:${scopeId}:${JSON.stringify(command)}`;
    const key = uncertainCommands.current.get(fingerprint) ?? crypto.randomUUID();
    uncertainCommands.current.set(fingerprint, key);
    try {
      const receipt = receiptSchema.parse(await request("/api/command", authorization, undefined, { scopeId, key, command }));
      if (receipt.kind === "denied") { uncertainCommands.current.delete(fingerprint); setError(receipt.message ?? "The server denied this action."); return false; }
      await reload();
      uncertainCommands.current.delete(fingerprint);
      if (receipt.taskId) setTaskId(receipt.taskId);
      setNotice(receipt.message ?? (receipt.kind === "duplicate" ? "This action was already accepted." : receipt.kind === "ignored" ? "No change was made." : "Saved. Check the updated task or configuration below."));
      return receipt.kind !== "ignored";
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : "The request outcome is uncertain. Refresh saved state before repeating this action."); return false; }
    finally { mutationLock.current = false; setBusy(false); }
  };

  const selected = view?.tasks.find(({ task }) => task.id === taskId) ?? (!taskId ? view?.tasks[0] : undefined);
  const manage = view?.role === "owner" || view?.role === "manager";
  const refresh = () => { setError(""); void reload().catch(cause => setError(cause instanceof Error ? cause.message : "Refresh failed.")); };

  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    {fixture && <div className="simulation"><strong>SIMULATED</strong><span>Invented local data. No live model, Telegram delivery, or GitHub action.</span><label>Preview actor <select value={actor} disabled={busy} onChange={event => { setTaskId(""); setScopeId(""); setActor(event.target.value); }}>{actors.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>}
    <div className="app-shell">
      <header className="app-header"><button className="brand" type="button" aria-label="Asmo Tag tasks" onClick={() => setSection("task")}>asmo tag<span>ASMO AI</span></button><div className="header-tools">{session && <label><span className="sr-only">Current scope</span><select value={scopeId} disabled={busy} onChange={event => { setTaskId(""); setScopeId(event.target.value); }}>{!session.scopes.some(scope => scope.id === scopeId) && scopeId && <option value={scopeId}>Unavailable scope</option>}{session.scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.name} · {scope.kind}</option>)}</select></label>}{view && <button disabled={busy} onClick={refresh}>Refresh</button>}</div></header>
      {view && <nav className="top-nav" aria-label="Main navigation"><button aria-current={section === "task" ? "page" : undefined} onClick={() => setSection("task")}>Tasks</button><button aria-current={section === "configure" ? "page" : undefined} onClick={() => setSection("configure")}>Configure</button>{manage && <button aria-current={section === "admin" ? "page" : undefined} onClick={() => setSection("admin")}>Administration</button>}<span className="role-label">{view.role}</span></nav>}
      <main id="main" tabIndex={-1}>
        {error && <div className="message error" role="alert"><p>{error}</p><button disabled={busy} onClick={() => window.location.reload()}>Reload connection</button></div>}
        {notice && <p className="message" role="status">{notice}</p>}
        {busy && <p className="working" role="status">Saving. Do not repeat this action.</p>}
        {loading && <p className="empty" role="status">Loading authorized records…</p>}
        {launch && <section className="launch"><h1>Open Asmo Tag from Telegram</h1><p>Use Configure or the task link in your Telegram conversation. The server verifies your Telegram identity and current access.</p>{mode === "fixture" && <p>A separate local preview is available with invented data. <a href="/?fixture=1">Open explicit fixture preview</a>.</p>}{mode === "live" && query.get("fixture") === "1" && <p>Fixture preview is unavailable on this live server.</p>}</section>}
        {session && !session.scopes.length && <section className="empty"><h1>No authorized scopes</h1><p>Add Asmo Tag to a group and complete verified setup in Telegram.</p></section>}
        {view && !loading && section === "task" && <div className="task-layout"><aside className="task-list"><div className="section-heading"><h2>Shared work</h2><span>{view.tasks.length}</span></div>{view.tasks.length === 0 ? <p className="empty">No tasks yet. Tag Asmo in Telegram or start scoped work below.</p> : view.tasks.map(item => <button className="task-row" key={item.task.id} aria-pressed={selected?.task.id === item.task.id} onClick={() => setTaskId(item.task.id)}><span className="mono">{item.task.id}</span><strong>{item.task.instruction}</strong><span>{stateName(item.task.state)}</span></button>)}<StartTask busy={busy} mutate={mutate} /><p className="context-note">Captured since {date(view.scope.collectedSince)}. Older Telegram history is unavailable unless supplied through an approved source.</p></aside><div className="task-inspector">{selected ? <TaskInspector item={selected} scope={view.scope} manager={Boolean(manage)} busy={busy} fixture={fixture} mutate={mutate} configure={() => setSection("configure")} /> : <section className="empty"><h1>{taskId ? "Task unavailable" : "Your conversation stays in Telegram"}</h1><p>{taskId ? "Select an accessible task from this scope." : "Select a task to inspect its findings, sources, actions, and progress."}</p></section>}</div></div>}
        {view && !loading && section === "configure" && <section className="settings"><div className="page-heading"><div><h1>Configure {view.scope.name}</h1><p>Changes apply to this {view.scope.kind}.</p></div></div><nav className="settings-nav" aria-label="Configuration tabs">{(["general", "tools", "memory", "routines"] as const).map(item => <button key={item} aria-current={tab === item ? "page" : undefined} onClick={() => setTab(item)}>{item === "tools" ? "Tools and access" : stateName(item)}</button>)}</nav>{tab === "general" && <General view={view} />}{tab === "tools" && <><Connections key={`${scopeId}:${authorization}`} view={view} authorization={authorization!} manager={Boolean(manage)} fixture={fixture} reload={reload} /><Tools view={view} busy={busy} mutate={mutate} manager={Boolean(manage)} /></>}{tab === "memory" && <Memories view={view} busy={busy} mutate={mutate} manager={Boolean(manage)} />}{tab === "routines" && <Routines view={view} busy={busy} mutate={mutate} manager={Boolean(manage)} />}</section>}
        {view && !loading && section === "admin" && manage && <Administration view={view} busy={busy} mutate={mutate} />}
      </main>
      <footer className="app-footer"><span>Asmo Tag / Asmo AI</span><span>{fixture ? "Fixture preview" : "Telegram team agent"}</span></footer>
    </div>
  </>;
}

function StartTask({ busy, mutate }: { busy: boolean; mutate: Mutate }) {
  const [text, setText] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); if (await mutate({ kind: "start", instruction: text.trim(), topicId: null })) setText(""); };
  return <form className="compact-form" onSubmit={event => void submit(event)}><label htmlFor="new-task">Start scoped work</label><textarea id="new-task" required maxLength={16000} value={text} onChange={event => setText(event.target.value)} placeholder="What should Asmo do?" /><button className="primary" disabled={busy || !text.trim()}>Start task</button></form>;
}

function TaskInspector({ item, scope, manager, busy, fixture, mutate, configure }: { item: TaskView; scope: Scope; manager: boolean; busy: boolean; fixture: boolean; mutate: Mutate; configure: () => void }) {
  const [steering, setSteering] = useState("");
  const { task } = item;
  useEffect(() => setSteering(""), [task.id]);
  const pending = item.approvals.filter(approval => approval.state === "pending");
  const submit = async (event: FormEvent) => { event.preventDefault(); if (await mutate({ kind: "steer", taskId: task.id, text: steering.trim() })) setSteering(""); };
  return <article key={task.id}>
    <div className="task-meta"><span className="mono">{task.id}</span><span>{scope.name}{task.topicId !== null ? ` · Topic ${task.topicId}` : ""}</span><button className="text-button" onClick={configure}>Configure</button></div>
    <h1 className="task-title">{task.instruction}</h1>
    <div className="task-status"><strong>{stateName(task.state)}</strong><span>Requested by {task.requesterId} · {date(task.createdAt)}</span></div>
    {task.reason && <p className="message">{task.reason}</p>}
    <div className="action-row">{["queued", "running", "waiting_for_input", "waiting_for_approval", "blocked"].includes(task.state) && <button disabled={busy} onClick={() => void mutate({ kind: "stop", taskId: task.id })}>Stop task</button>}{["paused", "blocked"].includes(task.state) && <button disabled={busy} onClick={() => void mutate({ kind: "resume", taskId: task.id })}>Resume task</button>}{!["completed", "canceled", "failed"].includes(task.state) && <button disabled={busy} onClick={() => void mutate({ kind: "cancel", taskId: task.id })}>Cancel pending work</button>}</div>
    <section className="content-section"><div className="section-heading"><h2>Findings</h2><span>{task.result?.sourceIds.length ?? 0} cited sources</span></div>{task.result ? <><p className="prose">{task.result.text}</p>{task.result.sourceIds.length > 0 && <div className="source-links">{task.result.sourceIds.map(sourceId => item.sources.some(source => source.id === sourceId) ? <a key={sourceId} href={`#source-${encodeURIComponent(sourceId)}`}>{sourceId}</a> : <span key={sourceId} className="muted">{sourceId} · Source unavailable</span>)}</div>}{task.result.limitations.length > 0 && <div className="limitations"><h3>Limitations</h3><ul>{task.result.limitations.map((text, index) => <li key={`${index}-${text}`}>{text}</li>)}</ul></div>}</> : <p className="muted">No final findings yet. Inspect the work log for saved progress.</p>}</section>
    {pending.map(approval => { const effect = item.effects.find(value => value.id === approval.effectId); return <section className="approval-review" key={approval.id}><div className="section-heading"><h2>Exact action review</h2><span>{date(approval.expiresAt)}</span></div>{effect ? <EffectPreview effect={effect} fixture={fixture} /> : <p className="message">The action record is unavailable. Refresh before deciding.</p>}<dl className="detail-grid"><div><dt>Approval</dt><dd className="mono">{approval.id}</dd></div><div><dt>Revision hash</dt><dd className="mono wrap">{approval.hash}</dd></div></dl><p className="muted small">Manager or owner approval. This decision covers the saved action above only. The server rechecks its current revision and access.</p><div className="action-row"><button className="primary" disabled={busy || !manager || !effect || approval.expiresAt <= Date.now()} onClick={() => void mutate({ kind: "decide", approvalId: approval.id, decision: "approve" })}>Approve exact action</button><button disabled={busy || !manager || !effect} onClick={() => void mutate({ kind: "decide", approvalId: approval.id, decision: "deny" })}>Deny</button></div>{!manager && <p className="small muted">A manager or owner must make this decision.</p>}{approval.expiresAt <= Date.now() && <p className="small muted">This approval has expired. Request a fresh action review.</p>}</section>; })}
    <section className="content-section"><div className="section-heading"><h2>Effects</h2><span>{item.effects.length}</span></div>{!item.effects.length && <p className="muted">No connector actions recorded.</p>}{item.effects.map(effect => <details className={`record ${effect.state === "unknown" ? "unknown" : ""}`} key={effect.id} open={effect.state === "unknown"}><summary><span>{stateName(effect.call.name)}</span><strong>{stateName(effect.state)}</strong></summary>{effect.state === "unknown" && <p className="message">Unresolved effect. A write may have reached the provider. The backend must reconcile it before retrying.</p>}<EffectPreview effect={effect} fixture={fixture} /></details>)}</section>
    <section className="content-section"><div className="section-heading"><h2>Sources</h2><span>{item.sources.length} authorized records</span></div>{item.sources.length === 0 && <p className="muted">No captured evidence is attached. Missing history is not proof that an event did not occur.</p>}{item.sources.map(source => <details className="record" id={`source-${encodeURIComponent(source.id)}`} key={source.id}><summary><span className="mono">{source.id}</span><span>{stateName(source.kind)} · Revision {source.revision}</span></summary><p className="prose">{source.text}</p><p className="small muted">Captured {date(source.capturedAt)}{source.messageId !== null ? ` · Telegram message ${source.messageId}` : ""}</p></details>)}</section>
    <section className="content-section"><div className="section-heading"><h2>Work log</h2><span>Saved event order</span></div>{item.events.length === 0 && <p className="muted">No events recorded.</p>}<ol className="event-log">{item.events.map(event => <li key={event.id}><div><time dateTime={new Date(event.at).toISOString()}>{date(event.at)}</time><h3>{stateName(event.kind)}</h3>{event.actorId && <span className="small muted">Actor {event.actorId}</span>}</div><details><summary>Event details</summary><pre>{JSON.stringify(event.detail, null, 2)}</pre></details></li>)}</ol></section>
    {task.state !== "canceled" && <form className="steer-form" onSubmit={event => void submit(event)}><label htmlFor="steer">Continue or steer this task</label><textarea id="steer" value={steering} onChange={event => setSteering(event.target.value)} maxLength={16000} required placeholder="Add evidence or change the next step." /><p className="small muted">A new instruction cannot undo an action already dispatched.</p><button disabled={busy || !steering.trim()}>Send instruction</button></form>}
    <dl className="detail-grid bottom-details"><div><dt>Task allowance</dt><dd>{dollars(task.budgetMicros)}{fixture ? " · Simulated" : ""}</dd></div><div><dt>Model turns</dt><dd>{task.turns} / {task.maxTurns}</dd></div><div><dt>Task revision</dt><dd>{task.revision}</dd></div><div><dt>Policy revision</dt><dd>{scope.policyRevision}</dd></div></dl>
  </article>;
}

function EffectPreview({ effect, fixture }: { effect: Effect; fixture: boolean }) {
  const url = !fixture ? secureUrl(effect.url) : null;
  return <div className="effect-preview"><dl className="detail-grid"><div><dt>Tool</dt><dd>{effect.call.name}</dd></div><div><dt>Resource</dt><dd className="mono">{"repository" in effect.call.input ? effect.call.input.repository : "pageId" in effect.call.input ? effect.call.input.pageId : effect.call.input.query}</dd></div><div><dt>Task / policy / grant revisions</dt><dd>{effect.taskRevision} / {effect.policyRevision} / {effect.grantRevision}</dd></div><div><dt>Effect ID</dt><dd className="mono">{effect.id}</dd></div></dl>{effect.call.name === "github_create_issue" && <><h3>{effect.call.input.title}</h3><p className="prose issue-body">{effect.call.input.body}</p><p className="small">Labels: {effect.call.input.labels.join(", ") || "None"}</p><p className="small muted">Creates one issue in the repository shown. Repository access determines its audience. No merge or deployment is authorized.</p></>}{effect.reason && <p className="message">{effect.reason}</p>}{effect.result && <p className="prose">{effect.result}</p>}{effect.providerId && <p className="small mono">Provider object: {effect.providerId}</p>}{url && <a href={url} target="_blank" rel="noopener noreferrer">Open provider result</a>}{fixture && effect.url && <p className="small muted">Simulated result URL: {effect.url}</p>}</div>;
}

function General({ view }: { view: WorkspaceView }) {
  return <section className="content-section"><h2>Group context</h2><dl className="setting-list"><div><dt>Collection</dt><dd>{view.scope.active ? "Active" : "Inactive"}</dd></div><div><dt>Context captured since</dt><dd>{date(view.scope.collectedSince)}</dd></div><div><dt>Workspace memory sharing</dt><dd>{view.scope.workspacePublic ? "Explicitly shared workspace scope" : "Private product scope"}</dd></div><div><dt>Timezone</dt><dd>{view.scope.timezone}</dd></div><div><dt>Automatic replies</dt><dd>Unavailable in this build. Mentions and task replies are supported.</dd></div><div><dt>Policy revision</dt><dd>{view.scope.policyRevision}</dd></div></dl><p className="muted">Telegram topics organize context. They do not create private access boundaries.</p></section>;
}

const connectionsSchema = z.object({ catalog: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), available: z.boolean(), setupRequired: z.boolean() })), connections: z.array(z.object({ id: z.string(), provider: z.string(), accountName: z.string(), status: z.enum(["connected", "disconnected", "needs_reconnect"]), resources: z.array(z.string()) })) });
function Connections({ view, authorization, manager, fixture, reload }: { view: WorkspaceView; authorization: string; manager: boolean; fixture: boolean; reload: () => Promise<void> }) {
  const [data, setData] = useState<z.infer<typeof connectionsSchema> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => { const result = connectionsSchema.parse(await request(`/api/integrations?scope=${encodeURIComponent(view.scope.id)}`, authorization, signal)); if (!signal?.aborted) setData(result); }, [view.scope.id, authorization]);
  useEffect(() => { const abort = new AbortController(); void load(abort.signal).catch(() => { if (!abort.signal.aborted) setError("Cannot load connections. Refresh to try again."); }); return () => abort.abort(); }, [load]);
  const act = async (provider: string, connectionId?: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const result = await request(`/api/integrations/${connectionId ? "disconnect" : "start"}`, authorization, undefined, { scopeId: view.scope.id, ...(connectionId ? { connectionId } : { provider }) });
      if (connectionId) { await load(); await reload(); }
      else { const link = z.object({ authorizationUrl: z.string().url() }).parse(result).authorizationUrl; const url = new URL(link); if (!['github.com', 'api.notion.com'].includes(url.hostname) || url.protocol !== 'https:') throw new Error("Authorization destination rejected"); if (window.Telegram?.WebApp?.openLink) window.Telegram.WebApp.openLink(link); else window.location.assign(link); }
    } catch { setError("Connection failed. Refresh saved state, then try again. Your Asmo operator can check app setup."); }
    finally { lock.current = false; setBusy(false); }
  };
  return <section className="content-section"><div className="section-heading"><h2>Connect your tools</h2><button disabled={busy} onClick={() => { void load().catch(() => setError("Refresh failed.")); }}>Refresh connections</button></div><p>Choose a tool, authorize Asmo, then return here. No API tokens needed.</p><p className="small muted">{view.scope.kind === "dm" ? "Only you can use this private chat's connections." : "Managers connect shared tools for this group. Members can use the granted resources. GitHub writes still need approval."}</p>{fixture && <p className="message">Preview only. Connecting external accounts is disabled.</p>}{error && <p role="alert" className="message">{error}</p>}{!data && !error && <p>Loading connections…</p>}{data?.catalog.map(item => { const connection = data.connections.find(value => value.provider === item.id && value.status !== "disconnected"); return <div className="tool-record" key={item.id}><div className="section-heading"><h3>{item.name}</h3><span>{connection ? stateName(connection.status) : item.available ? "Available" : ["mcp", "plugin"].includes(item.id) ? "Planned" : "Operator setup needed"}</span></div><p>{item.description}</p>{connection && <><p>{connection.accountName}</p><p className="small muted">Access: {connection.resources.join(", ") || "Selected resources at the provider"}</p></>}{manager && <div className="action-row"><button disabled={busy || fixture || !item.available} onClick={() => void act(item.id)}>{connection ? "Reconnect" : "Connect"}</button>{connection && <button disabled={busy || fixture} onClick={() => void act(item.id, connection.id)}>Disconnect</button>}</div>}{!manager && <p className="small muted">Ask a group manager to connect or change access.</p>}</div>; })}</section>;
}

function Tools({ view, busy, mutate, manager }: { view: WorkspaceView; busy: boolean; mutate: Mutate; manager: boolean }) {
  const [revoking, setRevoking] = useState<string | null>(null);
  return <section className="content-section"><h2>Approved tools</h2>{view.grants.length === 0 && <p className="empty">No connector resources are granted to this scope.</p>}{view.grants.map(grant => <div className="tool-record" key={grant.id}><div className="section-heading"><h3 className="mono">{grant.kind === "notion_scope" ? "Notion selected pages" : grant.repository}</h3><span>{grant.active ? "Active" : "Revoked"}</span></div><dl className="setting-list"><div><dt>Read resources</dt><dd>{grant.read ? "Allowed" : "Denied"}</dd></div><div><dt>Create issue</dt><dd>{grant.kind !== "notion_scope" && grant.write ? "Manager-reviewed write" : "Denied"}</dd></div><div><dt>Grant revision</dt><dd>{grant.revision}</dd></div></dl>{manager && grant.active && (revoking === grant.id ? <div className="confirmation"><p>Revoke this scope's access to {grant.kind === "notion_scope" ? "Notion selected pages" : grant.repository}? Pending approvals and future calls will lose this grant.</p><div className="action-row"><button disabled={busy} onClick={() => { void mutate({ kind: "revoke_grant", grantId: grant.id }).then(ok => { if (ok) setRevoking(null); }); }}>Confirm revocation</button><button disabled={busy} onClick={() => setRevoking(null)}>Keep access</button></div></div> : <button disabled={busy} onClick={() => setRevoking(grant.id)}>Revoke grant</button>)}</div>)}<div className="unavailable"><h3>Not enabled in this build</h3><p>Sandboxed code work, draft PRs, custom MCP servers, and plugins need separate implementations and acceptance gates.</p></div></section>;
}

function MemoryRecord({ memory, busy, mutate }: { memory: Memory; busy: boolean; mutate: Mutate }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.content);
  const [forgetting, setForgetting] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (await mutate({ kind: "correct_memory", memoryId: memory.id, expectedRevision: memory.revision, content: text.trim() })) setEditing(false); };
  return <div className="memory-record"><div className="section-heading"><span className="mono">{memory.id} · Revision {memory.revision}</span><span>{stateName(memory.state)}</span></div>{editing ? <form onSubmit={event => void submit(event)}><label htmlFor={`edit-${memory.id}`}>Correct this note</label><textarea id={`edit-${memory.id}`} required maxLength={4000} value={text} onChange={event => setText(event.target.value)} /><div className="action-row"><button disabled={busy || !text.trim()}>Save correction</button><button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div></form> : <p className="prose">{memory.content}</p>}<p className="small muted">Evidence: {memory.evidenceIds.join(", ") || "No source IDs recorded"}</p>{!editing && ["active", "candidate"].includes(memory.state) && <div className="action-row"><button disabled={busy} onClick={() => { setText(memory.content); setEditing(true); }}>Correct</button>{memory.state === "candidate" && <><button disabled={busy} onClick={() => void mutate({ kind: "set_memory", memoryId: memory.id, state: "active" })}>Accept candidate</button><button disabled={busy} onClick={() => void mutate({ kind: "set_memory", memoryId: memory.id, state: "rejected" })}>Reject</button></>}<button disabled={busy} onClick={() => setForgetting(true)}>Forget note</button></div>}{forgetting && <div className="confirmation"><p>Remove this note from future retrieval? Its saved revision stays in the audit history.</p><div className="action-row"><button disabled={busy} onClick={() => { void mutate({ kind: "set_memory", memoryId: memory.id, state: "invalidated" }).then(ok => { if (ok) setForgetting(false); }); }}>Confirm forget</button><button disabled={busy} onClick={() => setForgetting(false)}>Keep note</button></div></div>}</div>;
}

function Memories({ view, busy, mutate, manager }: { view: WorkspaceView; busy: boolean; mutate: Mutate; manager: boolean }) {
  const [text, setText] = useState("");
  const [evidence, setEvidence] = useState("");
  const [sourceIds, setSourceIds] = useState("");
  const [confirm, setConfirm] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (await mutate({ kind: "remember", content: text.trim(), evidenceIds: ids(evidence), candidate: false })) { setText(""); setEvidence(""); } };
  return <section className="content-section"><div className="section-heading"><h2>Scoped memory</h2><span>{view.memories.length} notes</span></div><p className="muted">Notes belong to this scope. Automatic memory is not enabled. Inspect and correct saved facts here.</p>{view.memories.length === 0 && <p className="empty">No memory saved yet.</p>}{view.memories.map(memory => <MemoryRecord memory={memory} key={memory.id} busy={busy} mutate={mutate} />)}<form className="section-form" onSubmit={event => void submit(event)}><h3>Remember a stable fact</h3><label htmlFor="memory-content">Fact or instruction</label><textarea id="memory-content" required maxLength={4000} value={text} onChange={event => setText(event.target.value)} /><label htmlFor="memory-evidence">Evidence source IDs, separated by commas</label><input id="memory-evidence" value={evidence} onChange={event => setEvidence(event.target.value)} placeholder="Optional" /><button disabled={busy || !text.trim()}>Save memory</button></form>{manager && <div className="section-form"><h3>Forget captured sources</h3><p className="small muted">Invalidates selected source records and dependent retrieval. This is not a promise to remove provider copies or every backup.</p><label htmlFor="forget-sources">Source IDs in this scope</label><input id="forget-sources" value={sourceIds} disabled={busy || confirm} onChange={event => setSourceIds(event.target.value)} /><button disabled={busy || ids(sourceIds).length === 0 || confirm} onClick={() => setConfirm(true)}>Review source removal</button>{confirm && <div className="confirmation"><p>Forget these exact sources: <span className="mono">{ids(sourceIds).join(", ")}</span></p><div className="action-row"><button disabled={busy} onClick={() => { void mutate({ kind: "forget_sources", sourceIds: ids(sourceIds) }).then(ok => { if (ok) { setConfirm(false); setSourceIds(""); } }); }}>Confirm removal</button><button disabled={busy} onClick={() => setConfirm(false)}>Cancel</button></div></div>}</div>}</section>;
}

function localDatetimeValue(instant: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(instant));
    const read = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? "";
    return `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}`;
  } catch {
    return new Date(instant).toISOString().slice(0, 16);
  }
}

function routineDate(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone }).format(at) + ` (${timeZone})`;
  } catch {
    return date(at);
  }
}

function Routines({ view, busy, mutate, manager }: { view: WorkspaceView; busy: boolean; mutate: Mutate; manager: boolean }) {
  const [instruction, setInstruction] = useState("");
  const [timezone, setTimezone] = useState(view.scope.timezone);
  const [next, setNext] = useState(() => localDatetimeValue(Date.now() + 86400000, view.scope.timezone));
  useEffect(() => {
    setTimezone(view.scope.timezone);
    setNext(localDatetimeValue(Date.now() + 86400000, view.scope.timezone));
  }, [view.scope.id, view.scope.timezone]);
  const [budget, setBudget] = useState("0.50");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError("");
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); const nextAt = wallClockInstant(next, timezone); if (nextAt <= Date.now()) throw new Error("Choose a future next run."); if (await mutate({ kind: "create_routine", instruction: instruction.trim(), timezone, nextAt, intervalMs: 86400000, budgetMicros: amount(budget) })) setInstruction(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "Check the schedule and allowance."); }
  };
  return <section className="content-section"><div className="section-heading"><h2>Standing work</h2><span>{view.routines.length} routines</span></div>{!view.routines.length && <p className="empty">No routines configured.</p>}{view.routines.map(routine => <div className="routine-record" key={routine.id}><div className="section-heading"><h3>{routine.instruction}</h3><span>{routine.state}</span></div><dl className="setting-list"><div><dt>Next run</dt><dd>{routineDate(routine.nextAt, routine.timezone)}</dd></div><div><dt>Input timezone</dt><dd>{routine.timezone}</dd></div><div><dt>Interval</dt><dd>{routine.intervalMs / 60000} minutes</dd></div><div><dt>Run allowance</dt><dd>{dollars(routine.budgetMicros)}{view.usage.simulated ? " · Simulated" : ""}</dd></div></dl>{manager && routine.state !== "revoked" && <div className="action-row"><button disabled={busy} onClick={() => void mutate({ kind: "set_routine", routineId: routine.id, state: routine.state === "active" ? "paused" : "active" })}>{routine.state === "active" ? "Pause routine" : "Resume routine"}</button></div>}</div>)}{manager ? <form className="section-form" onSubmit={event => void submit(event)}><h3>Create a routine</h3><label htmlFor="routine-instruction">Standing instruction</label><textarea id="routine-instruction" required maxLength={4000} value={instruction} onChange={event => setInstruction(event.target.value)} /><div className="form-grid"><label>Input timezone<input value={timezone} onChange={event => setTimezone(event.target.value)} required placeholder="Etc/UTC" /></label><label>Next run, local time<input type="datetime-local" value={next} onChange={event => setNext(event.target.value)} required /></label><div><span className="small muted">Frequency</span><p>Daily at a fixed local time</p></div><label>Run allowance, USD<input type="number" min="0" step="0.000001" value={budget} onChange={event => setBudget(event.target.value)} required /></label></div><p className="small muted">Runs at the same local time in the selected timezone, including across daylight saving changes. Uses this scope's shared tools. Personal connectors are unavailable.</p>{error && <p role="alert" className="message">{error}</p>}<button disabled={busy || !instruction.trim()}>Create displayed schedule</button></form> : <p className="muted">Pilot routine changes require a manager or owner.</p>}</section>;
}

function Administration({ view, busy, mutate }: { view: WorkspaceView; busy: boolean; mutate: Mutate }) {
  const [budget, setBudget] = useState(String(view.scope.budgetMicros / 1_000_000));
  const [timezone, setTimezone] = useState(view.scope.timezone);
  const [error, setError] = useState("");
  const [change, setChange] = useState<"active" | "workspacePublic" | null>(null);
  useEffect(() => { setBudget(String(view.scope.budgetMicros / 1_000_000)); setTimezone(view.scope.timezone); setChange(null); }, [view.scope.id, view.scope.budgetMicros, view.scope.timezone]);
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(""); try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); await mutate({ kind: "set_scope", budgetMicros: amount(budget), timezone }); } catch (cause) { setError(cause instanceof Error ? cause.message : "Check these settings."); } };
  return <section className="settings"><div className="page-heading"><h1>Scope administration</h1><span>{view.role} · {view.scope.name}</span></div><section className="content-section"><h2>Allowance and usage</h2><dl className="detail-grid"><div><dt>Spent</dt><dd>{dollars(view.usage.spentMicros)}{view.usage.simulated ? " · Simulated" : ""}</dd></div><div><dt>Reserved</dt><dd>{dollars(view.usage.heldMicros)}</dd></div><div><dt>Scope allowance</dt><dd>{dollars(view.scope.budgetMicros)}</dd></div><div><dt>Policy revision</dt><dd>{view.scope.policyRevision}</dd></div></dl><form className="section-form" onSubmit={event => void submit(event)}><div className="form-grid"><label>Scope allowance, USD<input required type="number" min="0" step="0.000001" value={budget} onChange={event => setBudget(event.target.value)} /></label><label>Timezone<input required value={timezone} onChange={event => setTimezone(event.target.value)} /></label></div>{error && <p className="message" role="alert">{error}</p>}<button disabled={busy}>Save allowance and timezone</button></form></section><section className="content-section"><h2>Scope policy</h2><dl className="setting-list"><div><dt>Collection and work</dt><dd>{view.scope.active ? "Active" : "Inactive"}<button className="text-button" disabled={busy} onClick={() => setChange("active")}>{view.scope.active ? "Deactivate" : "Activate"}</button></dd></div>{view.scope.kind === "group" && <div><dt>Workspace memory sharing</dt><dd>{view.scope.workspacePublic ? "Explicitly shared" : "Private"}{view.role === "owner" && <button className="text-button" disabled={busy} onClick={() => setChange("workspacePublic")}>Change</button>}</dd></div>}</dl>{change && (change !== "workspacePublic" || view.role === "owner") && <div className="confirmation"><p>{change === "active" ? view.scope.active ? "Deactivate this scope? New work and collection will be blocked." : "Activate this scope under its saved collection and access policy?" : view.scope.workspacePublic ? "Make future workspace-memory sharing private? Existing shared facts require separate review." : "Allow this group's approved facts to become workspace memory? Other permitted workspace scopes can read those notes."}</p><div className="action-row"><button disabled={busy} onClick={() => { void mutate(change === "active" ? { kind: "set_scope", active: !view.scope.active } : { kind: "set_scope", workspacePublic: !view.scope.workspacePublic }).then(ok => { if (ok) setChange(null); }); }}>Confirm policy change</button><button disabled={busy} onClick={() => setChange(null)}>Cancel</button></div></div>}</section><section className="unavailable"><h2>Owner operations</h2><p>Workspace-wide budget editing, audit export, payment settings, and full retained-copy deletion are not exposed by this build's API. Task-level audit records are available in each task inspector.</p></section></section>;
}

const container = document.getElementById("root");
if (!container) throw new Error("The Asmo Tag root element is missing.");
createRoot(container).render(<React.StrictMode><App /></React.StrictMode>);
