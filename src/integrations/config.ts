import { createPrivateKey } from 'node:crypto';
import type { IntegrationConfig } from './types.js';

function redirect(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Connector callback must use HTTPS or loopback HTTP');
  return url.toString();
}
export function validateIntegrationConfig(config: IntegrationConfig): void {
  if (config.vaultKey !== undefined && (!/^[A-Za-z0-9+/]{43}=$/.test(config.vaultKey) || Buffer.from(config.vaultKey, 'base64').length !== 32)) throw new Error('ASMO_CONNECTOR_VAULT_KEY must be a base64-encoded 32-byte key');
  if (config.github) {
    if (!/^\d+$/.test(config.github.appId) || !/^[a-z0-9][a-z0-9-]{0,100}$/.test(config.github.slug) || !config.github.clientId || !config.github.clientSecret) throw new Error('Invalid GitHub App configuration');
    if (createPrivateKey(config.github.privateKey).asymmetricKeyType !== 'rsa') throw new Error('GitHub App private key must use RSA');
    redirect(config.github.redirectUri);
  }
  if (config.notion) {
    if (!config.notion.clientId || !config.notion.clientSecret) throw new Error('Invalid Notion OAuth configuration');
    redirect(config.notion.redirectUri);
  }
  if ((config.github || config.notion) && !config.vaultKey) throw new Error('ASMO_CONNECTOR_VAULT_KEY is required for live connectors');
}
export function readIntegrationConfig(env: NodeJS.ProcessEnv = process.env): IntegrationConfig {
  const readGroup = (names: string[]) => {
    const values = names.map(name => env[name]);
    if (!values.some(value => value !== undefined)) return undefined;
    if (values.some(value => !value?.trim())) throw new Error(`Configure all connector settings: ${names.join(', ')}`);
    return values as string[];
  };
  const github = readGroup(['ASMO_GITHUB_APP_ID', 'ASMO_GITHUB_CLIENT_ID', 'ASMO_GITHUB_CLIENT_SECRET', 'ASMO_GITHUB_PRIVATE_KEY', 'ASMO_GITHUB_APP_SLUG', 'ASMO_GITHUB_CALLBACK_URL']);
  const notion = readGroup(['ASMO_NOTION_CLIENT_ID', 'ASMO_NOTION_CLIENT_SECRET', 'ASMO_NOTION_CALLBACK_URL']);
  const config: IntegrationConfig = {
    ...(env.ASMO_CONNECTOR_VAULT_KEY !== undefined ? { vaultKey: env.ASMO_CONNECTOR_VAULT_KEY } : {}),
    ...(github ? { github: { appId: github[0]!, clientId: github[1]!, clientSecret: github[2]!, privateKey: github[3]!.replace(/\\n/g, '\n'), slug: github[4]!, redirectUri: redirect(github[5]!) } } : {}),
    ...(notion ? { notion: { clientId: notion[0]!, clientSecret: notion[1]!, redirectUri: redirect(notion[2]!) } } : {}),
  };
  validateIntegrationConfig(config);
  return config;
}
