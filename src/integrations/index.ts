import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { connectDatabase, inDatabaseTransaction } from '../store/connection.js';
import type { Connection } from '../store/connection.js';
import { z } from 'zod';
import { connectorCatalog } from './catalog.js';
import { validateIntegrationConfig } from './config.js';
import { exchangeGitHub, githubAuthorization, refreshGitHub } from './github.js';
import { exchangeNotion, notionAuthorization, refreshNotion } from './notion.js';
import { ProviderHttpError } from './http.js';
import type { CallbackResult, ConnectionView, ConnectorCredentials, ConnectorProvider, CredentialLease, IntegrationOptions, IntegrationScope, StartResult } from './types.js';
export { readIntegrationConfig } from './config.js';
export type * from './types.js';

const scopeSchema = z.object({ workspaceId: z.string().min(1).max(128), scopeId: z.string().min(1).max(128), kind: z.enum(['shared', 'private']), ownerId: z.string().min(1).max(128).nullable() }).strict().refine(scope => scope.kind === 'private' ? scope.ownerId !== null : scope.ownerId === null);
const providerSchema = z.enum(['github', 'notion']);
type StateRow = { provider: ConnectorProvider; actor_id: string; scope_json: string; epoch: number; stage: 'install' | 'oauth'; secret: string | null; installation_id: number | null; expires_at: number; consumed: number };
type ConnectionRow = { id: string; provider: ConnectorProvider; scope_key: string; scope_json: string; actor_id: string; status: ConnectionView['status']; account_name: string; resources_json: string; credential_version: number; connected_at: number; updated_at: number; secret: string | null };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const scopeKey = (scope: IntegrationScope) => JSON.stringify([scope.workspaceId, scope.scopeId, scope.kind, scope.ownerId]);
const ttl = 10 * 60_000;

