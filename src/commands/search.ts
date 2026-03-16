import { searchIndex } from '../core/search/search-index';
import { closeDatabase, loadOperationRuntime, printOutput } from './shared';

export async function runSearch(args: {
  query: string;
  configPath: string | undefined;
  project: boolean;
  asJson: boolean;
  extensions?: string[];
  limit: number;
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

    const result = await searchIndex({
      db: runtime.db,
      embeddingProvider: runtime.embeddingProvider,
      query: args.query,
      ...(args.extensions ? { extensions: args.extensions } : {}),
      limit: args.limit,
      scope: runtime.scope,
      databasePath: runtime.scopePaths.databasePath,
    });

    if (args.asJson) {
      printOutput(result, true);
      return;
    }

    if (result.results.length === 0) {
      printOutput(
        [
          `query: ${result.query}`,
          `scope: ${result.scope}`,
          `database: ${result.databasePath}`,
          ...(result.extensions.length > 0
            ? [`extensions: ${result.extensions.join(', ')}`]
            : []),
          'results: 0',
        ].join('\n'),
        false
      );
      return;
    }

    const lines = [
      `query: ${result.query}`,
      `scope: ${result.scope}`,
      `database: ${result.databasePath}`,
      ...(result.extensions.length > 0
        ? [`extensions: ${result.extensions.join(', ')}`]
        : []),
      `results: ${result.results.length}`,
      '',
    ];
    for (const [index, item] of result.results.entries()) {
      lines.push(`[${index + 1}] ${item.path}`);
      lines.push(`document_id: ${item.documentId}`);
      lines.push(`source_key: ${item.sourceKey}`);
      lines.push(`section: ${item.section}`);
      lines.push(`score: ${item.score.toFixed(6)}`);
      lines.push(`snippet: ${item.snippet}`);
      lines.push('');
    }
    printOutput(lines.join('\n'), false);
  } finally {
    closeDatabase(runtime.db);
  }
}
