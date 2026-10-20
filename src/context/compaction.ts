import type {
  CompactionConfig,
  CompactionMiddleware,
  CompactionResult,
  Message,
  ResolvedCompactionConfig,
  StructuredSummary,
  TurnStrategy,
} from './types.js';

/**
 * Fast token estimator following heuristic rules (e.g. chars/4).
 * Handles raw strings, complex messages, tool calls, and arrays of messages.
 */
export function estimateStringTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateContentTokens(content: unknown): number {
  if (content === null || content === undefined) {
    return 0;
  }
  if (typeof content === 'string') {
    return estimateStringTokens(content);
  }
  if (Array.isArray(content)) {
    let total = 0;
    for (const item of content) {
      if (typeof item === 'string') {
        total += estimateStringTokens(item);
      } else if (typeof item === 'object' && item !== null) {
        if ('text' in item && typeof item.text === 'string') {
          total += estimateStringTokens(item.text);
        } else if ('content' in item && typeof item.content === 'string') {
          total += estimateStringTokens(item.content);
        } else {
          total += estimateStringTokens(JSON.stringify(item));
        }
      }
    }
    return total;
  }
  if (typeof content === 'object') {
    return estimateStringTokens(JSON.stringify(content));
  }
  return estimateStringTokens(String(content));
}

export function estimateMessageTokens(message: Message): number {
  // 4 tokens overhead per message (role identifier, framing delimiters)
  const OVERHEAD_TOKENS = 4;
  let tokens = OVERHEAD_TOKENS;
  tokens += estimateContentTokens(message.content);
  if (message.metadata && Object.keys(message.metadata).length > 0) {
    tokens += estimateStringTokens(JSON.stringify(message.metadata));
  }
  return tokens;
}

export function estimateTokens(input: string | Message | Message[]): number {
  if (typeof input === 'string') {
    return estimateStringTokens(input);
  }
  if (Array.isArray(input)) {
    return input.reduce((acc, msg) => acc + estimateMessageTokens(msg), 0);
  }
  return estimateMessageTokens(input);
}

/**
 * Parses XML-style structured summary tags.
 */
export function parseStructuredSummary(text: string): StructuredSummary | null {
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/i.exec(text);
  const body = summaryMatch ? summaryMatch[1] : text;
  if (!body) return null;

  const goalMatch = /<goal>([\s\S]*?)<\/goal>/i.exec(body);
  const decisionsMatch = /<decisions>([\s\S]*?)<\/decisions>/i.exec(body);
  const stateMatch = /<state>([\s\S]*?)<\/state>/i.exec(body);

  if (!goalMatch && !decisionsMatch && !stateMatch) {
    return null;
  }

  return {
    goal: (goalMatch?.[1] ?? '').trim(),
    decisions: (decisionsMatch?.[1] ?? '').trim(),
    state: (stateMatch?.[1] ?? '').trim(),
  };
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          if ('text' in item && typeof item.text === 'string') return item.text;
          if ('content' in item && typeof item.content === 'string') return item.content;
          return JSON.stringify(item);
        }
        return String(item);
      })
      .join('\n');
  }
  if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content);
  }
  return String(content ?? '');
}

function distillEntry(text: string, maxLength = 160): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  if (line.length <= maxLength) return line;
  return `${line.slice(0, maxLength).trim()}...`;
}

/**
 * Built-in structured summarizer template.
 * Distills Goal, Decisions, and State inside <summary>...</summary> tags.
 */