export class IntegrationService {
  private readonly db: DatabaseSync;
  private readonly databaseConnection: Connection;
  private readonly key: Buffer | undefined;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly clock: () => number;
  private readonly refreshing = new Map<string, Promise<void>>();
  constructor(private readonly options: IntegrationOptions) {
    validateIntegrationConfig(options);
    this.key = options.vaultKey ? Buffer.from(options.vaultKey, 'base64') : undefined;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? Date.now;
    this.databaseConnection = connectDatabase(options.databasePath);
    this.db = this.databaseConnection.database;
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;');
    try {
      this.initialTransaction(() => {
        this.db.exec('CREATE TABLE IF NOT EXISTS asmo_integration_schema(version INTEGER NOT NULL);');
        const version = this.db.prepare('SELECT version FROM asmo_integration_schema').get();
        if (version && version.version !== 1) throw new Error('Connector schema is newer than this application');
        if (!version) {
          this.db.exec(`
            CREATE TABLE asmo_integration_epochs(scope_key TEXT NOT NULL, provider TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY(scope_key,provider));
            CREATE TABLE asmo_integration_states(state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, actor_id TEXT NOT NULL, scope_json TEXT NOT NULL, epoch INTEGER NOT NULL, stage TEXT NOT NULL, secret TEXT, installation_id INTEGER, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN(0,1)));
            CREATE TABLE asmo_integration_connections(id TEXT PRIMARY KEY, provider TEXT NOT NULL, scope_key TEXT NOT NULL, scope_json TEXT NOT NULL, actor_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('connected','disconnected','needs_reconnect')), account_name TEXT NOT NULL, resources_json TEXT NOT NULL, credential_version INTEGER NOT NULL, connected_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, secret TEXT, UNIQUE(scope_key,provider));
            INSERT INTO asmo_integration_schema VALUES(1);`);
        }
      });
      // Connector migrations have their own version table. Reuse the task store's file gate only.
      this.databaseConnection.migrated = true;
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  catalog() { return connectorCatalog(Boolean(this.key && this.options.github), Boolean(this.key && this.options.notion)); }
  private initialTransaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private transaction<T>(operation: () => T): Promise<T> {
    return inDatabaseTransaction(this.databaseConnection, async () => operation());
  }
  private encrypt(value: unknown, binding: string): string {
    if (!this.key) throw new Error('Connector vault is not configured');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(binding));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return JSON.stringify([nonce.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')]);
  }
  private decrypt<T>(value: string, binding: string): T {
    if (!this.key) throw new Error('Connector vault is not configured');
    try {
      const [nonce, tag, encrypted] = z.tuple([z.string(), z.string(), z.string()]).parse(JSON.parse(value));
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64'));
      cipher.setAAD(Buffer.from(binding)); cipher.setAuthTag(Buffer.from(tag, 'base64'));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64')), cipher.final()]).toString('utf8')) as T;
    } catch { throw new Error('Connector vault could not decrypt credential'); }
  }
  private async allowed(actorId: string, rawScope: IntegrationScope, action: 'manage' | 'read' | 'use') {
    const scope = scopeSchema.parse(rawScope);
    if (!actorId || (scope.kind === 'private' && scope.ownerId !== actorId) || !await this.options.authorize(actorId, scope, action)) throw new Error('Connector access denied');
    return scope;
  }
  private configured(provider: ConnectorProvider) {
    if (!this.key || !this.options[provider]) throw new Error(`${provider} connector needs operator setup`);
  }
  private epoch(scope: IntegrationScope, provider: ConnectorProvider): number {
    return Number(this.db.prepare('SELECT epoch FROM asmo_integration_epochs WHERE scope_key=? AND provider=?').get(scopeKey(scope), provider)?.epoch ?? 0);
  }
  private nextEpoch(scope: IntegrationScope, provider: ConnectorProvider): number {
    const epoch = this.epoch(scope, provider) + 1;
    this.db.prepare('INSERT INTO asmo_integration_epochs VALUES(?,?,?) ON CONFLICT(scope_key,provider) DO UPDATE SET epoch=excluded.epoch').run(scopeKey(scope), provider, epoch);
    this.db.prepare('UPDATE asmo_integration_states SET consumed=1,secret=NULL WHERE provider=? AND scope_json=?').run(provider, JSON.stringify(scope));
    return epoch;
  }
  private issueState(provider: ConnectorProvider, actorId: string, scope: IntegrationScope, epoch: number, stage: 'install' | 'oauth', installationId: number | null = null): { state: string; verifier: string; expiresAt: number } {
    const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(32).toString('base64url'); const expiresAt = this.clock() + ttl;
    this.db.prepare('DELETE FROM asmo_integration_states WHERE expires_at<?').run(this.clock() - ttl);
    this.db.prepare('INSERT INTO asmo_integration_states VALUES(?,?,?,?,?,?,?,?,?,0)').run(digest(state), provider, actorId, JSON.stringify(scope), epoch, stage, this.encrypt({ verifier }, `state:${digest(state)}`), installationId, expiresAt);
    return { state, verifier, expiresAt };
  }
  async start(rawProvider: ConnectorProvider, actorId: string, rawScope: IntegrationScope): Promise<StartResult> {
    const provider = providerSchema.parse(rawProvider); this.configured(provider);
    const scope = await this.allowed(actorId, rawScope, 'manage');
    const state = await this.transaction(() => this.issueState(provider, actorId, scope, this.nextEpoch(scope, provider), provider === 'github' ? 'install' : 'oauth'));
    if (provider === 'notion') return { authorizationUrl: notionAuthorization(this.options.notion!, state.state), expiresAt: state.expiresAt };
    const url = new URL(`https://github.com/apps/${this.options.github!.slug}/installations/new`);
    url.searchParams.set('state', state.state);
    return { authorizationUrl: url.toString(), expiresAt: state.expiresAt };
  }
  async callback(rawProvider: ConnectorProvider, input: { state: string; code?: string; installationId?: string; error?: string }): Promise<CallbackResult> {
    const provider = providerSchema.parse(rawProvider); this.configured(provider);
    const state = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(input.state);
    const hash = digest(state);
    const row = await this.transaction(() => {
      const value = this.db.prepare('SELECT * FROM asmo_integration_states WHERE state_hash=? AND provider=?').get(hash, provider) as StateRow | undefined;
      if (!value || value.consumed || value.expires_at <= this.clock()) throw new Error('Connector authorization state is invalid or expired');
      const scope = scopeSchema.parse(JSON.parse(value.scope_json));
      if (this.epoch(scope, provider) !== value.epoch) throw new Error('Connector authorization was invalidated');
      this.db.prepare('UPDATE asmo_integration_states SET consumed=1,secret=NULL WHERE state_hash=?').run(hash);
      return value;
    });
    const scope = await this.allowed(row.actor_id, scopeSchema.parse(JSON.parse(row.scope_json)), 'manage');
    if (input.error) throw new Error('Connector authorization was denied');
    if (row.stage === 'install') {
      const installationId = z.coerce.number().int().positive().safe().parse(input.installationId);
      const next = await this.transaction(() => {
        if (this.epoch(scope, provider) !== row.epoch) throw new Error('Connector authorization was invalidated');
        return this.issueState(provider, row.actor_id, scope, row.epoch, 'oauth', installationId);
      });
      return { status: 'redirect', authorizationUrl: githubAuthorization(this.options.github!, next.state, next.verifier) };
    }
    const code = z.string().min(1).max(2048).parse(input.code);
    const verifier = this.decrypt<{ verifier: string }>(row.secret!, `state:${hash}`).verifier;
    const linked = provider === 'github'
      ? await exchangeGitHub(this.options.github!, this.fetcher, code, verifier, row.installation_id!, this.clock())
      : await exchangeNotion(this.options.notion!, this.fetcher, code);
    await this.allowed(row.actor_id, scope, 'manage');
    const connection = await this.transaction(() => {
      if (this.epoch(scope, provider) !== row.epoch || row.expires_at <= this.clock()) throw new Error('Connector authorization was invalidated or expired');
      const existing = this.db.prepare('SELECT * FROM asmo_integration_connections WHERE scope_key=? AND provider=?').get(scopeKey(scope), provider) as ConnectionRow | undefined;
      const id = existing?.id ?? randomUUID(); const version = (existing?.credential_version ?? 0) + 1; const now = this.clock();
      this.db.prepare(`INSERT INTO asmo_integration_connections VALUES(?,?,?,?,?,'connected',?,?,?,?,?,?) ON CONFLICT(scope_key,provider) DO UPDATE SET actor_id=excluded.actor_id,status='connected',account_name=excluded.account_name,resources_json=excluded.resources_json,credential_version=excluded.credential_version,connected_at=excluded.connected_at,updated_at=excluded.updated_at,secret=excluded.secret`).run(id, provider, scopeKey(scope), JSON.stringify(scope), row.actor_id, linked.accountName, JSON.stringify(linked.resources), version, now, now, this.encrypt(linked.credential, `connection:${id}:${version}`));
      return this.row(id);
    });
    return { status: 'connected', connection: this.view(connection) };
  }
  private row(id: string): ConnectionRow {
    const row = this.db.prepare('SELECT * FROM asmo_integration_connections WHERE id=?').get(id) as ConnectionRow | undefined;
    if (!row) throw new Error('Connector connection does not exist');
    return row;
  }
  private view(row: ConnectionRow): ConnectionView {
    const status = row.status === 'connected' && (!this.key || !this.options[row.provider]) ? 'needs_reconnect' : row.status;
    return { id: row.id, provider: row.provider, scope: scopeSchema.parse(JSON.parse(row.scope_json)), status, accountName: row.account_name, resources: JSON.parse(row.resources_json) as string[], credentialVersion: row.credential_version, connectedAt: row.connected_at, updatedAt: row.updated_at };
  }
  async list(actorId: string, rawScope: IntegrationScope): Promise<ConnectionView[]> {
    const scope = await this.allowed(actorId, rawScope, 'read');
    return this.transaction(() => (this.db.prepare('SELECT * FROM asmo_integration_connections WHERE scope_key=? ORDER BY provider').all(scopeKey(scope)) as ConnectionRow[]).map(row => this.view(row)));
  }
  // Server-only identity lookup. Routes must never accept this identity from browser input.
  async connectionActor(connectionId: string, credentialVersion?: number): Promise<string> {
    return this.transaction(() => {
      const row = this.row(connectionId);
      if (row.status !== 'connected' || !row.secret || (credentialVersion !== undefined && row.credential_version !== credentialVersion)) throw new Error('Connector credential was disconnected or changed');
      return row.actor_id;
    });
  }
  async connectionNotionWorkspaceId(connectionId: string, credentialVersion: number): Promise<string> {
    return this.transaction(() => {
      const row = this.row(connectionId);
      if (row.provider !== 'notion' || row.status !== 'connected' || !row.secret || row.credential_version !== credentialVersion) throw new Error('Notion credential was disconnected or changed');
      const credential = this.decrypt<ConnectorCredentials>(row.secret, `connection:${row.id}:${row.credential_version}`);
      if (credential.provider !== 'notion') throw new Error('Unexpected connector provider');
      return credential.workspaceId;
    });
  }
  async disconnect(actorId: string, rawScope: IntegrationScope, connectionId: string): Promise<ConnectionView> {
    const scope = await this.allowed(actorId, rawScope, 'manage');
    return this.transaction(() => {
      const row = this.row(connectionId);
      if (row.scope_key !== scopeKey(scope)) throw new Error('Connector access denied');
      this.nextEpoch(scope, row.provider);
      this.db.prepare("UPDATE asmo_integration_connections SET status='disconnected',credential_version=credential_version+1,secret=NULL,resources_json='[]',updated_at=? WHERE id=?").run(this.clock(), connectionId);
      return this.view(this.row(connectionId));
    });
  }
  async validateLease(lease: CredentialLease, actorId: string, rawScope: IntegrationScope): Promise<void> {
    const scope = await this.allowed(actorId, rawScope, 'use');
    await this.transaction(() => {
      const row = this.row(lease.connectionId);
      this.configured(row.provider);
      if (row.scope_key !== scopeKey(scope) || row.status !== 'connected' || !row.secret || row.credential_version !== lease.credentialVersion) throw new Error('Connector credential was disconnected or changed');
    });
  }
  async withCredential<T>(lease: CredentialLease, actorId: string, scope: IntegrationScope, operation: (credential: ConnectorCredentials) => Promise<T>): Promise<T> {
    await this.validateLease(lease, actorId, scope);
    let row = await this.transaction(() => this.row(lease.connectionId));
    let credential = this.decrypt<ConnectorCredentials>(row.secret!, `connection:${row.id}:${row.credential_version}`);
    if (credential.provider === 'github' && credential.expiresAt <= this.clock() + 60_000) {
      let pending = this.refreshing.get(row.id);
      if (!pending) {
        const original = row; const current = credential;
        pending = (async () => {
          try {
            const refreshed = await refreshGitHub(this.options.github!, this.fetcher, current, this.clock());
            await this.validateLease(lease, actorId, scope);
            await this.transaction(() => this.db.prepare('UPDATE asmo_integration_connections SET secret=?,updated_at=? WHERE id=? AND credential_version=? AND status=\'connected\'').run(this.encrypt(refreshed, `connection:${original.id}:${original.credential_version}`), this.clock(), original.id, original.credential_version));
          } catch (error) {
            await this.transaction(() => this.db.prepare("UPDATE asmo_integration_connections SET status='needs_reconnect',credential_version=credential_version+1,secret=NULL,updated_at=? WHERE id=? AND credential_version=? AND status='connected'").run(this.clock(), original.id, original.credential_version));
            throw error;
          }
        })();
        this.refreshing.set(row.id, pending);
      }
      try { await pending; } finally { if (this.refreshing.get(row.id) === pending) this.refreshing.delete(row.id); }
      row = await this.transaction(() => this.row(lease.connectionId));
      credential = this.decrypt<ConnectorCredentials>(row.secret!, `connection:${row.id}:${row.credential_version}`);
    }
    await this.validateLease(lease, actorId, scope);
    try { return await operation(credential); }
    catch (error) {
      if (credential.provider !== 'notion' || !(error instanceof ProviderHttpError) || error.status !== 401) throw error;
      const refreshed = await this.refreshNotionCredential(lease, actorId, scope, credential.accessToken);
      await this.validateLease(lease, actorId, scope);
      try { return await operation(refreshed); }
      catch (retryError) {
        if (retryError instanceof ProviderHttpError && retryError.status === 401) await this.needsReconnect(lease);
        throw retryError;
      }
    }
  }
  private async needsReconnect(lease: CredentialLease) {
    await this.transaction(() => this.db.prepare("UPDATE asmo_integration_connections SET status='needs_reconnect',credential_version=credential_version+1,secret=NULL,updated_at=? WHERE id=? AND credential_version=? AND status='connected'").run(this.clock(), lease.connectionId, lease.credentialVersion));
  }
  private async refreshNotionCredential(lease: CredentialLease, actorId: string, scope: IntegrationScope, failedToken: string): Promise<Extract<ConnectorCredentials, { provider: 'notion' }>> {
    await this.validateLease(lease, actorId, scope);
    let row = await this.transaction(() => this.row(lease.connectionId));
    let current = this.decrypt<ConnectorCredentials>(row.secret!, `connection:${row.id}:${row.credential_version}`);
    if (current.provider !== 'notion') throw new Error('Unexpected connector provider');
    if (current.accessToken === failedToken) {
      let pending = this.refreshing.get(row.id);
      if (!pending) {
        const original = row; const credential = current;
        pending = (async () => {
          try {
            const refreshed = await refreshNotion(this.options.notion!, this.fetcher, credential);
            await this.validateLease(lease, actorId, scope);
            await this.transaction(() => this.db.prepare("UPDATE asmo_integration_connections SET secret=?,updated_at=? WHERE id=? AND credential_version=? AND status='connected'").run(this.encrypt(refreshed, `connection:${original.id}:${original.credential_version}`), this.clock(), original.id, original.credential_version));
          } catch (error) { await this.needsReconnect(lease); throw error; }
        })();
        this.refreshing.set(row.id, pending);
      }
      try { await pending; } finally { if (this.refreshing.get(row.id) === pending) this.refreshing.delete(row.id); }
    }
    await this.validateLease(lease, actorId, scope);
    row = await this.transaction(() => this.row(lease.connectionId));
    current = this.decrypt<ConnectorCredentials>(row.secret!, `connection:${row.id}:${row.credential_version}`);
    if (current.provider !== 'notion') throw new Error('Unexpected connector provider');
    return current;
  }
  private async withProviderForEffect<T>(provider: ConnectorProvider, context: { workspaceId: string; scopeId: string; connectionId?: string; connectionVersion?: number }, operation: (credential: ConnectorCredentials, gate: () => Promise<void>) => Promise<T>): Promise<T> {
    if (!context.connectionId || !context.connectionVersion) throw new Error('Connector effect must bind an exact connection and credential version');
    const rows = await this.transaction(() => this.db.prepare("SELECT * FROM asmo_integration_connections WHERE provider=? AND json_extract(scope_json,'$.workspaceId')=? AND json_extract(scope_json,'$.scopeId')=?").all(provider, context.workspaceId, context.scopeId) as ConnectionRow[]);
    if (rows.length !== 1) throw new Error(`Connect ${provider} for this scope before using its tools`);
    const row = rows[0]!; const scope = scopeSchema.parse(JSON.parse(row.scope_json));
    if (row.id !== context.connectionId || row.credential_version !== context.connectionVersion) throw new Error('Connector effect authorization changed. Prepare the task again.');
    const lease = { connectionId: row.id, credentialVersion: row.credential_version };
    return this.withCredential(lease, row.actor_id, scope, async credential => {
      return operation(credential, () => this.validateLease(lease, row.actor_id, scope));
    });
  }
  async withGitHubForEffect<T>(context: { workspaceId: string; scopeId: string; connectionId?: string; connectionVersion?: number }, operation: (credential: Extract<ConnectorCredentials, { provider: 'github' }>, gate: () => Promise<void>) => Promise<T>): Promise<T> {
    return this.withProviderForEffect('github', context, (credential, gate) => {
      if (credential.provider !== 'github') throw new Error('Unexpected connector provider');
      return operation(credential, gate);
    });
  }
  async withNotionForEffect<T>(context: { workspaceId: string; scopeId: string; connectionId?: string; connectionVersion?: number }, operation: (credential: Extract<ConnectorCredentials, { provider: 'notion' }>, gate: () => Promise<void>) => Promise<T>): Promise<T> {
    return this.withProviderForEffect('notion', context, (credential, gate) => {
      if (credential.provider !== 'notion') throw new Error('Unexpected connector provider');
      return operation(credential, gate);
    });
  }
}
