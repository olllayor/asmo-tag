import { z } from 'zod';
import type { NotionOAuthConfig, NotionCredentials } from './types.js';
import { providerJson } from './http.js';
export function notionAuthorization(config: NotionOAuthConfig, state: string): string {
  const url = new URL('https://api.notion.com/v1/oauth/authorize');
  url.search = new URLSearchParams({ owner: 'user', client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', state }).toString();
  return url.toString();
}
export async function exchangeNotion(config: NotionOAuthConfig, fetcher: typeof globalThis.fetch, code: string) {
  const result = await providerJson(fetcher, 'https://api.notion.com/v1/oauth/token', {
    method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`, 'content-type': 'application/json', accept: 'application/json', 'Notion-Version': '2026-03-11' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }),
  }, z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), bot_id: z.string().min(1), workspace_id: z.string().min(1), workspace_name: z.string().nullable().optional() }));
  const credential: NotionCredentials = { provider: 'notion', accessToken: result.access_token, refreshToken: result.refresh_token, botId: result.bot_id, workspaceId: result.workspace_id };
  return { credential, accountName: result.workspace_name ?? 'Notion workspace', resources: ['Pages selected in Notion'] };
}
export async function refreshNotion(config: NotionOAuthConfig, fetcher: typeof globalThis.fetch, credential: NotionCredentials): Promise<NotionCredentials> {
  const result = await providerJson(fetcher, 'https://api.notion.com/v1/oauth/token', {
    method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`, 'content-type': 'application/json', accept: 'application/json', 'Notion-Version': '2026-03-11' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: credential.refreshToken }),
  }, z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), bot_id: z.string().min(1), workspace_id: z.string().min(1) }));
  if (result.bot_id !== credential.botId || result.workspace_id !== credential.workspaceId) throw new Error('Notion token workspace changed. Reconnect Notion.');
  return { ...credential, accessToken: result.access_token, refreshToken: result.refresh_token };
}
