import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationService, readIntegrationConfig } from '../src/integrations/index.js';
import type { ConnectionView, IntegrationOptions, IntegrationScope } from '../src/integrations/index.js';
import { createIntegrationNotionReader } from '../src/integrations/notion-reader.js';
import { createIntegrationToolConnector } from '../src/integrations/tool-connector.js';
import type { Effect } from '../src/core.js';
import { connectDatabase, inDatabaseTransaction } from '../src/store/connection.js';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const scope: IntegrationScope = { workspaceId: 'workspace', scopeId: 'group', kind: 'shared', ownerId: null };
const notionPageId = 'aaafedaa-1111-4111-8111-111111111111';
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('connector account linking and credential isolation', () => {
  let directory: string; let now: number; let options: IntegrationOptions; let service: IntegrationService;
  let permitted: boolean; let fetcher: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'asmo-integrations-')); now = Date.UTC(2026, 9, 7); permitted = true;
    fetcher = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url === 'https://api.notion.com/v1/oauth/token') return response({ access_token: 'notion-secret-access', refresh_token: 'notion-secret-refresh', bot_id: 'bot', workspace_id: 'external-workspace', workspace_name: 'Design' });
      if (url === 'https://github.com/login/oauth/access_token') return response({ access_token: 'github-secret-user', expires_in: 28800, refresh_token: 'github-secret-refresh', refresh_token_expires_in: 15811200 });
      if (url === 'https://api.github.com/app/installations/42') return response({ id: 42, app_id: 123, suspended_at: null, account: { login: 'team', type: 'Organization' } });
      if (url.startsWith('https://api.github.com/user/installations/42/repositories')) return response({ total_count: 1, repositories: [{ id: 7, full_name: 'team/project' }] });
      if (url === 'https://api.github.com/app/installations/42/access_tokens') {
        expect(JSON.parse(String(init?.body))).toEqual({ repository_ids: [7], permissions: { issues: 'write', metadata: 'read' } });
        return response({ token: 'github-secret-installation', expires_at: new Date(now + 3_600_000).toISOString() });
      }
      throw new Error('Unexpected mock endpoint');
    });
    options = { databasePath: join(directory, 'database.sqlite'), vaultKey: randomBytes(32).toString('base64'), github: { appId: '123', clientId: 'github-client', clientSecret: 'github-client-secret', privateKey, slug: 'asmo-tag', redirectUri: 'https://asmo.test/connectors/github/callback' }, notion: { clientId: 'notion-client', clientSecret: 'notion-client-secret', redirectUri: 'https://asmo.test/connectors/notion/callback' }, authorize: async () => permitted, fetch: fetcher, clock: () => now };
    service = new IntegrationService(options);
  });
  afterEach(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  const state = (url: string) => new URL(url).searchParams.get('state')!;
  async function notion(target = scope): Promise<ConnectionView> {
    const started = await service.start('notion', 'manager', target);
    const completed = await service.callback('notion', { state: state(started.authorizationUrl), code: 'notion-code' });
    if (completed.status !== 'connected') throw new Error('expected connection');
    return completed.connection;
  }
  async function github(): Promise<ConnectionView> {
    const install = await service.start('github', 'manager', scope);
    expect(new URL(install.authorizationUrl).pathname).toBe('/apps/asmo-tag/installations/new');
    const oauth = await service.callback('github', { state: state(install.authorizationUrl), installationId: '42' });
    if (oauth.status !== 'redirect') throw new Error('expected OAuth redirect');
    expect(new URL(oauth.authorizationUrl).searchParams.get('code_challenge_method')).toBe('S256');
    const complete = await service.callback('github', { state: state(oauth.authorizationUrl), code: 'github-code' });
    if (complete.status !== 'connected') throw new Error('expected connection');
    return complete.connection;
  }
  it('does not claim providers are connected or available without operator configuration', async () => {
    const unconfigured = new IntegrationService({ databasePath: join(directory, 'unconfigured.sqlite'), authorize: options.authorize });
    try {
      expect(unconfigured.catalog().every(item => !item.available)).toBe(true);
      expect(await unconfigured.list('manager', scope)).toEqual([]);
      await expect(unconfigured.start('github', 'manager', scope)).rejects.toThrow('operator setup');
      expect(readIntegrationConfig({})).toEqual({});
      expect(() => readIntegrationConfig({ ASMO_GITHUB_APP_ID: '123' })).toThrow('all connector settings');
      expect(() => readIntegrationConfig({ ASMO_CONNECTOR_VAULT_KEY: 'weak' })).toThrow('32-byte');
    } finally { unconfigured.close(); }
  });
  it('fails closed for saved credentials when the operator removes a provider configuration', async () => {
    const linked = await github();
    const disabled = new IntegrationService({ ...options, github: undefined });
    try {
      expect((await disabled.list('manager', scope))[0]?.status).toBe('needs_reconnect');
      const count = fetcher.mock.calls.length;
      await expect(disabled.withGitHubForEffect({ ...scope, connectionId: linked.id, connectionVersion: linked.credentialVersion }, async () => true)).rejects.toThrow('operator setup');
      expect(fetcher).toHaveBeenCalledTimes(count);
    } finally { disabled.close(); }
  });
  it('rejects forged, wrong-provider, expired, denied, and replayed OAuth states', async () => {
    await expect(service.callback('notion', { state: 'A'.repeat(43), code: 'code' })).rejects.toThrow('invalid or expired');
    const first = await service.start('notion', 'manager', scope);
    await expect(service.callback('github', { state: state(first.authorizationUrl), code: 'code' })).rejects.toThrow('invalid or expired');
    const denied = await service.callback('notion', { state: state(first.authorizationUrl), error: 'access_denied' }).catch(error => error as Error);
    expect(denied).toBeInstanceOf(Error);
    await expect(service.callback('notion', { state: state(first.authorizationUrl), code: 'code' })).rejects.toThrow('invalid or expired');
    const expired = await service.start('notion', 'manager', scope); now += 600_001;
    await expect(service.callback('notion', { state: state(expired.authorizationUrl), code: 'code' })).rejects.toThrow('invalid or expired');
    expect(fetcher).not.toHaveBeenCalled();
    const started = await service.start('notion', 'manager', scope);
    await service.callback('notion', { state: state(started.authorizationUrl), code: 'code' });
    await expect(service.callback('notion', { state: state(started.authorizationUrl), code: 'code' })).rejects.toThrow('invalid or expired');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('checks current authority at start and callback and enforces the private owner', async () => {
    permitted = false;
    await expect(service.start('notion', 'manager', scope)).rejects.toThrow('access denied');
    permitted = true;
    await expect(service.start('notion', 'manager', { ...scope, kind: 'private', ownerId: 'other' })).rejects.toThrow('access denied');
    const started = await service.start('notion', 'manager', scope);
    permitted = false;
    await expect(service.callback('notion', { state: state(started.authorizationUrl), code: 'code' })).rejects.toThrow('access denied');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('encrypts persisted tokens, redacts views, survives restart, and isolates scope credentials', async () => {
    const linked = await notion();
    expect(JSON.stringify(linked)).not.toContain('secret');
    expect(linked.status).toBe('connected');
    expect((await readFile(options.databasePath)).toString()).not.toContain('notion-secret');
    expect(await service.list('manager', { ...scope, scopeId: 'other-group' })).toEqual([]);
    await expect(service.disconnect('manager', { ...scope, scopeId: 'other-group' }, linked.id)).rejects.toThrow('access denied');
    service.close(); service = new IntegrationService(options);
    expect(await service.list('manager', scope)).toEqual([linked]);
    const wrongKey = new IntegrationService({ ...options, vaultKey: randomBytes(32).toString('base64') });
    try { await expect(wrongKey.withCredential({ connectionId: linked.id, credentialVersion: linked.credentialVersion }, 'manager', scope, async () => true)).rejects.toThrow('decrypt'); }
    finally { wrongKey.close(); }
  });
  it('requires OAuth access proof before accepting an installation and restricts minted tokens', async () => {
    const install = await service.start('github', 'manager', scope);
    const oauth = await service.callback('github', { state: state(install.authorizationUrl), installationId: '42' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await service.list('manager', scope)).toEqual([]);
    if (oauth.status !== 'redirect') throw new Error('expected redirect');
    fetcher.mockImplementationOnce(async () => response({ access_token: 'github-secret-user', expires_in: 28800, refresh_token: 'github-secret-refresh', refresh_token_expires_in: 15811200 }))
      .mockImplementationOnce(async () => response({ id: 42, app_id: 123, suspended_at: null, account: { login: 'team', type: 'Organization' } }))
      .mockImplementationOnce(async () => response({ message: 'Not found' }, 404));
    await expect(service.callback('github', { state: state(oauth.authorizationUrl), code: 'code' })).rejects.toThrow('404');
    expect(await service.list('manager', scope)).toEqual([]);
    const linked = await github();
    expect(linked.resources).toEqual(['team/project']);
    expect(JSON.stringify(linked)).not.toContain('secret');
  });
  it('erases credentials and invalidates pending callbacks and stale dispatch leases on disconnect', async () => {
    const linked = await notion();
    const pending = await service.start('notion', 'manager', scope);
    const lease = { connectionId: linked.id, credentialVersion: linked.credentialVersion };
    const disconnected = await service.disconnect('manager', scope, linked.id);
    expect(disconnected.status).toBe('disconnected');
    expect(disconnected.credentialVersion).toBe(linked.credentialVersion + 1);
    await expect(service.withCredential(lease, 'manager', scope, async () => true)).rejects.toThrow('disconnected or changed');
    await expect(service.callback('notion', { state: state(pending.authorizationUrl), code: 'code' })).rejects.toThrow('invalid or expired');
    const inspect = new DatabaseSync(options.databasePath);
    try { expect(inspect.prepare('SELECT secret FROM asmo_integration_connections WHERE id=?').get(linked.id)?.secret).toBeNull(); }
    finally { inspect.close(); }
  });
  it('fences disconnect while OAuth exchange is in flight', async () => {
    const linked = await notion();
    const started = await service.start('notion', 'manager', scope);
    let release!: () => void; let requestStarted!: () => void;
    const requested = new Promise<void>(resolve => { requestStarted = resolve; });
    const delayed = new Promise<void>(resolve => { release = resolve; });
    fetcher.mockImplementationOnce(async () => { requestStarted(); await delayed; return response({ access_token: 'new-secret', refresh_token: 'new-refresh', bot_id: 'bot', workspace_id: 'external' }); });
    const completing = service.callback('notion', { state: state(started.authorizationUrl), code: 'code' });
    await requested; await service.disconnect('manager', scope, linked.id); release();
    await expect(completing).rejects.toThrow('invalidated');
    expect((await service.list('manager', scope))[0]?.status).toBe('disconnected');
  });
  it('refreshes expiring installation and OAuth user tokens once before use', async () => {
    const linked = await github(); now += 9 * 3_600_000;
    const lease = { connectionId: linked.id, credentialVersion: linked.credentialVersion };
    await Promise.all([1, 2].map(() => service.withCredential(lease, 'manager', scope, async credential => {
      expect(credential.provider).toBe('github');
      if (credential.provider === 'github') expect(credential.expiresAt).toBeGreaterThan(now);
    })));
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/access_tokens'))).toHaveLength(2);
    expect(fetcher.mock.calls.filter(([url, init]) => String(url).endsWith('/access_token') && String(init?.body).includes('refresh_token'))).toHaveLength(1);
    expect((await service.list('manager', scope))[0]?.credentialVersion).toBe(linked.credentialVersion);
  });
  it('fails closed when a queued effect has no connection identity or its credential changed', async () => {
    const linked = await github();
    await expect(service.withGitHubForEffect(scope, async () => true)).rejects.toThrow('exact connection');
    const context = { ...scope, connectionId: linked.id, connectionVersion: linked.credentialVersion };
    await service.withGitHubForEffect(context, async (credential, gate) => {
      expect(credential.repositories).toEqual(['team/project']);
      await service.disconnect('manager', scope, linked.id);
      await expect(gate()).rejects.toThrow('disconnected or changed');
    });
    await github();
    await expect(service.withGitHubForEffect(context, async () => true)).rejects.toThrow('authorization changed');
  });
  it('uses the task store file gate so async task transactions cannot deadlock connector reads', async () => {
    const connection = connectDatabase(options.databasePath);
    connection.migrated = true;
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const transaction = inDatabaseTransaction(connection, async () => { entered(); await held; });
    await ready;
    let listed = false;
    const listing = service.list('manager', scope).then(result => { listed = true; return result; });
    await Promise.resolve(); expect(listed).toBe(false); release();
    await transaction; expect(await listing).toEqual([]); connection.close();
  });
  it('reads only Notion-selected pages with bounded fixed-host requests and rejects stale credentials', async () => {
    const linked = await notion();
    const mockPage = { object: 'page', id: notionPageId, url: `https://www.notion.so/${notionPageId.replaceAll('-', '')}`, properties: { Name: { type: 'title', title: [{ plain_text: 'Roadmap' }] } } };
    fetcher.mockImplementation(async (input, init) => {
      expect(init?.redirect).toBe('error'); expect(new URL(String(input)).hostname).toBe('api.notion.com');
      expect(new Headers(init?.headers).get('Notion-Version')).toBe('2026-03-11');
      if (String(input).endsWith('/search')) return response({ results: [mockPage], has_more: false });
      if (String(input).includes('/blocks/')) return response({ results: [{ type: 'paragraph', has_children: true, paragraph: { rich_text: [{ plain_text: 'Team plan' }] } }], has_more: false });
      return response(mockPage);
    });
    const reader = createIntegrationNotionReader(service, { fetch: fetcher });
    const context = { ...scope, connectionId: linked.id, connectionVersion: linked.credentialVersion };
    const searched = await reader.search(context, 'Road', new AbortController().signal);
    expect(searched.pages[0]?.title).toBe('Roadmap');
    const read = await reader.readPage(context, notionPageId, new AbortController().signal);
    expect(read.content).toBe('Team plan'); expect(read.truncated).toBe(true);
    await service.disconnect('manager', scope, linked.id);
    await expect(reader.search(context, 'Road', new AbortController().signal)).rejects.toThrow('authorization changed');
  });
  it('routes approved Notion effects to the selected connection and returns no credentials', async () => {
    const linked = await notion();
    fetcher.mockImplementation(async () => response({ results: [], has_more: false }));
    const effect: Effect = { id: 'effect', workspaceId: scope.workspaceId, scopeId: scope.scopeId, taskId: 'task', call: { id: 'call', name: 'notion_search', input: { query: 'plan' } }, state: 'dispatching', taskRevision: 1, policyRevision: 1, grantRevision: 1, hash: 'hash', result: null, providerId: null, url: null, reason: null, connectionId: linked.id, connectionVersion: linked.credentialVersion };
    const connector = createIntegrationToolConnector(service, { fetch: fetcher });
    const receipt = await connector.invoke(effect, new AbortController().signal);
    expect(JSON.parse(receipt.content)).toMatchObject({ simulated: false, pages: [] });
    expect(JSON.stringify(receipt)).not.toContain('secret');
    await service.disconnect('manager', scope, linked.id);
    const count = fetcher.mock.calls.length;
    await expect(connector.invoke(effect, new AbortController().signal)).rejects.toThrow('authorization changed');
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it('rotates Notion token pairs once on unauthorized reads and fails closed when refresh is revoked', async () => {
    const linked = await notion();
    const reader = createIntegrationNotionReader(service, { fetch: fetcher });
    const context = { ...scope, connectionId: linked.id, connectionVersion: linked.credentialVersion };
    fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/oauth/token')) {
        expect(JSON.parse(String(init?.body))).toEqual({ grant_type: 'refresh_token', refresh_token: 'notion-secret-refresh' });
        return response({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', bot_id: 'bot', workspace_id: 'external-workspace' });
      }
      return new Headers(init?.headers).get('authorization') === 'Bearer rotated-access' ? response({ results: [], has_more: false }) : response({ message: 'unauthorized' }, 401);
    });
    await Promise.all([reader.search(context, 'a', new AbortController().signal), reader.search(context, 'b', new AbortController().signal)]);
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/oauth/token'))).toHaveLength(2); // Initial exchange plus one rotation.
    fetcher.mockImplementation(async () => response({ message: 'revoked' }, 401));
    await expect(reader.search(context, 'c', new AbortController().signal)).rejects.toThrow('401');
    expect((await service.list('manager', scope))[0]?.status).toBe('needs_reconnect');
    await expect(reader.search(context, 'd', new AbortController().signal)).rejects.toThrow('authorization changed');
  });
  it('rejects remote page URLs, excessive responses, and pages outside the provider grant', async () => {
    const linked = await notion();
    const context = { ...scope, connectionId: linked.id, connectionVersion: linked.credentialVersion };
    const reader = createIntegrationNotionReader(service, { fetch: fetcher });
    const callCount = fetcher.mock.calls.length;
    await expect(reader.readPage(context, 'http://127.0.0.1/secrets', new AbortController().signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(callCount);
    fetcher.mockImplementationOnce(async () => response({ results: [{ object: 'page', id: notionPageId, url: 'https://evil.test/page', properties: {} }], has_more: false }));
    await expect(reader.search(context, 'plan', new AbortController().signal)).rejects.toThrow('unexpected page URL');
    fetcher.mockImplementationOnce(async () => new Response('x'.repeat(2_000_001)));
    await expect(reader.search(context, 'plan', new AbortController().signal)).rejects.toThrow('invalid response');
    fetcher.mockImplementationOnce(async () => response({ message: 'page not shared' }, 404));
    await expect(reader.readPage(context, notionPageId, new AbortController().signal)).rejects.toThrow('404');
  });
  it('allows safe read recovery after a transient Notion failure and fences disconnect before retry', async () => {
    const linked = await notion();
    const effect: Effect = { id: 'effect', workspaceId: scope.workspaceId, scopeId: scope.scopeId, taskId: 'task', call: { id: 'call', name: 'notion_search', input: { query: 'plan' } }, state: 'dispatching', taskRevision: 1, policyRevision: 1, grantRevision: 1, hash: 'hash', result: null, providerId: null, url: null, reason: null, connectionId: linked.id, connectionVersion: linked.credentialVersion };
    const connector = createIntegrationToolConnector(service, { fetch: fetcher });
    fetcher.mockImplementationOnce(async () => response({ message: 'unavailable' }, 503));
    await expect(connector.invoke(effect, new AbortController().signal)).rejects.toThrow('503');
    const count = fetcher.mock.calls.length;
    expect(await connector.reconcile(effect, new AbortController().signal)).toMatchObject({ kind: 'absent' });
    expect(fetcher).toHaveBeenCalledTimes(count);
    fetcher.mockImplementationOnce(async () => response({ results: [], has_more: false }));
    expect(await connector.invoke(effect, new AbortController().signal)).toMatchObject({ url: null });
    await service.disconnect('manager', scope, linked.id);
    await expect(connector.invoke(effect, new AbortController().signal)).rejects.toThrow('authorization changed');
    expect(fetcher).toHaveBeenCalledTimes(count + 1);
  });
  it('requires a nonempty search and verifies live GitHub effect identity and repository before dispatch', async () => {
    const notionLinked = await notion();
    const reader = createIntegrationNotionReader(service, { fetch: fetcher });
    const notionContext = { ...scope, connectionId: notionLinked.id, connectionVersion: notionLinked.credentialVersion };
    await expect(reader.search(notionContext, '   ', new AbortController().signal)).rejects.toThrow();
    const linked = await github();
    const effect: Effect = { id: 'effect', workspaceId: scope.workspaceId, scopeId: scope.scopeId, taskId: 'task', call: { id: 'call', name: 'github_read_issues', input: { repository: 'team/project' } }, state: 'dispatching', taskRevision: 1, policyRevision: 1, grantRevision: 1, hash: 'hash', result: null, providerId: null, url: null, reason: null, connectionId: linked.id, connectionVersion: linked.credentialVersion };
    const connector = createIntegrationToolConnector(service, { fetch: fetcher });
    fetcher.mockImplementation(async (input, init) => {
      expect(String(input)).toContain('https://api.github.com/repos/team/project/issues');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer github-secret-installation');
      return response([]);
    });
    expect(JSON.parse((await connector.invoke(effect, new AbortController().signal)).content)).toMatchObject({ simulated: false, repository: 'team/project', issues: [] });
    const count = fetcher.mock.calls.length;
    await expect(connector.invoke({ ...effect, call: { ...effect.call, name: 'github_read_issues', input: { repository: 'other/private' } } }, new AbortController().signal)).rejects.toThrow('not allowlisted');
    permitted = false;
    await expect(connector.invoke(effect, new AbortController().signal)).rejects.toThrow('access denied');
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
});
