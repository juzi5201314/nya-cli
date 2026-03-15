export type ProgressTask = {
  update(value: number): void;
  increment(delta?: number): void;
  stop(): void;
};

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type TokenTotals = {
  embeddingTokens: number;
  llmInputTokens: number;
  llmOutputTokens: number;
  llmTotalTokens: number;
  estimated: boolean;
};

export type ProgressReporter = {
  readonly enabled: boolean;
  task(label: string, total: number): ProgressTask;
  addEmbeddingTokens(tokens: number, estimated: boolean): void;
  addLlmUsage(usage: TokenUsage, estimated: boolean): void;
  getTokenTotals(): TokenTotals;
  stopAll(): void;
};

export const noopProgressReporter: ProgressReporter = {
  enabled: false,
  task() {
    return {
      update() {},
      increment() {},
      stop() {},
    };
  },
  addEmbeddingTokens() {},
  addLlmUsage() {},
  getTokenTotals() {
    return {
      embeddingTokens: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
      llmTotalTokens: 0,
      estimated: false,
    };
  },
  stopAll() {},
};
