import type { AiSearchResponse } from '../core/search/ai-search';
import { aiSearchIndex } from '../core/search/ai-search';
import type { AppConfig } from '../types/config';
import { redactText } from '../utils/redaction';
import { closeDatabase, loadOperationRuntime, printOutput } from './shared';

function formatGetCommand(
  documentId: number,
  scope: 'global' | 'project'
): string {
  return scope === 'project'
    ? `nya get --document-id ${documentId} --project`
    : `nya get --document-id ${documentId}`;
}

export function renderAiSearchText(result: AiSearchResponse): string {
  const lines = [
    `query: ${result.query}`,
    `scope: ${result.scope}`,
    `database: ${result.databasePath}`,
    `iterations: ${result.iterations}`,
    `grounding_status: ${result.groundingStatus}`,
    '',
    'answer:',
    result.answer,
    '',
    `used_queries: ${result.usedQueries.length}`,
  ];

  if (result.structuredOutputFallbackUsed) {
    lines.push('structured_output_fallback_used: true');
  }

  for (const query of result.usedQueries) {
    lines.push(`- ${query}`);
  }

  lines.push('');
  lines.push(`citations: ${result.citations.length}`);
  for (const citation of result.citations) {
    lines.push(
      `[${citation.evidenceId}] doc=${citation.documentId} ${citation.path} :: ${citation.section}`
    );
    lines.push(`get: ${formatGetCommand(citation.documentId, result.scope)}`);
  }

  return lines.join('\n');
}

export function resolveAiSearchExecutionOptions(
  aiSearchConfig: AppConfig['ai_search'],
  args: {
    limit: number | undefined;
    maxSteps: number | undefined;
    maxQueries: number | undefined;
    maxEvidence: number | undefined;
  }
): {
  limit: number;
  maxSteps: number;
  maxQueriesPerStep: number;
  maxEvidenceChunks: number;
} {
  return {
    limit: args.limit ?? aiSearchConfig.retrieval_limit,
    maxSteps: args.maxSteps ?? aiSearchConfig.max_steps,
    maxQueriesPerStep: args.maxQueries ?? aiSearchConfig.max_queries_per_step,
    maxEvidenceChunks: args.maxEvidence ?? aiSearchConfig.max_evidence_chunks,
  };
}

export async function runAiSearch(args: {
  query: string;
  configPath: string | undefined;
  project: boolean;
  asJson: boolean;
  limit: number | undefined;
  maxSteps: number | undefined;
  maxQueries: number | undefined;
  maxEvidence: number | undefined;
  runtimeLoader?: typeof loadOperationRuntime;
  searchExecutor?: typeof aiSearchIndex;
}): Promise<void> {
  const runtimeLoader = args.runtimeLoader ?? loadOperationRuntime;
  const searchExecutor = args.searchExecutor ?? aiSearchIndex;
  const runtime = await runtimeLoader({
    configPath: args.configPath,
    scope: args.project ? 'project' : 'global',
  });

  try {
    if (runtime.lifecycle.rebuildTriggered && !args.asJson) {
      console.log(
        redactText(
          `检测到 embedding 配置变化，正在重建索引: ${runtime.lifecycle.reason ?? 'unknown'}`
        )
      );
    }

    const aiSearchLimits = resolveAiSearchExecutionOptions(
      runtime.config.ai_search,
      {
        limit: args.limit,
        maxSteps: args.maxSteps,
        maxQueries: args.maxQueries,
        maxEvidence: args.maxEvidence,
      }
    );

    const result = await searchExecutor({
      db: runtime.db,
      embeddingProvider: runtime.embeddingProvider,
      llmProvider: runtime.llmProvider,
      query: args.query,
      limit: aiSearchLimits.limit,
      scope: runtime.scope,
      databasePath: runtime.scopePaths.databasePath,
      maxSteps: aiSearchLimits.maxSteps,
      maxQueriesPerStep: aiSearchLimits.maxQueriesPerStep,
      maxEvidenceChunks: aiSearchLimits.maxEvidenceChunks,
    });

    if (args.asJson) {
      printOutput(result, true);
      return;
    }

    printOutput(renderAiSearchText(result), false);
  } finally {
    closeDatabase(runtime.db);
  }
}
