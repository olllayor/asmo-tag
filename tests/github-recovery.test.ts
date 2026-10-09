import { fork } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { NormalizedUpdate, Scope } from '../src/core.js';
import { openGitHubProof } from '../scripts/github-crash-worker.js';
import type { ProofConfiguration } from '../scripts/github-crash-worker.js';

const issuePayload = z.object({ title: z.string(), body: z.string(), labels: z.array(z.string()) }).strict();
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const issuePath = '/api.github.com/repos/asmo-proof/recovery/issues';

describe('Approved GitHub writes and receipt recovery with isolated HTTP', () => {
  let directory: string;
  let now: number;
  let config: ProofConfiguration;
  let runtime: Awaited<ReturnType<typeof openGitHubProof>>;
  let runtimeOpen = false;
  let server: ReturnType<typeof createServer>;
  let scope: Scope;
  let botId: string;
  let connectionId: string;
  let responseMode: 'reply' | 'hold' | 'lose';
  let accepted: (() => void) | undefined;
  let child: ReturnType<typeof fork> | undefined;
  let childExit: Promise<NodeJS.Signals | null> | undefined;
  let requests: { method: string; path: string; body: unknown }[];
  let issues: (z.infer<typeof issuePayload> & { id: number; number: number; html_url: string })[];
  let failures: string[];

  beforeEach(async () => {
    runtimeOpen = false;
    directory = await mkdtemp(join(tmpdir(), 'asmo-github-proof-'));
    now = Date.now(); requests = []; issues = []; failures = []; responseMode = 'reply'; accepted = undefined; child = undefined; childExit = undefined;
    server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        const method = request.method ?? 'GET';
        const path = request.url ?? '';
        requests.push({ method, path, body });
        let result: unknown;
        if (path === '/github.com/login/oauth/access_token' && method === 'POST') {
          const oauth = z.object({ client_id: z.literal('proof-client'), client_secret: z.literal('proof-client-secret'), code: z.literal('proof-code'), code_verifier: z.string().min(43), redirect_uri: z.literal('https://asmo.test/connectors/github/callback') }).strict().parse(body);
          expect(oauth.code_verifier).toMatch(/^[A-Za-z0-9_-]+$/);
          result = { access_token: 'proof-user-token', refresh_token: 'proof-refresh-token', expires_in: 3600, refresh_token_expires_in: 7200 };
        } else if (path === '/api.github.com/app/installations/42' || path === '/api.github.com/app/installations/42/access_tokens') {
          const jwt = request.headers.authorization?.replace(/^Bearer /, '').split('.');
          if (!jwt || jwt.length !== 3) throw new Error('Missing synthetic app JWT');
          expect(verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), keys.publicKey, Buffer.from(jwt[2]!, 'base64url'))).toBe(true);
          expect(JSON.parse(Buffer.from(jwt[1]!, 'base64url').toString())).toMatchObject({ iss: '123' });
          if (method === 'GET' && path.endsWith('/42')) result = { id: 42, app_id: 123, suspended_at: null, account: { login: 'asmo-proof', type: 'Organization' } };
          else {
            expect(method).toBe('POST');
            expect(body).toEqual({ repository_ids: [7], permissions: { issues: 'write', metadata: 'read' } });
            result = { token: 'proof-installation-token', expires_at: new Date(now + 3600000).toISOString() };
          }
        } else if (path === '/api.github.com/user/installations/42/repositories?per_page=100&page=1' && method === 'GET') {
          expect(request.headers.authorization).toBe('Bearer proof-user-token');
          result = { total_count: 1, repositories: [{ id: 7, full_name: 'asmo-proof/recovery' }] };
        } else if (path.startsWith(issuePath)) {
          expect(request.headers.authorization).toBe('Bearer proof-installation-token');
          expect(request.headers.accept).toBe('application/vnd.github+json');
          if (method === 'POST' && path === issuePath) {
            const issue = { ...issuePayload.parse(body), id: 9001 + issues.length, number: 17 + issues.length, html_url: `https://github.com/asmo-proof/recovery/issues/${17 + issues.length}` };
            // Every POST creates a new issue. The provider does no deduplication.
            issues.push(issue); accepted?.();
            if (responseMode === 'hold') return;
            if (responseMode === 'lose') { response.destroy(); return; }
            result = issue;
          } else {
            expect(method).toBe('GET');
            expect(path).toBe(`${issuePath}?state=all&per_page=100&page=1`);
            result = issues;
          }
        } else throw new Error(`Unexpected proof request ${method} ${path}`);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } catch (error) { failures.push(String(error)); response.writeHead(500).end('Proof protocol failure'); }
    });
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback address missing');
    config = { databasePath: join(directory, 'proof.sqlite'), workspaceId: randomUUID(), origin: `http://127.0.0.1:${address.port}`, now, vaultKey: randomBytes(32).toString('base64'), github: { appId: '123', slug: 'asmo-proof', clientId: 'proof-client', clientSecret: 'proof-client-secret', privateKey, redirectUri: 'https://asmo.test/connectors/github/callback' } };
    runtime = await openGitHubProof(config, () => now);
    runtimeOpen = true;
    botId = randomUUID();
    scope = { id: randomUUID(), workspaceId: config.workspaceId, name: 'Disposable GitHub proof', kind: 'group', chatId: `-${randomUUID()}`, ownerId: null, active: true, workspacePublic: false, timezone: 'UTC', policyRevision: 1, collectedSince: now, budgetMicros: 100000 };
    await runtime.store.seed({ botId, workspaceId: config.workspaceId, name: 'Synthetic proof', ownerId: 'manager', budgetMicros: 200000, scopes: [scope], memberships: [{ scopeId: scope.id, userId: 'manager', role: 'owner' }, { scopeId: scope.id, userId: 'member', role: 'member' }], grants: [] });
    const binding = { workspaceId: config.workspaceId, scopeId: scope.id, kind: 'shared' as const, ownerId: null };
    const install = await runtime.integrations.start('github', 'manager', binding);
    const oauth = await runtime.integrations.callback('github', { state: new URL(install.authorizationUrl).searchParams.get('state')!, installationId: '42' });
    if (oauth.status !== 'redirect') throw new Error('Expected OAuth redirect');
    const linked = await runtime.integrations.callback('github', { state: new URL(oauth.authorizationUrl).searchParams.get('state')!, code: 'proof-code' });
    if (linked.status !== 'connected') throw new Error('Expected connected GitHub');
    connectionId = linked.connection.id;
    expect(linked.connection.credentialVersion).toBe(1);
    await runtime.store.connectRepositoryGrants(scope.id, 'manager', connectionId, 1, linked.connection.resources);
  });

  afterEach(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (childExit) await childExit;
      await closeRuntime();
    } finally {
      if (server) await new Promise<void>(accept => { server.close(() => accept()); server.closeAllConnections(); });
      await rm(directory, { recursive: true, force: true });
    }
    expect(failures).toEqual([]);
  });

  async function closeRuntime() {
    if (!runtimeOpen) return;
    runtimeOpen = false;
    try { runtime.integrations.close(); } finally { await runtime.store.close(); }
  }

  function callback(approvalId: string, updateId: number, action = 'approve', userId = 'manager'): NormalizedUpdate {
    return { kind: 'callback', botId, updateId, chatId: scope.chatId, userId, messageId: 1, data: `${action}:${approvalId}` };
  }
  const posts = () => requests.filter(request => request.method === 'POST' && request.path === issuePath);
  const gets = () => requests.filter(request => request.method === 'GET' && request.path.startsWith(issuePath));
  async function draft() {
    const started = await runtime.store.command({ scopeId: scope.id, userId: 'member', key: 'start-proof', command: { kind: 'start', instruction: 'Create the exact approved proof issue', topicId: null } });
    if (!started.taskId) throw new Error('Proof task missing');
    expect(await runtime.worker.step('proof-model', undefined, 'model')).toBe(true);
    const view = await runtime.store.task(scope.id, 'member', started.taskId);
    const effect = view.effects[0]; const approval = view.approvals[0];
    if (!effect || !approval) throw new Error('Prepared effect or approval missing');
    expect(effect.call).toEqual({ id: 'proof-write', name: 'github_create_issue', input: { repository: 'asmo-proof/recovery', title: 'Exact recovery issue', body: 'Preserve this exact reviewed body.', labels: ['bug'] } });
    expect(effect.state).toBe('waiting_for_approval');
    expect(effect.connectionId).toBe(connectionId); expect(effect.connectionVersion).toBe(1);
    expect(approval.hash).toBe(effect.hash);
    expect(effect.hash).toBe('f45e0cbca0ef241fd49bb0176f0a16d1ee5003e3e622516f5c5c5105001fac93');
    expect(await runtime.worker.step('proof-unapproved', undefined, 'effect')).toBe(false);
    expect(posts()).toHaveLength(0); expect(gets()).toHaveLength(0);
    return { taskId: started.taskId, effect, approval };
  }
  async function disconnect() {
    return runtime.integrations.disconnect('manager', { workspaceId: config.workspaceId, scopeId: scope.id, kind: 'shared', ownerId: null }, connectionId);
  }
  async function loseReceipt(approvalId: string) {
    expect((await runtime.store.ingest(callback(approvalId, 1))).kind).toBe('accepted');
    responseMode = 'lose';
    expect(await runtime.worker.step('proof-lost-response', undefined, 'effect')).toBe(true);
    expect(posts()).toHaveLength(1); expect(issues).toHaveLength(1);
    now += 60001;
  }

  it('recovers the exact external issue after SIGKILL without another POST', async () => {
    const prepared = await draft();
    expect((await runtime.store.ingest(callback(prepared.approval.id, 1, 'approve', 'member'))).kind).toBe('denied');
    const approve = callback(prepared.approval.id, 2);
    expect((await runtime.store.ingest(approve)).kind).toBe('accepted');
    expect((await runtime.store.ingest(approve)).kind).toBe('duplicate');
    expect((await runtime.store.ingest(callback(prepared.approval.id, 3))).kind).toBe('duplicate');
    responseMode = 'hold';
    const applied = new Promise<void>(resolve => { accepted = resolve; });
    child = fork(fileURLToPath(new URL('../scripts/github-crash-worker.ts', import.meta.url)), [], { execArgv: ['--import', 'tsx'], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    let rejectEarly!: (error: Error) => void;
    const earlyExit = new Promise<never>((_resolve, reject) => { rejectEarly = reject; });
    childExit = new Promise(resolve => {
      child!.once('error', error => { rejectEarly(error); resolve(null); });
      child!.once('exit', (code, signal) => { rejectEarly(new Error(`Proof child exited ${code}/${signal}: ${stderr}`)); resolve(signal); });
    });
    child.send(config);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([applied, earlyExit, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`POST acceptance timed out: ${stderr}`)), 10000); })]);
      const before = await runtime.store.task(scope.id, 'member', prepared.taskId);
      expect(before.effects[0]).toMatchObject({ state: 'dispatching', providerId: null, url: null, result: null });
      child.kill('SIGKILL');
      expect(await childExit).toBe('SIGKILL');
    } finally { clearTimeout(timer); }
    const identity = createHash('sha256').update(JSON.stringify([prepared.effect.workspaceId, prepared.effect.taskId, prepared.effect.id])).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify([prepared.effect.hash, prepared.effect.call.name, prepared.effect.call.input])).digest('hex');
    expect(posts()[0]?.body).toEqual({ title: 'Exact recovery issue', body: `Preserve this exact reviewed body.\n\n<!-- asmo-effect:${identity}:${fingerprint} -->`, labels: ['bug'] });
    await closeRuntime();
    now += 30001;
    runtime = await openGitHubProof(config, () => now);
    runtimeOpen = true;
    expect(await runtime.integrations.list('member', { workspaceId: config.workspaceId, scopeId: scope.id, kind: 'shared', ownerId: null })).toMatchObject([{ id: connectionId, credentialVersion: 1, status: 'connected' }]);
    expect(await runtime.worker.step('proof-recovery', undefined, 'effect')).toBe(true);
    const recovered = await runtime.store.task(scope.id, 'member', prepared.taskId);
    expect(recovered.effects[0]).toMatchObject({ state: 'succeeded', providerId: '9001', url: 'https://github.com/asmo-proof/recovery/issues/17' });
    expect(recovered.events.filter(event => event.kind === 'effect_succeeded')).toHaveLength(1);
    expect(recovered.sources.filter(source => source.kind === 'tool')).toHaveLength(1);
    expect(gets()).toHaveLength(1); expect(posts()).toHaveLength(1); expect(issues).toHaveLength(1);
    expect(requests.filter(request => request.path === '/github.com/login/oauth/access_token')).toHaveLength(1);
    expect(requests.filter(request => request.path.endsWith('/access_tokens'))).toHaveLength(1);
    expect((await runtime.store.ingest(approve)).kind).toBe('duplicate');
    expect((await runtime.store.ingest(callback(prepared.approval.id, 4))).kind).toBe('duplicate');
    expect(await runtime.worker.step('proof-repeated', undefined, 'effect')).toBe(false);
    expect(posts()).toHaveLength(1);
  }, 20000);

  it('denies the write and deduplicates both repeated and fresh callback IDs', async () => {
    const prepared = await draft();
    const deny = callback(prepared.approval.id, 1, 'deny');
    expect((await runtime.store.ingest(deny)).kind).toBe('accepted');
    expect((await runtime.store.ingest(deny)).kind).toBe('duplicate');
    expect((await runtime.store.ingest(callback(prepared.approval.id, 2, 'deny'))).kind).toBe('duplicate');
    expect((await runtime.store.ingest(callback(prepared.approval.id, 3))).kind).toBe('duplicate');
    const view = await runtime.store.task(scope.id, 'member', prepared.taskId);
    expect(view.effects[0]?.state).toBe('denied'); expect(view.approvals[0]?.state).toBe('denied');
    expect(await runtime.worker.step('proof-denied', undefined, 'effect')).toBe(false);
    expect(posts()).toHaveLength(0); expect(gets()).toHaveLength(0);
  });

  it('fences an approved write when its repository grant is revoked before dispatch', async () => {
    const prepared = await draft();
    expect((await runtime.store.ingest(callback(prepared.approval.id, 1))).kind).toBe('accepted');
    const grant = (await runtime.store.view(scope.id, 'manager')).grants[0];
    if (!grant) throw new Error('GitHub grant missing');
    expect((await runtime.store.command({ scopeId: scope.id, userId: 'manager', key: 'revoke-proof', command: { kind: 'revoke_grant', grantId: grant.id } })).kind).toBe('accepted');
    expect(await runtime.worker.step('proof-revoked', undefined, 'effect')).toBe(false);
    const view = await runtime.store.task(scope.id, 'member', prepared.taskId);
    expect(view.effects[0]?.state).toBe('denied'); expect(view.approvals[0]?.state).toBe('invalidated');
    expect(posts()).toHaveLength(0); expect(gets()).toHaveLength(0);
  });

  it('checks the current credential before POST even while the Store grant stays active', async () => {
    const prepared = await draft();
    expect((await runtime.store.ingest(callback(prepared.approval.id, 1))).kind).toBe('accepted');
    expect(await disconnect()).toMatchObject({ status: 'disconnected', credentialVersion: 2 });
    expect((await runtime.store.view(scope.id, 'manager')).grants[0]).toMatchObject({ active: true, connectionVersion: 1 });
    expect(await runtime.worker.step('proof-disconnected', undefined, 'effect')).toBe(true);
    expect((await runtime.store.task(scope.id, 'member', prepared.taskId)).effects[0]?.state).toBe('unknown');
    expect(posts()).toHaveLength(0); expect(gets()).toHaveLength(0);
  });

  it('keeps an applied write unknown after credential disconnect without another POST', async () => {
    const prepared = await draft();
    await loseReceipt(prepared.approval.id);
    expect((await runtime.store.task(scope.id, 'member', prepared.taskId)).effects[0]?.state).toBe('unknown');
    await disconnect();
    expect(await runtime.worker.step('proof-disconnected-recovery', undefined, 'effect')).toBe(true);
    expect((await runtime.store.task(scope.id, 'member', prepared.taskId)).effects[0]).toMatchObject({ state: 'unknown', providerId: null });
    expect(gets()).toHaveLength(0); expect(posts()).toHaveLength(1);
  });

  it('never turns a missing recovery marker into a blind POST', async () => {
    const prepared = await draft();
    await loseReceipt(prepared.approval.id);
    issues[0]!.body = 'The provider body was edited and its marker removed.';
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await runtime.worker.step(`proof-missing-marker-${attempt}`, undefined, 'effect')).toBe(true);
      const view = await runtime.store.task(scope.id, 'member', prepared.taskId);
      expect(view.effects[0]).toMatchObject({ state: 'unknown', providerId: null, result: null });
      expect(view.task.state).toBe('blocked');
      now += 60001;
    }
    expect(gets()).toHaveLength(2); expect(posts()).toHaveLength(1); expect(issues).toHaveLength(1);
  });
});
