import { describe, it, expect, beforeEach } from 'vitest';
import {
  ToolRegistry,
  ToolSessionManager,
  tokenize,
  cosineSimilarity,
  createToolSearchMetaTool,
  TOOL_SEARCH_NAME,
  TOOL_SEARCH_DEFINITION,
  TOOL_SEARCH_PARAMETERS_SCHEMA,
  type ToolDefinition,
} from '../../src/tools/tool-search.js';

describe('Tool Search and Dynamic Activation Engine', () => {
  // Sample tools for testing
  const weatherTool: ToolDefinition = {
    name: 'get_current_weather',
    description: 'Fetch real-time weather information and forecast for a given location or city',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City and state, e.g. San Francisco, CA' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Temperature scale' },
      },
      required: ['location'],
    },
    tags: ['weather', 'climate', 'forecast'],
    examples: ['get_current_weather({ location: "Tokyo, Japan" })'],
    embedding: [0.9, 0.1, 0.0, 0.0],
  };

  const sqlTool: ToolDefinition = {
    name: 'sql_query_runner',
    description: 'Execute read-only SQL queries against the analytical database',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The SQL SELECT query to run' },
        timeoutSeconds: { type: 'number', description: 'Query timeout in seconds' },
      },
      required: ['query'],
    },
    tags: ['database', 'sql', 'analytics'],
    examples: ['sql_query_runner({ query: "SELECT count(*) FROM users" })'],
    embedding: [0.0, 0.9, 0.1, 0.0],
  };

  const emailTool: ToolDefinition = {
    name: 'send_email_notification',
    description: 'Send an email notification or alert to one or more recipient email addresses',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email message body text' },
      },
      required: ['to', 'subject', 'body'],
    },
    tags: ['communication', 'email', 'notification'],
    examples: ['send_email_notification({ to: "user@example.com", subject: "Alert", body: "Hello" })'],
    embedding: [0.0, 0.0, 0.9, 0.1],
  };

  const calculatorTool: ToolDefinition = {
    name: 'calculator',
    description: 'Evaluate mathematical arithmetic expressions and statistical calculations',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Mathematical expression e.g. (2 + 3) * 4' },
      },
      required: ['expression'],
    },
    tags: ['math', 'calculation', 'utility'],
    examples: ['calculator({ expression: "sqrt(16) + 10" })'],
    embedding: [0.1, 0.0, 0.1, 0.9],
  };

  const coreSearchTool: ToolDefinition = {
    name: 'browse_web',
    description: 'Browse the web and fetch URL contents',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Web page URL' },
      },
      required: ['url'],
    },
    tags: ['core', 'web'],
  };

  describe('Tokenizer & Vector Utilities', () => {
    it('splits camelCase, snake_case, and kebab-case tokens', () => {
      expect(tokenize('getUserById')).toEqual(['get', 'user', 'id']);
      expect(tokenize('get_current_weather')).toEqual(['get', 'current', 'weather']);
      expect(tokenize('send-email-notification')).toEqual(['send', 'email', 'notification']);
    });

    it('retains tokens when query consists only of stopwords', () => {
      const tokens = tokenize('to be or not to be');
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens).toContain('be');
      expect(tokens).toContain('to');
    });

    it('computes cosine similarity accurately', () => {
      // Identical vectors
      expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 5);
      // Orthogonal vectors
      expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 5);
      // Opposing vectors
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5);
      // Proportional vectors
      expect(cosineSimilarity([2, 4], [1, 2])).toBeCloseTo(1.0, 5);
      // Zero vectors / empty
      expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
      expect(cosineSimilarity([], [])).toBe(0);
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });
  });

  describe('ToolRegistry', () => {
    let registry: ToolRegistry;

    beforeEach(() => {
      registry = new ToolRegistry();
    });

    it('registers and retrieves tool definitions', () => {
      registry.register(weatherTool);
      expect(registry.size).toBe(1);
      expect(registry.has('get_current_weather')).toBe(true);
      expect(registry.get('get_current_weather')).toEqual(weatherTool);
      expect(registry.list()).toEqual([weatherTool]);
    });

    it('rejects registering invalid tools without name', () => {
      expect(() => registry.register({} as any)).toThrow();
      expect(() => registry.register({ name: '' } as any)).toThrow();
    });

    it('registers multiple tools at once', () => {
      registry.registerMany([weatherTool, sqlTool, emailTool, calculatorTool]);
      expect(registry.size).toBe(4);
      expect(registry.has('calculator')).toBe(true);
      expect(registry.has('sql_query_runner')).toBe(true);
    });

    it('unregisters tools and updates index cleanly', () => {
      registry.registerMany([weatherTool, sqlTool]);
      expect(registry.size).toBe(2);

      const removed = registry.unregister('get_current_weather');
      expect(removed).toBe(true);
      expect(registry.size).toBe(1);
      expect(registry.has('get_current_weather')).toBe(false);
      expect(registry.get('get_current_weather')).toBeUndefined();

      // Search should no longer return unregistered tool
      const results = registry.searchSync('weather');
      expect(results.length).toBe(0);
    });

    it('updating an existing tool replaces previous index entries', () => {
      registry.register(weatherTool);
      const updatedWeather: ToolDefinition = {
        ...weatherTool,
        description: 'New satellite imaging for hurricanes and typhoons',
        tags: ['satellite', 'cyclone'],
      };
      registry.register(updatedWeather);

      expect(registry.size).toBe(1);
      const results = registry.searchSync('satellite cyclone');
      expect(results.length).toBe(1);
      expect(results[0]?.tool.description).toContain('satellite imaging');
    });

    it('clears all registered tools', () => {
      registry.registerMany([weatherTool, sqlTool]);
      registry.clear();
      expect(registry.size).toBe(0);
      expect(registry.list()).toEqual([]);
      expect(registry.searchSync('sql').length).toBe(0);
    });
  });

  describe('Search & Ranking Engine', () => {
    let registry: ToolRegistry;

    beforeEach(() => {
      registry = new ToolRegistry();
      registry.registerMany([weatherTool, sqlTool, emailTool, calculatorTool]);
    });

    it('ranks exact name match highest with boost', () => {
      const results = registry.searchSync('calculator');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.tool.name).toBe('calculator');
    });

    it('ranks tools by keywords in description', () => {
      const results = registry.searchSync('forecast temperature');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.tool.name).toBe('get_current_weather');
    });

    it('ranks tools by tags with tag boost', () => {
      const results = registry.searchSync('analytics');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.tool.name).toBe('sql_query_runner');
      expect(results[0]?.matchedTags).toContain('analytics');
    });

    it('matches terms in parameter descriptions', () => {
      const results = registry.searchSync('recipient subject');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.tool.name).toBe('send_email_notification');
    });

    it('filters results by tag filter', () => {
      const results = registry.searchSync({
        query: 'query run',
        tags: ['database'],
      });
      expect(results.length).toBe(1);
      expect(results[0]?.tool.name).toBe('sql_query_runner');

      // Tag filter excluding all tools
      const emptyResults = registry.searchSync({
        query: 'query',
        tags: ['nonexistent-tag'],
      });
      expect(emptyResults.length).toBe(0);
    });

    it('supports tagMatchMode all vs any', () => {
      const resultsAny = registry.searchSync({
        query: 'data',
        tags: ['database', 'nonexistent'],
        tagMatchMode: 'any',
      });
      expect(resultsAny.length).toBe(1);
      expect(resultsAny[0]?.tool.name).toBe('sql_query_runner');

      const resultsAll = registry.searchSync({
        query: 'data',
        tags: ['database', 'nonexistent'],
        tagMatchMode: 'all',
      });
      expect(resultsAll.length).toBe(0);
    });

    it('respects limit and threshold parameters', () => {
      const results = registry.searchSync({
        query: 'query weather email calculate',
        limit: 2,
      });
      expect(results.length).toBe(2);

      const highThresholdResults = registry.searchSync({
        query: 'weather',
        threshold: 999.0,
      });
      expect(highThresholdResults.length).toBe(0);
    });

    it('returns empty array on empty or whitespace query', () => {
      expect(registry.searchSync('')).toEqual([]);
      expect(registry.searchSync('   ')).toEqual([]);
    });

    it('performs semantic vector search when queryEmbedding is provided', async () => {
      // Query embedding matches weather vector closely [0.9, 0.1, 0.0, 0.0]
      const results = await registry.search({
        query: 'what is the weather like',
        queryEmbedding: [1.0, 0.0, 0.0, 0.0],
        alpha: 1.0, // pure semantic
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.tool.name).toBe('get_current_weather');
      expect(results[0]?.semanticScore).toBeGreaterThan(0.9);
    });

    it('supports on-the-fly async embedder function', async () => {
      const mockEmbedder = async (text: string) => {
        if (text.includes('database') || text.includes('sql')) {
          return [0.0, 1.0, 0.0, 0.0];
        }
        return [0.0, 0.0, 0.0, 0.0];
      };

      const results = await registry.search({
        query: 'query database table',
        embedder: mockEmbedder,
        alpha: 0.8,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.tool.name).toBe('sql_query_runner');
      expect(results[0]?.semanticScore).toBeGreaterThan(0.95);
    });

    it('performs hybrid search blending lexical and semantic scores', async () => {
      const results = await registry.search({
        query: 'forecast climate',
        queryEmbedding: [0.95, 0.05, 0.0, 0.0],
        alpha: 0.5,
      });

      expect(results.length).toBeGreaterThan(0);
      const top = results[0]!;
      expect(top.tool.name).toBe('get_current_weather');
      expect(top.lexicalScore).toBeGreaterThan(0);
      expect(top.semanticScore).toBeGreaterThan(0.8);
      expect(top.score).toBeGreaterThan(0);
    });

    it('supports customScorer to augment scoring logic', () => {
      const customScorer = (_query: string, tool: ToolDefinition) => {
        return tool.name === 'calculator' ? 100 : 1;
      };

      const results = registry.searchSync({
        query: 'any query',
        customScorer,
      });

      expect(results[0]?.tool.name).toBe('calculator');
      expect(results[0]?.score).toBe(100);
    });
  });

  describe('Meta-Tool tool_search', () => {
    let registry: ToolRegistry;

    beforeEach(() => {
      registry = new ToolRegistry();
      registry.registerMany([weatherTool, sqlTool, emailTool, calculatorTool]);
    });

    it('defines standard tool_search schema with correct parameters', () => {
      expect(TOOL_SEARCH_DEFINITION.name).toBe(TOOL_SEARCH_NAME);
      expect(TOOL_SEARCH_DEFINITION.parameters).toEqual(TOOL_SEARCH_PARAMETERS_SCHEMA);
      expect(TOOL_SEARCH_PARAMETERS_SCHEMA.properties.query).toBeDefined();
      expect(TOOL_SEARCH_PARAMETERS_SCHEMA.required).toContain('query');
    });

    it('executes search query and returns matching tool declarations', async () => {
      const metaTool = createToolSearchMetaTool(registry);
      const output = await metaTool.execute({ query: 'math arithmetic expression' });

      expect(output.query).toBe('math arithmetic expression');
      expect(output.count).toBeGreaterThan(0);
      expect(output.tools.map((t) => t.name)).toContain('calculator');
      expect(output.activatedToolNames).toContain('calculator');
    });

    it('handles limit and tag filters in meta-tool execution', () => {
      const metaTool = createToolSearchMetaTool(registry);
      const output = metaTool.executeSync({
        query: 'forecast weather email',
        limit: 1,
        tags: ['weather'],
      });

      expect(output.count).toBe(1);
      expect(output.tools[0]?.name).toBe('get_current_weather');
    });
  });

  describe('ToolSessionManager & Dynamic Tool Activation', () => {
    let registry: ToolRegistry;

    beforeEach(() => {
      registry = new ToolRegistry();
      registry.registerMany([weatherTool, sqlTool, emailTool, calculatorTool]);
    });

    it('starts with minimal set [tool_search, ...coreTools]', () => {
      const session = new ToolSessionManager({
        registry,
        coreTools: [coreSearchTool],
      });

      const active = session.getActiveTools();
      expect(active.length).toBe(2);
      expect(session.getActiveToolNames()).toEqual([TOOL_SEARCH_NAME, 'browse_web']);
      expect(session.hasActiveTool(TOOL_SEARCH_NAME)).toBe(true);
      expect(session.hasActiveTool('browse_web')).toBe(true);
      expect(session.hasActiveTool('get_current_weather')).toBe(false);
    });

    it('dynamically activates discovered tools on tool_search execution', async () => {
      const session = new ToolSessionManager({
        registry,
        coreTools: [coreSearchTool],
      });

      expect(session.hasActiveTool('get_current_weather')).toBe(false);

      // Execute search for weather capability
      const searchResult = await session.executeToolSearch({ query: 'check weather in city' });

      expect(searchResult.tools.length).toBeGreaterThan(0);
      expect(searchResult.activatedToolNames).toContain('get_current_weather');

      // Now weather tool must be active in the session
      expect(session.hasActiveTool('get_current_weather')).toBe(true);
      const activeNames = session.getActiveToolNames();
      expect(activeNames).toContain('get_current_weather');
      expect(activeNames).toContain('browse_web');
      expect(activeNames).toContain(TOOL_SEARCH_NAME);

      // Other non-matching tools remain inactive
      expect(session.hasActiveTool('sql_query_runner')).toBe(false);
    });

    it('handles universal tool call dispatch via handleToolCall for tool_search', async () => {
      const session = new ToolSessionManager({
        registry,
      });

      const result = await session.handleToolCall(TOOL_SEARCH_NAME, {
        query: 'database sql query',
      });

      expect(result.count).toBeGreaterThan(0);
      expect(session.hasActiveTool('sql_query_runner')).toBe(true);
    });

    it('synchronously executes tool search and dynamic activation', () => {
      const session = new ToolSessionManager({
        registry,
      });

      const result = session.executeToolSearchSync({ query: 'math calculator' });
      expect(result.count).toBe(1);
      expect(result.activatedToolNames).toEqual(['calculator']);
      expect(session.hasActiveTool('calculator')).toBe(true);
    });

    it('does not duplicate active tools upon repeat search', async () => {
      const session = new ToolSessionManager({
        registry,
      });

      await session.executeToolSearch({ query: 'weather' });
      const initialCount = session.getActiveTools().length;

      // Repeat same search
      const repeatResult = await session.executeToolSearch({ query: 'weather' });
      expect(repeatResult.activatedToolNames.length).toBe(0); // already active
      expect(session.getActiveTools().length).toBe(initialCount);
    });

    it('manually activates and deactivates tools', () => {
      const session = new ToolSessionManager({
        registry,
        coreTools: [coreSearchTool],
      });

      expect(session.activateTool('sql_query_runner')).toBe(true);
      expect(session.hasActiveTool('sql_query_runner')).toBe(true);

      // Activating already active tool returns false
      expect(session.activateTool('sql_query_runner')).toBe(false);

      // Deactivate tool
      expect(session.deactivateTool('sql_query_runner')).toBe(true);
      expect(session.hasActiveTool('sql_query_runner')).toBe(false);

      // Core tools and tool_search cannot be deactivated without force
      expect(session.deactivateTool('browse_web')).false;
      expect(session.deactivateTool(TOOL_SEARCH_NAME)).false;
      expect(session.hasActiveTool('browse_web')).toBe(true);
    });

    it('resets session to initial core tools and tool_search', async () => {
      const session = new ToolSessionManager({
        registry,
        coreTools: [coreSearchTool],
      });

      await session.executeToolSearch({ query: 'weather' });
      await session.executeToolSearch({ query: 'database' });
      expect(session.getActiveTools().length).toBe(4);

      session.reset();
      expect(session.getActiveToolNames()).toEqual([TOOL_SEARCH_NAME, 'browse_web']);
      expect(session.hasActiveTool('get_current_weather')).toBe(false);
      expect(session.hasActiveTool('sql_query_runner')).toBe(false);
    });

    it('enforces maxActiveTools capacity limit with LRU eviction of dynamic tools', () => {
      const session = new ToolSessionManager({
        registry,
        coreTools: [coreSearchTool],
        maxActiveTools: 3, // [tool_search, browse_web] = 2 core + 1 dynamic capacity
      });

      // Activate first dynamic tool
      session.activateTool('get_current_weather');
      expect(session.getActiveToolNames()).toEqual([TOOL_SEARCH_NAME, 'browse_web', 'get_current_weather']);

      // Activate second dynamic tool - should evict get_current_weather
      session.activateTool('sql_query_runner');
      expect(session.getActiveToolNames()).toEqual([TOOL_SEARCH_NAME, 'browse_web', 'sql_query_runner']);
      expect(session.hasActiveTool('get_current_weather')).toBe(false);
      expect(session.hasActiveTool('sql_query_runner')).toBe(true);
    });
  });
});
