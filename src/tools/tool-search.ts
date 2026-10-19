import {
  type ToolDefinition,
  type ToolSearchInput,
  type ToolSearchOptions,
  type ToolSearchResult,
  type ToolSearchExecutionResult,
  type ToolSessionManagerOptions,
  type ToolRegistryInterface,
  type TagMatchMode,
  TOOL_SEARCH_NAME,
  TOOL_SEARCH_DEFINITION,
  TOOL_SEARCH_PARAMETERS_SCHEMA,
} from './types.js';

export {
  type ToolDefinition,
  type ToolSearchInput,
  type ToolSearchOptions,
  type ToolSearchResult,
  type ToolSearchExecutionResult,
  type ToolSessionManagerOptions,
  type ToolRegistryInterface,
  type TagMatchMode,
  TOOL_SEARCH_NAME,
  TOOL_SEARCH_DEFINITION,
  TOOL_SEARCH_PARAMETERS_SCHEMA,
};

/**
 * Common English stopwords filtered out during BM25 tokenization
 * to prevent high-frequency noise terms from dominating ranking.
 */
const DEFAULT_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the',
  'to', 'was', 'were', 'will', 'with', 'or', 'this', 'but', 'they',
  'not', 'no',
]);

/**
 * Tokenize a text string into normalized, lowercased terms.
 * Handles:
 * - camelCase (e.g., "getUserById" -> ["get", "user", "id"])
 * - snake_case (e.g., "get_user_by_id" -> ["get", "user", "id"])
 * - kebab-case (e.g., "get-user" -> ["get", "user"])
 * - alphanumeric boundaries and punctuation removal
 */
export function tokenize(text: string, filterStopwords = true): string[] {
  if (!text || typeof text !== 'string') return [];

  // Split camelCase boundaries: e.g. "getUser" -> "get User", "HTMLParser" -> "HTML Parser"
  const splitCamel = text
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z\d]+)/g, '$1 $2');

  // Replace punctuation, underscores, dashes with spaces
  const clean = splitCamel.replace(/[^a-zA-Z0-9]/g, ' ').toLowerCase();

  const rawTokens = clean.split(/\s+/).filter((t) => t.length > 0);

  if (!filterStopwords) {
    return rawTokens;
  }

  const filtered = rawTokens.filter((token) => !DEFAULT_STOPWORDS.has(token));
  // If filtering removed all tokens (e.g. query was just "to be"), fall back to raw tokens
  return filtered.length > 0 ? filtered : rawTokens;
}

/**
 * Computes cosine similarity between two numeric vectors.
 * Returns a value in [-1, 1], or 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) return 0;
  if (vecA.length !== vecB.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i] ?? 0;
    const b = vecB[i] ?? 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  const sim = dotProduct / denominator;
  // Guard against slight floating-point overflows
  return Math.max(-1, Math.min(1, sim));
}

/**
 * Field weights used in BM25 document representation
 */
const FIELD_WEIGHTS = {
  name: 4.0,
  tags: 3.0,
  description: 1.5,
  parameters: 1.0,
  examples: 1.0,
} as const;

/**
 * Internal representation of a tool indexed for BM25 search
 */
interface IndexedToolDoc {
  tool: ToolDefinition;
  termFrequencies: Map<string, number>;
  docLength: number;
  uniqueTerms: Set<string>;
  normalizedName: string;
  normalizedTags: string[];
}

/**
 * Recursively extract descriptive text and property keys from parameter JSON schemas.
 */
function extractSchemaText(schema: Record<string, any> | undefined): string {
  if (!schema || typeof schema !== 'object') return '';

  const parts: string[] = [];

  if (typeof schema['title'] === 'string') parts.push(schema['title']);
  if (typeof schema['description'] === 'string') parts.push(schema['description']);

  if (schema['properties'] && typeof schema['properties'] === 'object') {
    for (const [propName, propDef] of Object.entries(schema['properties'])) {
      parts.push(propName);
      if (propDef && typeof propDef === 'object') {
        parts.push(extractSchemaText(propDef as Record<string, any>));
      }
    }
  }

  if (schema['items'] && typeof schema['items'] === 'object') {
    parts.push(extractSchemaText(schema['items'] as Record<string, any>));
  }

  return parts.join(' ');
}

