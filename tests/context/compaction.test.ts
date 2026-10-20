import { describe, expect, it, vi } from 'vitest';
import {
  CompactionManager,
  createCompactionMiddleware,
  defaultStructuredSummarizer,
  estimateContentTokens,
  estimateMessageTokens,
  estimateStringTokens,
  estimateTokens,
  groupMessagesIntoTurns,
  parseStructuredSummary,
  resolveConfig,
} from '../../src/context/compaction.js';
import type { CompactionConfig, Message } from '../../src/context/types.js';

describe('Token Estimation', () => {
  it('estimates string tokens accurately using the chars/4 heuristic', () => {
    expect(estimateStringTokens('')).toBe(0);
    expect(estimateStringTokens('abcd')).toBe(1);
    expect(estimateStringTokens('abcdefgh')).toBe(2);
    expect(estimateStringTokens('a')).toBe(1);
    expect(estimateStringTokens('A short conversational message')).toBe(Math.ceil(30 / 4));
  });

  it('estimates content tokens for strings, arrays, and structured objects', () => {
    expect(estimateContentTokens(null)).toBe(0);
    expect(estimateContentTokens(undefined)).toBe(0);
    expect(estimateContentTokens('test string')).toBe(3);

    // Array of text blocks (Anthropic style)
    const blocks = [
      { type: 'text', text: 'Hello from assistant' },
      { type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'test' } },
    ];
    const estimated = estimateContentTokens(blocks);
    expect(estimated).toBeGreaterThan(5);

    // Array with plain strings
    expect(estimateContentTokens(['hello', 'world'])).toBe(
      estimateStringTokens('hello') + estimateStringTokens('world')
    );

    // Arbitrary object
    const obj = { key: 'value', count: 42 };
    expect(estimateContentTokens(obj)).toBe(estimateStringTokens(JSON.stringify(obj)));
  });

  it('includes message overhead and metadata in message token estimation', () => {
    const msgWithoutMeta: Message = { role: 'user', content: '1234' };
    // 4 overhead + 1 content token = 5
    expect(estimateMessageTokens(msgWithoutMeta)).toBe(5);

    const msgWithMeta: Message = {
      role: 'user',
      content: '1234',
      metadata: { sessionId: 'xyz' },
    };
    expect(estimateMessageTokens(msgWithMeta)).toBeGreaterThan(5);
  });

  it('aggregates tokens across an array of messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const total = estimateTokens(messages);
    const sum = messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
    expect(total).toBe(sum);
  });
});

describe('Turn Grouping and Config Resolution', () => {
  it('resolves default compaction configuration', () => {
    const resolved = resolveConfig({ maxTokens: 4000 });
    expect(resolved.maxTokens).toBe(4000);
    expect(resolved.compactionThresholdRatio).toBe(0.75);
    expect(resolved.preserveRecentTurns).toBe(3);
    expect(resolved.turnStrategy).toBe('exchange');
    expect(typeof resolved.tokenEstimator).toBe('function');
  });

  it('groups messages into conversational turns by user boundary in exchange mode', () => {
    const messages: Message[] = [
      { role: 'user', content: 'User 1' },
      { role: 'assistant', content: 'Assistant 1' },
      { role: 'tool', content: 'Tool 1 result' },
      { role: 'assistant', content: 'Assistant 1 followup' },
      { role: 'user', content: 'User 2' },
      { role: 'assistant', content: 'Assistant 2' },
    ];

    const turns = groupMessagesIntoTurns(messages, 'exchange');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toHaveLength(4);
    expect(turns[0]?.[0]?.content).toBe('User 1');
    expect(turns[1]).toHaveLength(2);
    expect(turns[1]?.[0]?.content).toBe('User 2');
  });

  it('groups messages individually in message mode', () => {
    const messages: Message[] = [
      { role: 'user', content: 'User 1' },
      { role: 'assistant', content: 'Assistant 1' },
      { role: 'user', content: 'User 2' },
    ];
    const turns = groupMessagesIntoTurns(messages, 'message');
    expect(turns).toHaveLength(3);
    expect(turns[0]).toHaveLength(1);
    expect(turns[1]).toHaveLength(1);
    expect(turns[2]).toHaveLength(1);
  });
});

