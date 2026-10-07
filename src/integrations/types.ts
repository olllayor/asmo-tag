export type ConnectorProvider = 'github' | 'notion';
export type IntegrationScope = { workspaceId: string; scopeId: string; kind: 'shared' | 'private'; ownerId: string | null };
export type ConnectionView = {
  id: string; provider: ConnectorProvider; scope: IntegrationScope;
  status: 'connected' | 'disconnected' | 'needs_reconnect'; accountName: string;
  resources: string[]; credentialVersion: number; connectedAt: number; updatedAt: number;
};
export type CredentialLease = { connectionId: string; credentialVersion: number };
export type GitHubCredentials = {
  provider: 'github'; accessToken: string; expiresAt: number; installationId: number;
  repositoryIds: number[]; repositories: string[];
  userAccessToken: string; userExpiresAt: number; userRefreshToken: string; userRefreshExpiresAt: number;
};
export type NotionCredentials = { provider: 'notion'; accessToken: string; refreshToken: string; botId: string; workspaceId: string };
export type ConnectorCredentials = GitHubCredentials | NotionCredentials;
export type GitHubAppConfig = { appId: string; clientId: string; clientSecret: string; privateKey: string; slug: string; redirectUri: string };
export type NotionOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string };
export type IntegrationConfig = { vaultKey?: string; github?: GitHubAppConfig; notion?: NotionOAuthConfig };
export type IntegrationOptions = IntegrationConfig & {
  databasePath: string;
  authorize: (actorId: string, scope: IntegrationScope, action: 'manage' | 'read' | 'use') => Promise<boolean>;
  fetch?: typeof globalThis.fetch; clock?: () => number;
};
export type StartResult = { authorizationUrl: string; expiresAt: number };
export type CallbackResult = { status: 'redirect'; authorizationUrl: string } | { status: 'connected'; connection: ConnectionView };
