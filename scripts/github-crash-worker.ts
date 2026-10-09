import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ModelProvider } from '../src/core.js';
import { openStore } from '../src/store/index.js';
import { IntegrationService } from '../src/integrations/index.js';
import { createIntegrationIssueConnector } from '../src/integrations/issue-connector.js';
import { Worker } from '../src/worker.js';

const configuration = z.object({
  databasePath: z.string().refine(path => path.startsWith(join(tmpdir(), 'asmo-github-proof-')) && path === resolve(path) && path.endsWith('/proof.sqlite')),
  workspaceId: z.uuid(), origin: z.string(), now: z.number().int().positive(),
  vaultKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  github: z.object({
    appId: z.literal('123'), slug: z.literal('asmo-proof'),
    clientId: z.literal('proof-client'), clientSecret: z.literal('proof-client-secret'),
    privateKey: z.string().startsWith('-----BEGIN PRIVATE KEY-----'),
    redirectUri: z.literal('https://asmo.test/connectors/github/callback'),
  }).strict(),
}).strict();
export type ProofConfiguration = z.infer<typeof configuration>;

// There is no fallback to a real provider URL, including for redirects.
export function loopbackGitHubFetch(origin: string): typeof globalThis.fetch {
  const target = new URL(origin);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw new Error('Expected an isolated loopback origin');
  const nativeFetch = globalThis.fetch;
  return async (input, init) => {
    if (input instanceof Request) throw new Error('Unexpected GitHub Request object');
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const route = `${method} ${url.hostname}${url.pathname}${url.search}`;
    const allowed = [
      'POST github.com/login/oauth/access_token',
      'GET api.github.com/app/installations/42',
      'GET api.github.com/user/installations/42/repositories?per_page=100&page=1',
      'POST api.github.com/app/installations/42/access_tokens',
      'POST api.github.com/repos/asmo-proof/recovery/issues',
      'GET api.github.com/repos/asmo-proof/recovery/issues?state=all&per_page=100&page=1',
    ];
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !allowed.includes(route) || init?.redirect !== 'error') throw new Error(`Unexpected proof transport route: ${route}`);
    return nativeFetch(`${target.origin}/${url.hostname}${url.pathname}${url.search}`, { ...init, redirect: 'error' });
  };
}

// Parent and child compose the same production stack against disposable SQLite.
export async function openGitHubProof(raw: ProofConfiguration, clock: () => number) {
  const config = configuration.parse(raw);
  const fetcher = loopbackGitHubFetch(config.origin);
  const store = await openStore({ databasePath: config.databasePath, workspaceIds: [config.workspaceId], modelReserveMicros: 1000, maxOutputTokens: 1024, maxTurns: 8, taskBudgetMicros: 100000, leaseMs: 30000, simulated: true, clock });
  let integrations: IntegrationService;
  try {
    integrations = new IntegrationService({ ...config, clock, fetch: fetcher, authorize: async (actor, binding, action) => {
      const scope = (await store.scopes(actor)).find(scope => scope.id === binding.scopeId);
      if (!scope || !scope.active || scope.workspaceId !== binding.workspaceId || binding.kind !== (scope.kind === 'dm' ? 'private' : 'shared') || binding.ownerId !== scope.ownerId) return false;
      const view = await store.view(scope.id, actor);
      return action === 'read' || view.role === 'manager' || view.role === 'owner';
    } });
  } catch (error) { await store.close(); throw error; }
  const model: ModelProvider = { simulated: true, async turn() {
    return { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'proof-write', name: 'github_create_issue', input: { repository: 'asmo-proof/recovery', title: 'Exact recovery issue', body: 'Preserve this exact reviewed body.', labels: ['bug'] } }] }, outcome: 'tools', sourceIds: [], limitations: ['Isolated proof'], requestId: 'proof-model', usage: { inputTokens: 10, outputTokens: 20, costMicros: 1000, simulated: true, pricingRevision: 'fixture' } };
  } };
  const worker = new Worker(store, model, createIntegrationIssueConnector(integrations, { fetch: fetcher }), { simulated: true, async send() { return { messageId: 1 }; } });
  return { store, integrations, worker };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.send) throw new Error('Proof worker requires synthetic IPC configuration');
  process.once('message', (raw: unknown) => {
    void (async () => {
      const config = configuration.parse(raw);
      const runtime = await openGitHubProof(config, () => config.now);
      try {
        await runtime.worker.step('github-proof-child', undefined, 'effect');
        throw new Error('Proof write returned before the parent killed it');
      } finally { runtime.integrations.close(); await runtime.store.close(); }
    })().catch(error => { process.stderr.write(`${String(error)}\n`); process.exit(1); });
  });
}