describe('Structured Summarizer', () => {
  it('generates structured summary with Goal, Decisions, and State inside <summary> tags', async () => {
    const history: Message[] = [
      { role: 'user', content: 'Please review issue #102 and fix the bug' },
      { role: 'assistant', content: 'I inspected the stack trace and found a null pointer in worker.ts' },
      { role: 'tool', content: 'git diff output: modified worker.ts to guard against null' },
      { role: 'assistant', content: 'Applied the fix and verified tests pass' },
    ];

    const summary = await defaultStructuredSummarizer(history);
    expect(summary).toContain('<summary>');
    expect(summary).toContain('</summary>');
    expect(summary).toContain('<goal>');
    expect(summary).toContain('</goal>');
    expect(summary).toContain('<decisions>');
    expect(summary).toContain('</decisions>');
    expect(summary).toContain('<state>');
    expect(summary).toContain('</state>');

    const parsed = parseStructuredSummary(summary);
    expect(parsed).not.toBeNull();
    expect(parsed?.goal).toContain('Please review issue #102 and fix the bug');
    expect(parsed?.decisions).toContain('inspected the stack trace');
    expect(parsed?.state).toContain('Tool result:');
  });

  it('rolls forward previously compacted summaries iteratively', async () => {
    const initialSummary = [
      '<summary>',
      '<goal>',
      '- Original task: migrate database to Cloudflare D1',
      '</goal>',
      '<decisions>',
      '- Created migration table scripts',
      '</decisions>',
      '<state>',
      '- Tables created in staging',
      '</state>',
      '</summary>',
    ].join('\n');

    const historyWithOldSummary: Message[] = [
      { role: 'user', content: initialSummary },
      { role: 'user', content: 'Next step: run verification queries' },
      { role: 'assistant', content: 'Ran verification queries successfully' },
    ];

    const newSummary = await defaultStructuredSummarizer(historyWithOldSummary);
    const parsed = parseStructuredSummary(newSummary);

    expect(parsed?.goal).toContain('Original task: migrate database to Cloudflare D1');
    expect(parsed?.goal).toContain('Next step: run verification queries');
    expect(parsed?.decisions).toContain('Created migration table scripts');
    expect(parsed?.decisions).toContain('Ran verification queries successfully');
    expect(parsed?.state).toContain('Tables created in staging');
  });
});

