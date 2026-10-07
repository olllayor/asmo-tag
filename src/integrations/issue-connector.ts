import type { Effect, IssueConnector } from '../core.js';
import { effectSchema } from '../core.js';
import { createGitHubConnector } from '../connectors/github.js';
import type { IntegrationService } from './index.js';

export function createIntegrationIssueConnector(service: IntegrationService, options: { fetch?: typeof globalThis.fetch } = {}): IssueConnector {
  const fetcher = options.fetch ?? globalThis.fetch;
  async function run<T>(effect: Effect, operation: (connector: IssueConnector) => Promise<T>) {
    return service.withGitHubForEffect(effect, async (credential, gate) => {
      const guardedFetch: typeof globalThis.fetch = async (input, init) => { await gate(); return fetcher(input, init); };
      return operation(createGitHubConnector({ token: credential.accessToken, allowedRepositories: credential.repositories, fetch: guardedFetch }));
    });
  }
  return {
    simulated: false,
    invoke: (effect, signal) => run(effect, connector => connector.invoke(effect, signal)),
    reconcile: async (rawEffect, signal) => {
      const effect = effectSchema.parse(rawEffect);
      if (effect.call.name === 'github_read_issues') return { kind: 'absent', proof: 'GitHub issue listing is an explicit read-only endpoint. It cannot create a durable mutation. A fresh authorized read is safe.' };
      return run(effect, connector => connector.reconcile(effect, signal));
    },
  };
}
