import { aiSearchIndex } from '../core/search/ai-search';
import { closeDatabase, loadOperationRuntime, printOutput } from './shared';

export async function runAiSearch(args: {
  query: string;
  configPath: string | undefined;
  project: boolean;
  asJson: boolean;
  limit: number;
  maxSteps: number | undefined;
  maxQueries: number | undefined;
  maxEvidence: number | undefined;
}): Promise<void> {
  const runtime = await loadOperationRuntime({
    configPath: args.configPath,
    scope: args.project ? 'project' : 'global',
  });

  try {
    if (runtime.lifecycle.rebuildTriggered && !args.asJson) {
      console.log(
        `检测到 embedding 配置变化，正在重建索引: ${runtime.lifecycle.reason ?? 'unknown'}`
      );
    }

    const result = await aiSearchIndex({
      db: runtime.db,
      embeddingProvider: runtime.embeddingProvider,
      llmProvider: runtime.llmProvider,
      query: args.query,
      limit: args.limit,
      scope: runtime.scope,
      databasePath: runtime.scopePaths.databasePath,
      maxSteps: args.maxSteps ?? runtime.config.ai_search.max_steps,
      maxQueriesPerStep:
        args.maxQueries ?? runtime.config.ai_search.max_queries_per_step,
      maxEvidenceChunks:
        args.maxEvidence ?? runtime.config.ai_search.max_evidence_chunks,
    });

    if (args.asJson) {
      printOutput(result, true);
      return;
    }

    const lines = [
      `query: ${result.query}`,
      `scope: ${result.scope}`,
      `database: ${result.databasePath}`,
      `iterations: ${result.iterations}`,
      '',
      'answer:',
      result.answer,
      '',
      `used_queries: ${result.usedQueries.length}`,
    ];

    for (const query of result.usedQueries) {
      lines.push(`- ${query}`);
    }

    lines.push('');
    lines.push(`citations: ${result.citations.length}`);
    for (const citation of result.citations) {
      lines.push(
        `[${citation.evidenceId}] doc=${citation.documentId} ${citation.path} :: ${citation.section}`
      );
    }

    printOutput(lines.join('\n'), false);
  } finally {
    closeDatabase(runtime.db);
  }
}