/**
 * ToolRegistry indexes tools and provides BM25 lexical and vector semantic search.
 */
export class ToolRegistry implements ToolRegistryInterface {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly indexedDocs = new Map<string, IndexedToolDoc>();
  private readonly docFrequencies = new Map<string, number>();
  private totalDocLength = 0;

  // BM25 tuning parameters
  private readonly k1: number;
  private readonly b: number;

  constructor(options?: { k1?: number; b?: number }) {
    this.k1 = options?.k1 ?? 1.2;
    this.b = options?.b ?? 0.75;
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * Register a tool definition and index it for lexical and semantic search.
   */
  register(tool: ToolDefinition): void {
    if (!tool || !tool.name) {
      throw new Error('ToolDefinition must have a valid non-empty name');
    }

    if (this.tools.has(tool.name)) {
      this.unregister(tool.name);
    }

    this.tools.set(tool.name, tool);
    const indexed = this.buildIndexedDoc(tool);
    this.indexedDocs.set(tool.name, indexed);

    // Update document frequencies and corpus stats
    for (const term of indexed.uniqueTerms) {
      this.docFrequencies.set(term, (this.docFrequencies.get(term) ?? 0) + 1);
    }
    this.totalDocLength += indexed.docLength;
  }

  /**
   * Register multiple tools at once.
   */
  registerMany(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Unregister a tool by name.
   */
  unregister(name: string): boolean {
    const existing = this.indexedDocs.get(name);
    if (!existing) return false;

    for (const term of existing.uniqueTerms) {
      const currentDf = this.docFrequencies.get(term) ?? 0;
      if (currentDf <= 1) {
        this.docFrequencies.delete(term);
      } else {
        this.docFrequencies.set(term, currentDf - 1);
      }
    }

    this.totalDocLength -= existing.docLength;
    this.indexedDocs.delete(name);
    return this.tools.delete(name);
  }

  /**
   * Get a tool definition by name.
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * List all registered tools.
   */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Clear all registered tools from the registry.
   */
  clear(): void {
    this.tools.clear();
    this.indexedDocs.clear();
    this.docFrequencies.clear();
    this.totalDocLength = 0;
  }

  /**
   * Synchronous search over indexed tools.
   */
  searchSync(options: string | ToolSearchOptions): ToolSearchResult[] {
    const opts = typeof options === 'string' ? { query: options } : options;
    return this.executeSearch(opts, undefined);
  }

  /**
   * Asynchronous search over indexed tools (supports asynchronous embedder functions).
   */
  async search(options: string | ToolSearchOptions): Promise<ToolSearchResult[]> {
    const opts = typeof options === 'string' ? { query: options } : options;

    let queryEmbedding = opts.queryEmbedding;
    if (!queryEmbedding && opts.embedder && opts.query.trim().length > 0) {
      const computed = await opts.embedder(opts.query);
      queryEmbedding = computed;
    }

    return this.executeSearch(opts, queryEmbedding);
  }

  private buildIndexedDoc(tool: ToolDefinition): IndexedToolDoc {
    const termFrequencies = new Map<string, number>();
    const uniqueTerms = new Set<string>();

    const addTerms = (text: string, weight: number) => {
      const tokens = tokenize(text, true);
      for (const token of tokens) {
        uniqueTerms.add(token);
        const current = termFrequencies.get(token) ?? 0;
        termFrequencies.set(token, current + weight);
      }
    };

    addTerms(tool.name, FIELD_WEIGHTS.name);

    if (tool.tags && tool.tags.length > 0) {
      for (const tag of tool.tags) {
        addTerms(tag, FIELD_WEIGHTS.tags);
      }
    }

    if (tool.description) {
      addTerms(tool.description, FIELD_WEIGHTS.description);
    }

    if (tool.parameters) {
      const schemaText = extractSchemaText(tool.parameters);
      if (schemaText) {
        addTerms(schemaText, FIELD_WEIGHTS.parameters);
      }
    }

    if (tool.examples && tool.examples.length > 0) {
      for (const example of tool.examples) {
        addTerms(example, FIELD_WEIGHTS.examples);
      }
    }

    let docLength = 0;
    for (const freq of termFrequencies.values()) {
      docLength += freq;
    }

    return {
      tool,
      termFrequencies,
      docLength: Math.max(docLength, 1),
      uniqueTerms,
      normalizedName: tool.name.toLowerCase().trim(),
      normalizedTags: (tool.tags ?? []).map((t) => t.toLowerCase().trim()),
    };
  }

  private executeSearch(
    opts: ToolSearchOptions,
    resolvedQueryEmbedding: number[] | undefined,
  ): ToolSearchResult[] {
    const rawQuery = opts.query ?? '';
    const trimmedQuery = rawQuery.trim();
    if (!trimmedQuery) return [];

    const numDocs = this.tools.size;
    if (numDocs === 0) return [];

    const limit = opts.limit !== undefined ? Math.max(0, opts.limit) : 5;
    if (limit === 0) return [];

    const threshold = opts.threshold ?? 0;
    const requiredTags = opts.tags?.map((t) => t.toLowerCase().trim()) ?? [];
    const tagMatchMode: TagMatchMode = opts.tagMatchMode ?? 'any';

    const queryTokens = tokenize(trimmedQuery, true);
    const avgDocLength = Math.max(this.totalDocLength / numDocs, 1);
    const normalizedQueryLower = trimmedQuery.toLowerCase();

    interface Candidate {
      tool: ToolDefinition;
      lexicalScore: number;
      semanticScore?: number;
      matchedTerms: string[];
      matchedTags: string[];
    }

    const candidates: Candidate[] = [];

    for (const doc of this.indexedDocs.values()) {
      const { tool, termFrequencies, docLength, normalizedName, normalizedTags } = doc;

      // Tag Filtering
      if (requiredTags.length > 0) {
        if (normalizedTags.length === 0) continue;
        if (tagMatchMode === 'all') {
          const hasAll = requiredTags.every((req) => normalizedTags.includes(req));
          if (!hasAll) continue;
        } else {
          const hasAny = requiredTags.some((req) => normalizedTags.includes(req));
          if (!hasAny) continue;
        }
      }

      // BM25 Lexical Scoring
      let bm25Score = 0;
      const matchedTerms: string[] = [];
      const matchedTags: string[] = [];

      for (const token of queryTokens) {
        const tf = termFrequencies.get(token);
        if (tf !== undefined && tf > 0) {
          matchedTerms.push(token);
          const df = this.docFrequencies.get(token) ?? 1;
          // Robertson-Spärck Jones smoothed IDF: strictly positive for all df <= N
          const idf = Math.log(1 + (numDocs - df + 0.5) / (df + 0.5));
          const numerator = tf * (this.k1 + 1);
          const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / avgDocLength));
          bm25Score += idf * (numerator / denominator);
        }
      }

      // Exact Name & Substring Matches Boosts
      let lexicalBonus = 0;
      if (normalizedName === normalizedQueryLower) {
        lexicalBonus += 10.0;
        matchedTerms.push(normalizedName);
      } else if (
        normalizedName.includes(normalizedQueryLower) ||
        normalizedQueryLower.includes(normalizedName)
      ) {
        lexicalBonus += 4.0;
        matchedTerms.push(normalizedName);
      }

      // Exact Tag Match Boosts
      for (const tag of normalizedTags) {
        if (tag === normalizedQueryLower || queryTokens.includes(tag)) {
          lexicalBonus += 2.0;
          if (!matchedTags.includes(tag)) matchedTags.push(tag);
        }
      }

      // Description Exact Phrase Match Boost
      if (
        tool.description &&
        tool.description.toLowerCase().includes(normalizedQueryLower)
      ) {
        lexicalBonus += 1.5;
      }

      const totalLexicalScore = bm25Score + lexicalBonus;

      // Semantic Vector Scoring
      let semanticScore: number | undefined;
      const queryEmbedding = resolvedQueryEmbedding ?? opts.queryEmbedding;
      if (queryEmbedding && tool.embedding) {
        const rawCosine = cosineSimilarity(queryEmbedding, tool.embedding);
        // Normalize cosine similarity to [0, 1] range: non-negative similarity
        semanticScore = Math.max(0, rawCosine);
      }

      candidates.push({
        tool,
        lexicalScore: totalLexicalScore,
        semanticScore,
        matchedTerms: Array.from(new Set(matchedTerms)),
        matchedTags: Array.from(new Set(matchedTags)),
      });
    }

    // Determine alpha weighting
    const hasEmbeddings = candidates.some((c) => c.semanticScore !== undefined);
    const alpha = opts.alpha !== undefined ? Math.max(0, Math.min(1, opts.alpha)) : hasEmbeddings ? 0.5 : 0.0;

    // Normalize lexical score to [0, 1] across candidates for balanced hybrid scoring
    const maxLexical = Math.max(0, ...candidates.map((c) => c.lexicalScore));

    const scoredResults: ToolSearchResult[] = [];

    for (const candidate of candidates) {
      let finalScore = 0;

      if (opts.customScorer) {
        finalScore = opts.customScorer(opts.query, candidate.tool);
      } else if (alpha === 0.0) {
        // Pure lexical
        finalScore = candidate.lexicalScore;
      } else if (alpha === 1.0) {
        // Pure semantic
        finalScore = candidate.semanticScore ?? 0;
      } else {
        // Hybrid blending
        const normalizedLexical = maxLexical > 0 ? candidate.lexicalScore / maxLexical : 0;
        const sem = candidate.semanticScore ?? 0;
        finalScore = (1 - alpha) * normalizedLexical + alpha * sem;
      }

      // Apply threshold filter
      if (finalScore >= threshold) {
        // If query was specific but no lexical or semantic signal matched, skip zero-score candidates
        if (finalScore > 0 || (threshold <= 0 && candidate.lexicalScore > 0)) {
          scoredResults.push({
            tool: candidate.tool,
            score: finalScore,
            lexicalScore: candidate.lexicalScore,
            semanticScore: candidate.semanticScore,
            matchedTerms: candidate.matchedTerms,
            matchedTags: candidate.matchedTags,
          });
        }
      }
    }

    // Sort descending by score; tie-break deterministically by tool name ascending
    scoredResults.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.tool.name.localeCompare(b.tool.name);
    });

    return scoredResults.slice(0, limit);
  }
}

