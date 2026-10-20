export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string | readonly unknown[];
  metadata?: Record<string, any>;
}

export type TurnStrategy = 'exchange' | 'message';

export interface CompactionConfig {
  maxTokens: number;
  compactionThresholdRatio?: number; // default 0.75
  preserveRecentTurns?: number; // default 3
  turnStrategy?: TurnStrategy; // default 'exchange'
  summarizer?: (history: Message[]) => Promise<string>;
  tokenEstimator?: (input: string | Message | Message[]) => number;
}

export interface ResolvedCompactionConfig {
  maxTokens: number;
  compactionThresholdRatio: number;
  preserveRecentTurns: number;
  turnStrategy: TurnStrategy;
  summarizer?: (history: Message[]) => Promise<string>;
  tokenEstimator: (input: string | Message | Message[]) => number;
}

export interface CompactionResult {
  compacted: boolean;
  messages: Message[];
  originalTokens: number;
  compactedTokens: number;
  preservedSystemCount: number;
  preservedRecentCount: number;
  summarizedCount: number;
  summary?: string;
}

export interface StructuredSummary {
  goal: string;
  decisions: string;
  state: string;
}

export type CompactionMiddleware = (
  messages: Message[],
  next?: (compactedMessages: Message[]) => Promise<any>
) => Promise<any>;
