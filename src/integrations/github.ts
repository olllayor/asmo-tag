import { createHash, createSign } from 'node:crypto';
import { z } from 'zod';
import type { GitHubAppConfig, GitHubCredentials } from './types.js';
import { providerJson } from './http.js';

const tokens = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive(), refresh_token: z.string().min(1), refresh_token_expires_in: z.number().int().positive() });
const repos = z.object({ total_count: z.number().int().min(1).max(500), repositories: z.array(z.object({ id: z.number().int().positive(), full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) })).max(100) });
const installation = z.object({ id: z.number().int().positive(), app_id: z.number().int().positive(), suspended_at: z.string().nullable(), account: z.object({ login: z.string().min(1), type: z.enum(['User', 'Organization']) }) });
const headers = (token: string) => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'user-agent': 'asmo-tag' });
export function githubAuthorization(config: GitHubAppConfig, state: string, verifier: string): string {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, state, prompt: 'select_account', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  return url.toString();
}
function appJwt(config: GitHubAppConfig, now: number) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: config.appId })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(config.privateKey, 'base64url')}`;
}
async function userRepos(config: GitHubAppConfig, fetcher: typeof globalThis.fetch, userToken: string, installationId: number, now: number) {
  const verified = await providerJson(fetcher, `https://api.github.com/app/installations/${installationId}`, { headers: headers(appJwt(config, now)) }, installation);
  if (verified.id !== installationId || String(verified.app_id) !== config.appId || verified.suspended_at) throw new Error('GitHub installation is unavailable');
  const found: { id: number; full_name: string }[] = [];
  for (let page = 1; page <= 5; page++) {
    const result = await providerJson(fetcher, `https://api.github.com/user/installations/${installationId}/repositories?per_page=100&page=${page}`, { headers: headers(userToken) }, repos);
    found.push(...result.repositories);
    if (found.length >= result.total_count) return { accountName: verified.account.login, repositories: found };
  }
  throw new Error('Choose at most 500 GitHub repositories');
}
async function installationToken(config: GitHubAppConfig, fetcher: typeof globalThis.fetch, installationId: number, repositoryIds: number[], now: number) {
  const result = await providerJson(fetcher, `https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST', headers: { ...headers(appJwt(config, now)), 'content-type': 'application/json' },
    body: JSON.stringify({ repository_ids: repositoryIds, permissions: { issues: 'write', metadata: 'read' } }),
  }, z.object({ token: z.string().min(1), expires_at: z.string().datetime() }));
  const expiresAt = Date.parse(result.expires_at);
  if (expiresAt <= now) throw new Error('GitHub returned an expired installation token');
  return { accessToken: result.token, expiresAt };
}
export async function exchangeGitHub(config: GitHubAppConfig, fetcher: typeof globalThis.fetch, code: string, verifier: string, installationId: number, now: number) {
  const result = await providerJson(fetcher, 'https://github.com/login/oauth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, code_verifier: verifier, redirect_uri: config.redirectUri }) }, tokens);
  const selected = await userRepos(config, fetcher, result.access_token, installationId, now);
  const repositoryIds = selected.repositories.map(repo => repo.id);
  const credential: GitHubCredentials = { provider: 'github', installationId, repositoryIds, repositories: selected.repositories.map(repo => repo.full_name), userAccessToken: result.access_token, userRefreshToken: result.refresh_token, userExpiresAt: now + result.expires_in * 1000, userRefreshExpiresAt: now + result.refresh_token_expires_in * 1000, ...await installationToken(config, fetcher, installationId, repositoryIds, now) };
  return { credential, accountName: selected.accountName, resources: credential.repositories };
}
export async function refreshGitHub(config: GitHubAppConfig, fetcher: typeof globalThis.fetch, current: GitHubCredentials, now: number): Promise<GitHubCredentials> {
  let credential = current;
  if (credential.userExpiresAt <= now + 60_000) {
    if (credential.userRefreshExpiresAt <= now) throw new Error('GitHub authorization expired. Reconnect GitHub.');
    const refreshed = await providerJson(fetcher, 'https://github.com/login/oauth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'refresh_token', refresh_token: credential.userRefreshToken }) }, tokens);
    credential = { ...credential, userAccessToken: refreshed.access_token, userRefreshToken: refreshed.refresh_token, userExpiresAt: now + refreshed.expires_in * 1000, userRefreshExpiresAt: now + refreshed.refresh_token_expires_in * 1000 };
  }
  const verified = await userRepos(config, fetcher, credential.userAccessToken, credential.installationId, now);
  const accessible = new Set(verified.repositories.map(repo => repo.id));
  if (credential.repositoryIds.some(id => !accessible.has(id))) throw new Error('GitHub repository access changed. Reconnect GitHub.');
  return { ...credential, ...await installationToken(config, fetcher, credential.installationId, credential.repositoryIds, now) };
}
