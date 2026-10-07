import { z } from 'zod';
import type { IntegrationService } from './index.js';
import { providerJson } from './http.js';

type Context = { workspaceId: string; scopeId: string; connectionId: string; connectionVersion: number };
const richText = z.array(z.object({ plain_text: z.string().max(20000) })).max(100);
const page = z.object({
  id: z.string().uuid(), object: z.literal('page'), url: z.string().url(),
  properties: z.record(z.string(), z.unknown()), archived: z.boolean().optional(), is_archived: z.boolean().optional(), in_trash: z.boolean().optional(),
});
function summary(value: z.infer<typeof page>) {
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || !['www.notion.so', 'notion.so'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('Notion returned an unexpected page URL');
  const title = Object.values(value.properties).map(value => z.object({ type: z.literal('title'), title: richText }).safeParse(value)).find(value => value.success);
  return { id: value.id, url: url.toString(), title: title?.data?.title.map(item => item.plain_text).join('') ?? 'Untitled', archived: value.archived || value.is_archived || value.in_trash || false };
}
export function createIntegrationNotionReader(service: IntegrationService, options: { fetch?: typeof globalThis.fetch } = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = (accessToken: string) => ({ authorization: `Bearer ${accessToken}`, 'Notion-Version': '2026-03-11', 'content-type': 'application/json' });
  return {
    async search(context: Context, query: string, signal: AbortSignal) {
      const safeQuery = z.string().trim().min(1).max(200).parse(query);
      return service.withNotionForEffect(context, async (credential, gate) => {
        await gate();
        const result = await providerJson(fetcher, 'https://api.notion.com/v1/search', { method: 'POST', signal, headers: headers(credential.accessToken), body: JSON.stringify({ query: safeQuery, page_size: 100, filter: { property: 'object', value: 'page' } }) }, z.object({ results: z.array(page).max(100), has_more: z.boolean() }));
        await gate();
        return { pages: result.results.map(summary), coverage: result.has_more ? 'First 100 matching pages selected in Notion. More pages exist.' : 'Matching pages visible to this Notion connection.' };
      });
    },
    async readPage(context: Context, pageId: string, signal: AbortSignal) {
      const safeId = z.string().uuid().parse(pageId);
      return service.withNotionForEffect(context, async (credential, gate) => {
        await gate();
        const result = await providerJson(fetcher, `https://api.notion.com/v1/pages/${safeId}`, { signal, headers: headers(credential.accessToken) }, page);
        if (result.id !== safeId) throw new Error('Notion returned an unexpected page');
        await gate();
        const blocks = await providerJson(fetcher, `https://api.notion.com/v1/blocks/${safeId}/children?page_size=100`, { signal, headers: headers(credential.accessToken) }, z.object({ results: z.array(z.object({ type: z.string(), has_children: z.boolean() }).catchall(z.unknown())).max(100), has_more: z.boolean() }));
        await gate();
        const content = blocks.results.flatMap(block => {
          const typed = z.object({ rich_text: richText }).safeParse(block[block.type]);
          return typed.success ? [typed.data.rich_text.map(item => item.plain_text).join('')] : [];
        }).join('\n').slice(0, 100_000);
        return { page: summary(result), content, coverage: 'Up to 100 direct blocks. Nested blocks, attachments, and linked pages are excluded.', truncated: blocks.has_more || blocks.results.some(block => block.has_children) || content.length >= 100_000 };
      });
    },
  };
}