/**
 * Creates the standard `tool_search` meta-tool definition and runner.
 */
export function createToolSearchMetaTool(
  registry: ToolRegistryInterface,
  defaultOptions?: Partial<Omit<ToolSearchOptions, 'query'>>,
): {
  definition: ToolDefinition;
  execute: (input: ToolSearchInput) => Promise<ToolSearchExecutionResult>;
  executeSync: (input: ToolSearchInput) => ToolSearchExecutionResult;
} {
  const definition: ToolDefinition = { ...TOOL_SEARCH_DEFINITION };

  const runSync = (input: ToolSearchInput): ToolSearchExecutionResult => {
    const results = registry.searchSync({
      ...defaultOptions,
      query: input.query,
      limit: input.limit ?? defaultOptions?.limit,
      tags: input.tags ?? defaultOptions?.tags,
    });

    const tools = results.map((r) => r.tool);
    return {
      query: input.query,
      count: tools.length,
      tools,
      results,
      activatedToolNames: tools.map((t) => t.name),
    };
  };

  const run = async (input: ToolSearchInput): Promise<ToolSearchExecutionResult> => {
    const results = await registry.search({
      ...defaultOptions,
      query: input.query,
      limit: input.limit ?? defaultOptions?.limit,
      tags: input.tags ?? defaultOptions?.tags,
    });

    const tools = results.map((r) => r.tool);
    return {
      query: input.query,
      count: tools.length,
      tools,
      results,
      activatedToolNames: tools.map((t) => t.name),
    };
  };

  return {
    definition,
    execute: run,
    executeSync: runSync,
  };
}