describe('CompactionManager Execution & Threshold Checks', () => {
  function createConversation(turnCount: number, charsPerTurn = 400): Message[] {
    const msgs: Message[] = [
      { role: 'system', content: 'You are an autonomous AI development agent.' },
    ];
    for (let i = 1; i <= turnCount; i++) {
      msgs.push({
        role: 'user',
        content: `User query for turn ${i}: ${'x'.repeat(charsPerTurn)}`,
      });
      msgs.push({
        role: 'assistant',
        content: `Assistant response for turn ${i}: ${'y'.repeat(charsPerTurn)}`,
      });
    }
    return msgs;
  }

  it('does not compact when token estimate is below threshold', async () => {
    const config: CompactionConfig = {
      maxTokens: 50_000,
      compactionThresholdRatio: 0.75, // 37,500 threshold
      preserveRecentTurns: 3,
    };
    const manager = new CompactionManager(config);
    const messages = createConversation(4); // ~800 tokens

    expect(manager.shouldCompact(messages)).toBe(false);

    const result = await manager.compact(messages);
    expect(result.compacted).toBe(false);
    expect(result.messages).toHaveLength(messages.length);
    expect(result.summarizedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it('triggers compaction when tokens exceed maxTokens * compactionThresholdRatio', async () => {
    // 5 turns: ~1,000 tokens
    const messages = createConversation(5, 400);
    const tokenCount = estimateTokens(messages);

    // Set maxTokens such that threshold (0.75 * tokenCount * 0.9) is exceeded
    const manager = new CompactionManager({
      maxTokens: Math.floor(tokenCount * 0.9),
      compactionThresholdRatio: 0.75,
      preserveRecentTurns: 2,
    });

    expect(manager.shouldCompact(messages)).toBe(true);

    const result = await manager.compact(messages);
    expect(result.compacted).toBe(true);
    expect(result.compactedTokens).toBeLessThan(result.originalTokens);
  });

  it('respects force option even if tokens are below threshold', async () => {
    const manager = new CompactionManager({
      maxTokens: 100_000,
      compactionThresholdRatio: 0.75,
      preserveRecentTurns: 2,
    });
    const messages = createConversation(5);

    expect(manager.shouldCompact(messages)).toBe(false);

    const result = await manager.compact(messages, { force: true });
    expect(result.compacted).toBe(true);
    expect(result.summary).toBeDefined();
  });
});

describe('Preservation of System Messages and Recent Window', () => {
  it('preserves multiple leading system messages at the head', async () => {
    const system1: Message = { role: 'system', content: 'Primary system instructions.' };
    const system2: Message = { role: 'system', content: 'Tool execution safety bounds.' };

    const messages: Message[] = [
      system1,
      system2,
      { role: 'user', content: 'Turn 1: Setup workspace ' + 'a'.repeat(200) },
      { role: 'assistant', content: 'Turn 1: Workspace ready ' + 'b'.repeat(200) },
      { role: 'user', content: 'Turn 2: Run migration ' + 'c'.repeat(200) },
      { role: 'assistant', content: 'Turn 2: Migrated ' + 'd'.repeat(200) },
      { role: 'user', content: 'Turn 3: Run tests ' + 'e'.repeat(200) },
      { role: 'assistant', content: 'Turn 3: Tests pass ' + 'f'.repeat(200) },
      { role: 'user', content: 'Turn 4: Final checks ' + 'g'.repeat(200) },
      { role: 'assistant', content: 'Turn 4: All clear ' + 'h'.repeat(200) },
    ];

    const manager = new CompactionManager({
      maxTokens: 500,
      compactionThresholdRatio: 0.5,
      preserveRecentTurns: 2,
    });

    const result = await manager.compact(messages);
    expect(result.compacted).toBe(true);
    expect(result.preservedSystemCount).toBe(2);

    // Head preservation check
    expect(result.messages[0]).toEqual(system1);
    expect(result.messages[1]).toEqual(system2);

    // Summary insertion check at position right after preserved system messages
    expect(result.messages[2]?.role).toBe('user');
    expect(result.messages[2]?.content).toContain('<summary>');
    expect(result.messages[2]?.metadata?.isCompactedSummary).toBe(true);

    // Tail preservation check: last 2 turns (Turn 3 and Turn 4)
    const tail = result.messages.slice(3);
    expect(tail).toHaveLength(4);
    expect(tail[0]?.content).toContain('Turn 3: Run tests');
    expect(tail[1]?.content).toContain('Turn 3: Tests pass');
    expect(tail[2]?.content).toContain('Turn 4: Final checks');
    expect(tail[3]?.content).toContain('Turn 4: All clear');
  });

  it('works correctly when no system messages exist in the conversation', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'Turn 1 ' + 'w'.repeat(200) },
      { role: 'assistant', content: 'Reply 1 ' + 'x'.repeat(200) },
      { role: 'user', content: 'Turn 2 ' + 'y'.repeat(200) },
      { role: 'assistant', content: 'Reply 2 ' + 'z'.repeat(200) },
      { role: 'user', content: 'Turn 3 ' + '1'.repeat(200) },
      { role: 'assistant', content: 'Reply 3 ' + '2'.repeat(200) },
    ];

    const manager = new CompactionManager({
      maxTokens: 300,
      compactionThresholdRatio: 0.5,
      preserveRecentTurns: 1,
    });

    const result = await manager.compact(messages);
    expect(result.compacted).toBe(true);
    expect(result.preservedSystemCount).toBe(0);

    // First message must be the summary
    expect(result.messages[0]?.role).toBe('user');
    expect(result.messages[0]?.content).toContain('<summary>');

    // Recent 1 turn preserved at tail
    expect(result.messages[1]?.content).toContain('Turn 3');
    expect(result.messages[2]?.content).toContain('Reply 3');
  });

  it('preserves multi-message turns including tool results intact', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Turn 1 user request ' + 'a'.repeat(200) },
      { role: 'assistant', content: 'Turn 1 assistant answer ' + 'b'.repeat(200) },
      // Turn 2 has tool use and tool result
      { role: 'user', content: 'Turn 2 fetch data ' + 'c'.repeat(200) },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'fetch' }] },
      { role: 'tool', content: 'data payload 12345' },
      { role: 'assistant', content: 'Turn 2 resolved with data' },
    ];

    const manager = new CompactionManager({
      maxTokens: 400,
      compactionThresholdRatio: 0.5,
      preserveRecentTurns: 1,
    });

    const result = await manager.compact(messages);
    expect(result.compacted).toBe(true);

    // Preserved tail must contain all 4 messages of Turn 2
    const tail = result.messages.slice(2);
    expect(tail).toHaveLength(4);
    expect(tail[0]?.role).toBe('user');
    expect(tail[1]?.role).toBe('assistant');
    expect(tail[2]?.role).toBe('tool');
    expect(tail[3]?.role).toBe('assistant');
  });

  it('never separates a tool result from the call it answers', async () => {
    // The shape this app stores is a tool result inside a user entry, not a separate tool role.
    const blocks = (content: unknown): { type: string; id?: string; tool_use_id?: string }[] =>
      Array.isArray(content) ? content as { type: string; id?: string; tool_use_id?: string }[] : [];
    const messages: Message[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Investigate' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'github_read_issues' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'result' }] },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'steer' },
    ];

    for (const preserveRecentTurns of [1, 2, 3]) {
      const manager = new CompactionManager({ maxTokens: 1, preserveRecentTurns, summarizer: async () => '<summary>done</summary>' });
      const result = await manager.compact(messages, { force: true });
      const kept = result.messages.filter(message => !message.metadata?.isCompactedSummary);
      const calls = new Set(kept.flatMap(message => blocks(message.content).filter(block => block.type === 'tool_use').map(block => block.id)));
      const results = kept.flatMap(message => blocks(message.content).filter(block => block.type === 'tool_result').map(block => block.tool_use_id));
      expect(results.filter(id => id !== undefined && !calls.has(id))).toEqual([]);
    }
  });

  it('does not compact when total turns are less than or equal to preserveRecentTurns', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Turn 1 ' + 'm'.repeat(500) },
      { role: 'assistant', content: 'Reply 1 ' + 'n'.repeat(500) },
      { role: 'user', content: 'Turn 2 ' + 'o'.repeat(500) },
      { role: 'assistant', content: 'Reply 2 ' + 'p'.repeat(500) },
    ];

    // Even though tokens exceed maxTokens, preserveRecentTurns is 2 so nothing can be summarized
    const manager = new CompactionManager({
      maxTokens: 200,
      compactionThresholdRatio: 0.5,
      preserveRecentTurns: 2,
    });

    const result = await manager.compact(messages);
    expect(result.compacted).toBe(false);
    expect(result.messages).toHaveLength(messages.length);
  });
});

