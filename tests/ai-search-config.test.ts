import type { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { runAiSearch } from '../src/commands/ai-search';
import type { loadOperationRuntime } from '../src/commands/shared';
import type { AiSearchResponse } from '../src/core/search/ai-search';
import type { AppConfig } from '../src/types/config';

function captureConsoleOutput(fn: () => Promise<void> | void): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;

  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = originalLog;
    })
    .then(() => lines.join('\n'));
}

function makeRuntime(config: AppConfig['ai_search']) {
  const db = {
    close: () => {},
  } as unknown as Database;

  return {
    config: {
      ai_search: config,
    } as AppConfig,
    scope: 'project' as const,
    scopePaths: {
      databasePath: '/tmp/ai-search-config.sqlite',
    },
    db,
    embeddingProvider: {} as never,
    llmProvider: {} as never,
    lifecycle: {
      rebuildTriggered: false,
      reason: null,
    },
  } as unknown as Awaited<ReturnType<typeof loadOperationRuntime>>;
}

function makeResponse(): AiSearchResponse {
  return {
    query: 'question',
    scope: 'project',
    databasePath: '/tmp/ai-search-config.sqlite',
    answer: 'answer',
    groundingStatus: 'grounded',
    usedQueries: ['query'],
    iterations: 1,
    citations: [],
    evidence: [],
    structuredOutputFallbackUsed: false,
  };
}

describe('ai-search config resolution', () => {
  test('uses ai_search config defaults when flags are absent', async () => {
    const runtime = makeRuntime({
      max_steps: 2,
      max_queries_per_step: 3,
      retrieval_limit: 4,
      max_evidence_chunks: 5,
    });

    let receivedArgs: {
      limit: number;
      maxSteps: number;
      maxQueriesPerStep: number;
      maxEvidenceChunks: number;
    } | null = null;

    const stdout = await captureConsoleOutput(() =>
      runAiSearch({
        query: 'question',
        configPath: '/tmp/ai-search-config/nya.toml',
        project: true,
        asJson: true,
        limit: undefined,
        maxSteps: undefined,
        maxQueries: undefined,
        maxEvidence: undefined,
        runtimeLoader: async () => runtime,
        searchExecutor: async (args) => {
          receivedArgs = {
            limit: args.limit,
            maxSteps: args.maxSteps,
            maxQueriesPerStep: args.maxQueriesPerStep,
            maxEvidenceChunks: args.maxEvidenceChunks,
          };
          return makeResponse();
        },
      })
    );

    const resolvedArgs = receivedArgs;
    expect(resolvedArgs).not.toBeNull();
    const args = resolvedArgs as unknown as {
      limit: number;
      maxSteps: number;
      maxQueriesPerStep: number;
      maxEvidenceChunks: number;
    };
    expect(args).toEqual({
      limit: 4,
      maxSteps: 2,
      maxQueriesPerStep: 3,
      maxEvidenceChunks: 5,
    });
    expect(stdout).toContain('"groundingStatus": "grounded"');
  });

  test('CLI flags override ai_search config deterministically', async () => {
    const runtime = makeRuntime({
      max_steps: 2,
      max_queries_per_step: 3,
      retrieval_limit: 4,
      max_evidence_chunks: 5,
    });

    let receivedArgs: {
      limit: number;
      maxSteps: number;
      maxQueriesPerStep: number;
      maxEvidenceChunks: number;
    } | null = null;

    await captureConsoleOutput(() =>
      runAiSearch({
        query: 'question',
        configPath: '/tmp/ai-search-config/nya.toml',
        project: true,
        asJson: true,
        limit: 9,
        maxSteps: 8,
        maxQueries: 7,
        maxEvidence: 6,
        runtimeLoader: async () => runtime,
        searchExecutor: async (args) => {
          receivedArgs = {
            limit: args.limit,
            maxSteps: args.maxSteps,
            maxQueriesPerStep: args.maxQueriesPerStep,
            maxEvidenceChunks: args.maxEvidenceChunks,
          };
          return makeResponse();
        },
      })
    );

    const resolvedArgs = receivedArgs;
    expect(resolvedArgs).not.toBeNull();
    const args = resolvedArgs as unknown as {
      limit: number;
      maxSteps: number;
      maxQueriesPerStep: number;
      maxEvidenceChunks: number;
    };
    expect(args).toEqual({
      limit: 9,
      maxSteps: 8,
      maxQueriesPerStep: 7,
      maxEvidenceChunks: 6,
    });
  });
});
