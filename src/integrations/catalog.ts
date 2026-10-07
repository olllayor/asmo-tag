export type ConnectorManifest = {
  id: string; name: string; protocol: 'github_app' | 'notion_oauth' | 'mcp' | 'plugin';
  description: string; capabilities: readonly string[]; available: boolean; setupRequired: boolean;
};
// Only reviewed, operator-configured providers can run. Catalog entries never execute remote code.
export function connectorCatalog(github: boolean, notion: boolean): ConnectorManifest[] {
  return [
    { id: 'github', name: 'GitHub', protocol: 'github_app', description: 'Choose repositories with the Asmo GitHub App.', capabilities: ['read_issues', 'create_issue_with_approval'], available: github, setupRequired: !github },
    { id: 'notion', name: 'Notion', protocol: 'notion_oauth', description: 'Choose pages in Notion. Search page titles and read page text.', capabilities: ['search_pages', 'read_pages'], available: notion, setupRequired: !notion },
    { id: 'mcp', name: 'MCP connectors', protocol: 'mcp', description: 'Planned. An operator must review each server and its permissions.', capabilities: [], available: false, setupRequired: true },
    { id: 'plugin', name: 'Plugins', protocol: 'plugin', description: 'Planned. Reviewed instructions and tools can attach to a scope.', capabilities: [], available: false, setupRequired: true },
  ];
}