describe('Custom Summarizer and Config Upgrades', () => {
  it('supports custom summarizer function', async () => {
    const customSummarizer = vi.fn(async (history: Message[]) => {
      return `<summary>\nCustom summary over ${history.length} pruned messages.\n</summary>`;
    });

    const manager = new CompactionManager({
      maxTokens: 400,
      compactionThresholdRatio: 0.5,
      preserveRecentTurns: 1,
      summarizer: customSummarizer,
    });

    const messages: Message[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Old user ' + 'a'.repeat(200) },
      { role: 'assistant', content: 'Old assistant ' + 'b'.repeat(200) },
      { role: 'user', content: 'Recent user ' + 'c'.repeat(200) },
      { role: 'assistant', content: 'Recent assistant ' + 'd'.repeat(200) },
    ];

    const result = await manager.compact(messages);
    expect(result.compacted).toBe(true);
    expect(customSummarizer).toHaveBeenCalledTimes(1);
    expect(result.summary).toContain('Custom summary over 2 pruned messages.');
    expect(result.messages[1]?.content).toContain('Custom summary over 2 pruned messages.');
  });

  it('automatically encloses custom summary in <summary> tags if omitted', async () => {
    const rawCustomSummarizer = vi.fn(async () => 'Raw summary without xml tags');

    const manager = new CompactionManager({
      maxTokens: 400,
      compactionThresholdRatio: 0.5,
      preserveRecentTurns: 1,
      summarizer: rawCustomSummarizer,
    });

    const messages: Message[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Turn 1 ' + 'a'.repeat(200) },
      { role: 'assistant', content: 'Turn 1 reply ' + 'b'.repeat(200) },
      { role: 'user', content: 'Turn 2 ' + 'c'.repeat(200) },
      { role: 'assistant', content: 'Turn 2 reply ' + 'd'.repeat(200) },
    ];

    const result = await manager.compact(messages);
    expect(result.compacted).toBe(true);
    expect(result.messages[1]?.content).toBe('<summary>\nRaw summary without xml tags\n</summary>');
  });

  it('updates configuration dynamically via updateConfig', async () => {
    const manager = new CompactionManager({
      maxTokens: 10_000,
      compactionThresholdRatio: 0.8,
      preserveRecentTurns: 3,
    });

    expect(manager.getConfig().maxTokens).toBe(10_000);
    expect(manager.getConfig().preserveRecentTurns).toBe(3);

    manager.updateConfig({ maxTokens: 2_000, preserveRecentTurns: 1 });
    expect(manager.getConfig().maxTokens).toBe(2_000);
    expect(manager.getConfig().preserveRecentTurns).toBe(1);
  });
});

