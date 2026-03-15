import { learnGitSource } from '../core/ingest/learn-git';
import { learnWebSource } from '../core/ingest/learn-web';
import type { WebFetchMode } from '../types/config';
import { closeDatabase, loadOperationRuntime, printOutput } from './shared';

export async function runLearnGit(args: {
  source: string;
  configPath: string | undefined;
  project: boolean;
  asJson: boolean;
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

    const result = await learnGitSource({
      source: args.source,
      config: runtime.config,
      db: runtime.db,
      scope: runtime.scope,
      scopePaths: runtime.scopePaths,
      embeddingProvider: runtime.embeddingProvider,
      rebuildTriggered: runtime.lifecycle.rebuildTriggered,
      rebuildReason: runtime.lifecycle.reason,
    });

    if (args.asJson) {
      printOutput(result, true);
      return;
    }

    printOutput(
      [
        `source: ${result.source}`,
        `source_kind: ${result.sourceKind}`,
        `scope: ${result.scope}`,
        `database: ${result.databasePath}`,
        `documents_indexed: ${result.documentsIndexed}`,
        `chunks_indexed: ${result.chunksIndexed}`,
        `rebuild_triggered: ${result.rebuildTriggered}`,
      ].join('\n'),
      false
    );
  } finally {
    closeDatabase(runtime.db);
  }
}

export async function runLearnWeb(args: {
  source: string;
  configPath: string | undefined;
  project: boolean;
  asJson: boolean;
  crawl: boolean;
  maxPages: number | undefined;
  maxDepth: number | undefined;
  fetchMode: WebFetchMode | undefined;
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

    const providerConfig = runtime.config.web.ingest.providers.scrapling;
    const result = await learnWebSource({
      source: args.source,
      config: runtime.config,
      db: runtime.db,
      scope: runtime.scope,
      scopePaths: runtime.scopePaths,
      embeddingProvider: runtime.embeddingProvider,
      webIngestProvider: runtime.webIngestProvider,
      rebuildTriggered: runtime.lifecycle.rebuildTriggered,
      rebuildReason: runtime.lifecycle.reason,
      crawl: args.crawl || providerConfig.default_crawl,
      maxPages: args.maxPages ?? providerConfig.default_max_pages,
      maxDepth: args.maxDepth ?? providerConfig.default_max_depth,
      fetchMode: args.fetchMode ?? providerConfig.default_fetch_mode,
    });

    if (args.asJson) {
      printOutput(result, true);
      return;
    }

    printOutput(
      [
        `source: ${result.source}`,
        `source_kind: ${result.sourceKind}`,
        `scope: ${result.scope}`,
        `database: ${result.databasePath}`,
        `documents_indexed: ${result.documentsIndexed}`,
        `chunks_indexed: ${result.chunksIndexed}`,
        `crawled_pages: ${result.crawledPages}`,
        `rebuild_triggered: ${result.rebuildTriggered}`,
      ].join('\n'),
      false
    );
  } finally {
    closeDatabase(runtime.db);
  }
}
