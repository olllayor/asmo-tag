/**
 * Dynamic Semantic and Lexical Tool Search Engine Types
 * Inspired by Anthropic's tool_search pattern
 */

/**
 * Tool Definition Schema
 * Compatible with standard LLM function/tool calling specifications
 */
export interface ToolDefinition {
  /** Unique name of the tool */
  name: string;
  /** Detailed description of what the tool does and when to call it */
  description: string;
  /** JSON Schema of the parameters expected by the tool */
  parameters: Record<string, any>;
  /** Optional tags classifying the tool (e.g., ['database', 'read', 'sql']) */
  tags?: string[];
  /** Optional usage examples or few-shot prompts demonstrating calls */
  examples?: string[];
  /** Optional pre-computed embedding vector for semantic search */
  embedding?: number[];
  /** Optional custom metadata associated with the tool */
  metadata?: Record<string, unknown>;
}

/**
 * Parameters for the meta-tool `tool_search`
 */
export interface ToolSearchInput {
  /** Search query describing the needed capability, action, or domain */
  query: string;
  /** Maximum number of tools to return (default: 5) */
  limit?: number;
  /** Optional tags to filter tools */
  tags?: string[];
}

/**
 * Matching mode when filtering by tags
 */
export type TagMatchMode = 'any' | 'all';

/**
 * Search options configuring the ranking and filtering pipeline
 */
export interface ToolSearchOptions {
  /** The natural language or keyword query string */
  query: string;
  /** Maximum number of matching tools to return (default: 5) */
  limit?: number;
  /** Minimum relevance score threshold to include a tool in results (default: 0) */
  threshold?: number;
  /** Filter tools by required tags */
  tags?: string[];
  /** Match mode for tag filter ('any' requires at least one tag, 'all' requires all tags) */
  tagMatchMode?: TagMatchMode;
  /**
   * Weighting factor between semantic and lexical scoring:
   * 0.0 = pure lexical (BM25)
   * 1.0 = pure semantic (vector embedding)
   * Between 0.0 and 1.0 = hybrid scoring
   * Default: 0.5 when vector embeddings are available, 0.0 otherwise.
   */
  alpha?: number;
  /** Optional query embedding vector for semantic scoring */
  queryEmbedding?: number[];
  /** Optional function to compute embedding vector on the fly */
  embedder?: (text: string) => Promise<number[]> | number[];
  /** Custom scoring function to override or augment relevance */
  customScorer?: (query: string, tool: ToolDefinition) => number;
}

/**
 * Detailed result of a search match for a single tool
 */
export interface ToolSearchResult {
  /** The matching tool definition */
  tool: ToolDefinition;
  /** Final combined relevance score */
  score: number;
  /** Lexical BM25 / TF-IDF score */
  lexicalScore: number;
  /** Semantic vector cosine similarity score (if computed) */
  semanticScore?: number;
  /** Query terms that matched fields in the tool */
  matchedTerms?: string[];
  /** Tags that matched query terms or filter criteria */
  matchedTags?: string[];
}

/**
 * Structured response for tool search calls
 */
export interface ToolSearchResponse {
  query: string;
  count: number;
  tools: ToolDefinition[];
  results: ToolSearchResult[];
}

/**
 * Result returned when executing the tool_search meta-tool
 */
export interface ToolSearchExecutionResult {
  query: string;
  count: number;
  tools: ToolDefinition[];
  results: ToolSearchResult[];
  activatedToolNames: string[];
}

/**
 * Configuration options for the ToolSessionManager
 */
export interface ToolSessionManagerOptions {
  /** Tool registry providing the full catalog of searchable tools */
  registry: ToolRegistryInterface;
  /** Base set of core tools always active in the session */
  coreTools?: ToolDefinition[];
  /** Custom definition for the tool_search meta-tool (defaults to standard) */
  searchMetaTool?: ToolDefinition;
  /** Whether to include the tool_search meta-tool in active tools (default: true) */
  includeSearchMetaTool?: boolean;
  /** Whether discovering tools via search automatically activates them (default: true) */
  autoActivateOnSearch?: boolean;
  /** Maximum number of active tools before evicting least-recently activated tools */
  maxActiveTools?: number;
  /** Default search options applied when executing tool_search */
  searchOptions?: Partial<Omit<ToolSearchOptions, 'query'>>;
}

/**
 * Public interface for ToolRegistry
 */
export interface ToolRegistryInterface {
  register(tool: ToolDefinition): void;
  registerMany(tools: ToolDefinition[]): void;
  unregister(name: string): boolean;
  get(name: string): ToolDefinition | undefined;
  has(name: string): boolean;
  list(): ToolDefinition[];
  clear(): void;
  readonly size: number;
  search(options: string | ToolSearchOptions): Promise<ToolSearchResult[]>;
  searchSync(options: string | ToolSearchOptions): ToolSearchResult[];
}

/**
 * Meta-tool identifier and standard schema definition
 */
export const TOOL_SEARCH_NAME = 'tool_search';

export const TOOL_SEARCH_PARAMETERS_SCHEMA: Record<string, any> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'The search query to find relevant tools by capability, action, or domain',
    },
    limit: {
      type: 'number',
      description: 'Maximum number of tools to return (default: 5)',
    },
    tags: {
      type: 'array',
      items: {
        type: 'string',
      },
      description: 'Optional list of tags to filter tools by category or domain',
    },
  },
  required: ['query'],
};

export const TOOL_SEARCH_DEFINITION: ToolDefinition = {
  name: TOOL_SEARCH_NAME,
  description:
    'Search for available tools and capabilities in the tool registry by semantic query and keywords. Discovered tools are dynamically activated for subsequent steps.',
  parameters: TOOL_SEARCH_PARAMETERS_SCHEMA,
  tags: ['meta', 'discovery', 'search', 'tools'],
  examples: [
    'tool_search({ query: "retrieve user profile from database" })',
    'tool_search({ query: "calculate metrics", tags: ["math", "analytics"] })',
  ],
};