describe('Compaction Middleware Helper', () => {
  it('functions as a standalone message transformer when next is omitted', async () => {
    const middleware = createCompactionMiddleware({
      maxTokens: 400,
      compactionThresholdRatio: 0.5,
      preserveRecentTurns: 1,
    });

    const messages: Message[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Turn 1 ' + '1'.repeat(200) },
      { role: 'assistant', content: 'Reply 1 ' + '2'.repeat(200) },
      { role: 'user', content: 'Turn 2 ' + '3'.repeat(200) },
      { role: 'assistant', content: 'Reply 2 ' + '4'.repeat(200) },
    ];

    const compacted = await middleware(messages);
    expect(Array.isArray(compacted)).toBe(true);
    expect(compacted[0]?.role).toBe('system');
    expect(compacted[1]?.role).toBe('user');
    expect(compacted[1]?.content).toContain('<summary>');
    expect(compacted[2]?.content).toContain('Turn 2');
  });

  it('pipes compacted messages to next handler in middleware chain', async () => {
    const manager = new CompactionManager({
      maxTokens: 400,
      compactionThresholdRatio: 0.5,
      preserveRecentTurns: 1,
    });
    const middleware = manager.createMiddleware();

    const messages: Message[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Turn 1 ' + '1'.repeat(200) },
      { role: 'assistant', content: 'Reply 1 ' + '2'.repeat(200) },
      { role: 'user', content: 'Turn 2 ' + '3'.repeat(200) },
      { role: 'assistant', content: 'Reply 2 ' + '4'.repeat(200) },
    ];

    const downstreamModel = vi.fn(async (finalMessages: Message[]) => {
      return {
        role: 'assistant',
        content: `Simulated model response for ${finalMessages.length} input messages`,
      };
    });

    const response = await middleware(messages, downstreamModel);
    expect(downstreamModel).toHaveBeenCalledTimes(1);
    const passedMessages = downstreamModel.mock.calls[0]?.[0];
    expect(passedMessages).toBeDefined();
    expect(passedMessages?.[1]?.content).toContain('<summary>');
    expect(response.content).toContain('Simulated model response for 4 input messages');
  });
});