export async function defaultStructuredSummarizer(history: Message[]): Promise<string> {
  const goals: string[] = [];
  const decisions: string[] = [];
  const states: string[] = [];

  for (const msg of history) {
    const rawText = extractText(msg.content);

    // If an earlier summary was already in history, carry forward its structured parts
    const existingParsed = parseStructuredSummary(rawText);
    if (existingParsed) {
      if (existingParsed.goal) goals.push(existingParsed.goal);
      if (existingParsed.decisions) decisions.push(existingParsed.decisions);
      if (existingParsed.state) states.push(existingParsed.state);
      continue;
    }

    if (msg.role === 'user') {
      const distilled = distillEntry(rawText);
      if (distilled.length > 0) {
        goals.push(distilled);
      }
    } else if (msg.role === 'assistant') {
      const distilled = distillEntry(rawText);
      if (distilled.length > 0) {
        decisions.push(distilled);
      }
    } else if (msg.role === 'tool') {
      const distilled = distillEntry(rawText, 120);
      if (distilled.length > 0) {
        states.push(`Tool result: ${distilled}`);
      }
    }
  }

  const goalSummary =
    goals.length > 0
      ? goals.map(g => (g.startsWith('- ') ? g : `- ${g}`)).join('\n')
      : '- Maintain ongoing conversation and user goals.';
  const decisionsSummary =
    decisions.length > 0
      ? decisions.map(d => (d.startsWith('- ') ? d : `- ${d}`)).join('\n')
      : '- Processed past conversational turns and actions.';
  const stateSummary =
    states.length > 0
      ? states.map(s => (s.startsWith('- ') ? s : `- ${s}`)).join('\n')
      : '- Active conversation compacted. Context retained in summary.';

  return [
    '<summary>',
    '<goal>',
    goalSummary,
    '</goal>',
    '<decisions>',
    decisionsSummary,
    '</decisions>',
    '<state>',
    stateSummary,
    '</state>',
    '</summary>',
  ].join('\n');
}

/**
 * Resolves defaults for compaction configuration.
 */
export function resolveConfig(config: CompactionConfig): ResolvedCompactionConfig {
  return {
    maxTokens: config.maxTokens,
    compactionThresholdRatio: config.compactionThresholdRatio ?? 0.75,
    preserveRecentTurns: config.preserveRecentTurns ?? 3,
    turnStrategy: config.turnStrategy ?? 'exchange',
    summarizer: config.summarizer,
    tokenEstimator: config.tokenEstimator ?? estimateTokens,
  };
}

/**
 * True when the entry carries tool output rather than a new human turn. A provider rejects a
 * tool result whose call is missing, so such an entry has to stay with the turn that holds the
 * call. Splitting there produces a history the model adapter refuses to send.
 */
function carriesToolResult(message: Message): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some(item => typeof item === 'object' && item !== null && 'type' in item && item.type === 'tool_result');
}

/**
 * Groups non-system messages into conversational turns.
 * In 'exchange' mode, each user message starts a new conversational turn, except a message that
 * carries tool results, which continues the turn of the call it answers.
 */
export function groupMessagesIntoTurns(messages: Message[], strategy: TurnStrategy = 'exchange'): Message[][] {
  if (messages.length === 0) return [];

  if (strategy === 'message') {
    return messages.map(msg => [msg]);
  }

  const turns: Message[][] = [];
  let currentTurn: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'user' && !carriesToolResult(msg) && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [];
    }
    currentTurn.push(msg);
  }

  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  return turns;
}

/**
 * CompactionManager handles token budgeting, turn extraction,
 * structured summarization, and context window compression.
 */
export class CompactionManager {
  private config: ResolvedCompactionConfig;

  constructor(config: CompactionConfig) {
    this.config = resolveConfig(config);
  }