/**
 * ToolSessionManager tracks the minimal and dynamically activated tools
 * in an LLM conversation session.
 *
 * Starts with: [tool_search, ...coreTools]
 * When tool_search returns results, matching tools are dynamically activated.
 */
export class ToolSessionManager {
  private readonly registry: ToolRegistryInterface;
  private readonly coreTools = new Map<string, ToolDefinition>();
  private readonly activeTools = new Map<string, ToolDefinition>();
  private readonly searchMetaTool: ToolDefinition;
  private readonly includeSearchMetaTool: boolean;
  private readonly autoActivateOnSearch: boolean;
  private readonly maxActiveTools?: number;
  private readonly defaultSearchOptions?: Partial<Omit<ToolSearchOptions, 'query'>>;

  // Keeps track of activation order for LRU eviction when maxActiveTools is set
  private readonly dynamicActivationOrder: string[] = [];

  constructor(options: ToolSessionManagerOptions) {
    this.registry = options.registry;
    this.searchMetaTool = options.searchMetaTool ?? { ...TOOL_SEARCH_DEFINITION };
    this.includeSearchMetaTool = options.includeSearchMetaTool ?? true;
    this.autoActivateOnSearch = options.autoActivateOnSearch ?? true;
    this.maxActiveTools = options.maxActiveTools;
    this.defaultSearchOptions = options.searchOptions;

    if (options.coreTools) {
      for (const tool of options.coreTools) {
        this.coreTools.set(tool.name, tool);
      }
    }

    this.reset();
  }

