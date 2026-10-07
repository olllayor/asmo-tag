import { effectSchema } from '../core.js';
import type { Effect, IssueConnector } from '../core.js';
import { receiptSchema } from '../connectors/boundary.js';
import type { IntegrationService } from './index.js';
import { createIntegrationIssueConnector } from './issue-connector.js';
import { createIntegrationNotionReader } from './notion-reader.js';

export function createIntegrationToolConnector(service: IntegrationService, options: { fetch?: typeof globalThis.fetch } = {}): IssueConnector {
  const github = createIntegrationIssueConnector(service, options);
  const notion = createIntegrationNotionReader(service, options);
  return {
    simulated: false,
    async invoke(rawEffect: Effect, signal: AbortSignal) {
      const effect = effectSchema.parse(rawEffect);
      if (effect.call.name === 'github_read_issues' || effect.call.name === 'github_create_issue') return github.invoke(effect, signal);
      if (!effect.connectionId || !effect.connectionVersion) throw new Error('Notion effect must bind an exact connection and credential version');
      const context = { workspaceId: effect.workspaceId, scopeId: effect.scopeId, connectionId: effect.connectionId, connectionVersion: effect.connectionVersion };
      if (effect.call.name === 'notion_search') {
        const result = await notion.search(context, effect.call.input.query, signal);
        return receiptSchema.parse({ providerId: `notion-search:${effect.connectionId}`, url: null, content: JSON.stringify({ simulated: false, ...result }) });
      }
      const result = await notion.readPage(context, effect.call.input.pageId, signal);
      return receiptSchema.parse({ providerId: `notion-page:${result.page.id}`, url: result.page.url, content: JSON.stringify({ simulated: false, ...result }) });
    },
    async reconcile(effect, signal) {
      if (effect.call.name === 'github_read_issues' || effect.call.name === 'github_create_issue') return github.reconcile(effect, signal);
      return { kind: 'absent', proof: 'Notion title search and page retrieval are explicit read-only endpoints. They cannot create a durable mutation. A fresh authorized read is safe.' };
    },
  };
}