  getConfig(): ResolvedCompactionConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<CompactionConfig>): void {
    this.config = resolveConfig({
      ...this.config,
      ...partial,
      tokenEstimator: partial.tokenEstimator ?? this.config.tokenEstimator,
      summarizer: partial.summarizer ?? this.config.summarizer,
    });
  }

  estimateTokens(input: string | Message | Message[]): number {
    return this.config.tokenEstimator(input);
  }

  shouldCompact(messages: Message[]): boolean {
    const totalTokens = this.estimateTokens(messages);
    const threshold = this.config.maxTokens * this.config.compactionThresholdRatio;
    return totalTokens > threshold;
  }

  async compact(
    messages: Message[],
    options?: { force?: boolean }
  ): Promise<CompactionResult> {
    const originalTokens = this.estimateTokens(messages);
    const threshold = this.config.maxTokens * this.config.compactionThresholdRatio;

    if (!options?.force && originalTokens <= threshold) {
      return {
        compacted: false,
        messages: [...messages],
        originalTokens,
        compactedTokens: originalTokens,
        preservedSystemCount: messages.filter(m => m.role === 'system').length,
        preservedRecentCount: messages.filter(m => m.role !== 'system').length,
        summarizedCount: 0,
      };
    }

    // 1. Identify system/instruction messages that MUST be preserved at the head
    let headIndex = 0;
    while (headIndex < messages.length && messages[headIndex]!.role === 'system') {
      headIndex++;
    }
    const preservedSystemMessages = messages.slice(0, headIndex);
    const nonSystemMessages = messages.slice(headIndex);

    // 2. Identify the most recent N turns that MUST be preserved at the tail
    const turns = groupMessagesIntoTurns(nonSystemMessages, this.config.turnStrategy);
    const preserveTurnsCount = Math.max(0, this.config.preserveRecentTurns);

    if (turns.length <= preserveTurnsCount) {
      // Nothing to compact into intermediate summary
      return {
        compacted: false,
        messages: [...messages],
        originalTokens,
        compactedTokens: originalTokens,
        preservedSystemCount: preservedSystemMessages.length,
        preservedRecentCount: nonSystemMessages.length,
        summarizedCount: 0,
      };
    }

    const intermediateTurns = turns.slice(0, turns.length - preserveTurnsCount);
    const recentTurns = turns.slice(turns.length - preserveTurnsCount);

    const intermediateMessages = intermediateTurns.flat();
    const preservedRecentMessages = recentTurns.flat();

    if (intermediateMessages.length === 0) {
      return {
        compacted: false,
        messages: [...messages],
        originalTokens,
        compactedTokens: originalTokens,
        preservedSystemCount: preservedSystemMessages.length,
        preservedRecentCount: preservedRecentMessages.length,
        summarizedCount: 0,
      };
    }

    // 3. Summarize intermediate messages
    const summarizerFn = this.config.summarizer ?? defaultStructuredSummarizer;
    let rawSummary = await summarizerFn(intermediateMessages);

    // Ensure summary is enclosed in <summary>...</summary> tags
    if (!rawSummary.includes('<summary>')) {
      rawSummary = `<summary>\n${rawSummary.trim()}\n</summary>`;
    }

    const summaryMessage: Message = {
      role: 'user',
      content: rawSummary,
      metadata: {
        isCompactedSummary: true,
        compactedTurnCount: intermediateTurns.length,
        compactedMessageCount: intermediateMessages.length,
      },
    };

    // 4. Produce compacted message list: [preserved system, summary user message, preserved recent]
    const compactedList: Message[] = [
      ...preservedSystemMessages,
      summaryMessage,
      ...preservedRecentMessages,
    ];

    const compactedTokens = this.estimateTokens(compactedList);

    return {
      compacted: true,
      messages: compactedList,
      originalTokens,
      compactedTokens,
      preservedSystemCount: preservedSystemMessages.length,
      preservedRecentCount: preservedRecentMessages.length,
      summarizedCount: intermediateMessages.length,
      summary: rawSummary,
    };
  }

  createMiddleware(): CompactionMiddleware {
    return createCompactionMiddleware(this);
  }
}

/**
 * Middleware helper function for integrating compaction into agent execution loops.
 */
export function createCompactionMiddleware(
  configOrManager: CompactionConfig | CompactionManager
): CompactionMiddleware {
  const manager =
    configOrManager instanceof CompactionManager
      ? configOrManager
      : new CompactionManager(configOrManager);

  return async (
    messages: Message[],
    next?: (compactedMessages: Message[]) => Promise<any>
  ): Promise<any> => {
    const result = await manager.compact(messages);
    if (next) {
      return next(result.messages);
    }
    return result.messages;
  };
}

export const compactionMiddleware = createCompactionMiddleware;