  /**
   * Resets active tools back to the minimal set: [tool_search, ...coreTools].
   */
  reset(): void {
    this.activeTools.clear();
    this.dynamicActivationOrder.length = 0;

    if (this.includeSearchMetaTool) {
      this.activeTools.set(this.searchMetaTool.name, this.searchMetaTool);
    }

    for (const [name, tool] of this.coreTools) {
      this.activeTools.set(name, tool);
    }
  }

  /**
   * Returns all currently active tool definitions.
   */
  getActiveTools(): ToolDefinition[] {
    return Array.from(this.activeTools.values());
  }

  /**
   * Returns names of all currently active tools.
   */
  getActiveToolNames(): string[] {
    return Array.from(this.activeTools.keys());
  }

  /**
   * Checks if a tool is currently active in the session.
   */
  hasActiveTool(name: string): boolean {
    return this.activeTools.has(name);
  }

  /**
   * Activate a tool into the active session.
   * Can accept either a ToolDefinition or a tool name (looked up in registry).
   * Returns true if activated, false if tool was already active or not found.
   */
  activateTool(toolOrName: ToolDefinition | string): boolean {
    let tool: ToolDefinition | undefined;

    if (typeof toolOrName === 'string') {
      if (this.activeTools.has(toolOrName)) return false;
      tool = this.registry.get(toolOrName) ?? this.coreTools.get(toolOrName);
      if (!tool) return false;
    } else {
      tool = toolOrName;
      if (this.activeTools.has(tool.name)) return false;
    }

    // Handle capacity constraint by evicting oldest dynamically activated tools
    if (this.maxActiveTools !== undefined && this.maxActiveTools > 0) {
      while (
        this.activeTools.size >= this.maxActiveTools &&
        this.dynamicActivationOrder.length > 0
      ) {
        const oldestName = this.dynamicActivationOrder.shift();
        if (oldestName && !this.coreTools.has(oldestName) && oldestName !== this.searchMetaTool.name) {
          this.activeTools.delete(oldestName);
        }
      }
    }

    this.activeTools.set(tool.name, tool);
    if (!this.coreTools.has(tool.name) && tool.name !== this.searchMetaTool.name) {
      this.dynamicActivationOrder.push(tool.name);
    }

    return true;
  }

  /**
   * Deactivate a tool from the session.
   * Core tools and tool_search are protected unless force is set.
   */
  deactivateTool(name: string, force = false): boolean {
    if (!force && (this.coreTools.has(name) || name === this.searchMetaTool.name)) {
      return false;
    }

    const removed = this.activeTools.delete(name);
    if (removed) {
      const idx = this.dynamicActivationOrder.indexOf(name);
      if (idx !== -1) {
        this.dynamicActivationOrder.splice(idx, 1);
      }
    }
    return removed;
  }

  /**
   * Execute the `tool_search` meta-tool query and automatically activate
   * discovered tools in the session if autoActivateOnSearch is enabled.
   */
  async executeToolSearch(input: ToolSearchInput): Promise<ToolSearchExecutionResult> {
    const results = await this.registry.search({
      ...this.defaultSearchOptions,
      query: input.query,
      limit: input.limit ?? this.defaultSearchOptions?.limit,
      tags: input.tags ?? this.defaultSearchOptions?.tags,
    });

    const matchingTools = results.map((r) => r.tool);
    const newlyActivated: string[] = [];

    if (this.autoActivateOnSearch) {
      for (const tool of matchingTools) {
        if (!this.activeTools.has(tool.name)) {
          const activated = this.activateTool(tool);
          if (activated) newlyActivated.push(tool.name);
        }
      }
    }

    return {
      query: input.query,
      count: matchingTools.length,
      tools: matchingTools,
      results,
      activatedToolNames: newlyActivated,
    };
  }

  /**
   * Synchronous version of executeToolSearch.
   */
  executeToolSearchSync(input: ToolSearchInput): ToolSearchExecutionResult {
    const results = this.registry.searchSync({
      ...this.defaultSearchOptions,
      query: input.query,
      limit: input.limit ?? this.defaultSearchOptions?.limit,
      tags: input.tags ?? this.defaultSearchOptions?.tags,
    });

    const matchingTools = results.map((r) => r.tool);
    const newlyActivated: string[] = [];

    if (this.autoActivateOnSearch) {
      for (const tool of matchingTools) {
        if (!this.activeTools.has(tool.name)) {
          const activated = this.activateTool(tool);
          if (activated) newlyActivated.push(tool.name);
        }
      }
    }

    return {
      query: input.query,
      count: matchingTools.length,
      tools: matchingTools,
      results,
      activatedToolNames: newlyActivated,
    };
  }

  /**
   * Universal tool call dispatcher for the session.
   * If `tool_search` is called, executes search and dynamically activates discovered tools.
   */
  async handleToolCall(name: string, input: Record<string, any>): Promise<any> {
    if (name === this.searchMetaTool.name) {
      const searchInput: ToolSearchInput = {
        query: String(input['query'] ?? ''),
        limit: typeof input['limit'] === 'number' ? input['limit'] : undefined,
        tags: Array.isArray(input['tags']) ? input['tags'] : undefined,
      };
      return await this.executeToolSearch(searchInput);
    }

    throw new Error(`Tool "${name}" is not a managed meta-tool in this session.`);
  }

  /**
   * Synchronous universal tool call dispatcher.
   */
  handleToolCallSync(name: string, input: Record<string, any>): any {
    if (name === this.searchMetaTool.name) {
      const searchInput: ToolSearchInput = {
        query: String(input['query'] ?? ''),
        limit: typeof input['limit'] === 'number' ? input['limit'] : undefined,
        tags: Array.isArray(input['tags']) ? input['tags'] : undefined,
      };
      return this.executeToolSearchSync(searchInput);
    }

    throw new Error(`Tool "${name}" is not a managed meta-tool in this session.`);
  }
}
