import type { Database } from 'bun:sqlite';

import type { ScopePaths } from '../../config/paths';
import {
  getSourceManifest,
  initializeEmptyIndex,
  inspectIndexState,
  listFailedSourceManifests,
  listSourceManifests,
  type SourceManifestRow,
  updateSourceManifestRebuildState,
} from '../../db/database';
import type {
  EmbeddingProvider,
  WebIngestProvider,
} from '../../providers/types';
import type { AppConfig, ScopeMode } from '../../types/config';
import { learnGitSource } from './learn-git';
import { learnWebSource } from './learn-web';

type ReingestPayload =
  | {
      kind: 'git';
      source: string;
    }
  | {
      kind: 'web';
      source: string;
      crawl: boolean;
      maxPages: number;
      maxDepth: number;
      fetchMode: 'auto' | 'get' | 'fetch';
    };

export type RebuildSourceResult = {
  sourceKey: string;
  sourceKind: SourceManifestRow['sourceKind'];
  provider: string;
  rootLocator: string;
  documentsIndexed: number;
  chunksIndexed: number;
};

export type RebuildFailureResult = {
  sourceKey: string;
  sourceKind: SourceManifestRow['sourceKind'];
  provider: string;
  rootLocator: string;
  attempts: number;
  error: string;
};

export type RebuildSummary = {
  succeeded: RebuildSourceResult[];
  failed: RebuildFailureResult[];
};

function parsePayload(manifest: SourceManifestRow): ReingestPayload {
  const parsed = JSON.parse(manifest.reingestPayloadJson) as { kind?: string };
  if (parsed.kind === 'git') {
    return parsed as ReingestPayload;
  }
  if (parsed.kind === 'web') {
    return parsed as ReingestPayload;
  }
  throw new Error(`未知的 source manifest payload: ${manifest.sourceKey}`);
}

async function reingestManifest(args: {
  manifest: SourceManifestRow;
  config: AppConfig;
  db: Database;
  scope: ScopeMode;
  scopePaths: ScopePaths;
  embeddingProvider: EmbeddingProvider;
  webIngestProvider: WebIngestProvider;
}): Promise<RebuildSourceResult> {
  const payload = parsePayload(args.manifest);

  if (payload.kind === 'git') {
    const result = await learnGitSource({
      source: payload.source,
      config: args.config,
      db: args.db,
      scope: args.scope,
      scopePaths: args.scopePaths,
      embeddingProvider: args.embeddingProvider,
      rebuildTriggered: false,
      rebuildReason: null,
      recordManifest: true,
    });

    return {
      sourceKey: args.manifest.sourceKey,
      sourceKind: args.manifest.sourceKind,
      provider: args.manifest.provider,
      rootLocator: args.manifest.rootLocator,
      documentsIndexed: result.documentsIndexed,
      chunksIndexed: result.chunksIndexed,
    };
  }

  const result = await learnWebSource({
    source: payload.source,
    config: args.config,
    db: args.db,
    scope: args.scope,
    scopePaths: args.scopePaths,
    embeddingProvider: args.embeddingProvider,
    webIngestProvider: args.webIngestProvider,
    rebuildTriggered: false,
    rebuildReason: null,
    crawl: payload.crawl,
    maxPages: payload.maxPages,
    maxDepth: payload.maxDepth,
    fetchMode: payload.fetchMode,
    recordManifest: true,
  });

  return {
    sourceKey: args.manifest.sourceKey,
    sourceKind: args.manifest.sourceKind,
    provider: args.manifest.provider,
    rootLocator: args.manifest.rootLocator,
    documentsIndexed: result.documentsIndexed,
    chunksIndexed: result.chunksIndexed,
  };
}

export async function rebuildSourcesFromManifest(args: {
  config: AppConfig;
  db: Database;
  scope: ScopeMode;
  scopePaths: ScopePaths;
  embeddingProvider: EmbeddingProvider;
  webIngestProvider: WebIngestProvider;
  sourceKey: string | undefined;
  retryCount: number;
  failFast: boolean;
  failedOnly: boolean;
}): Promise<RebuildSummary> {
  const manifests = args.sourceKey
    ? (() => {
        const manifest = getSourceManifest(args.db, args.sourceKey);
        if (!manifest) {
          return [];
        }
        if (args.failedOnly && manifest.lastRebuildStatus !== 'failed') {
          return [];
        }
        return [manifest];
      })()
    : args.failedOnly
      ? listFailedSourceManifests(args.db)
      : listSourceManifests(args.db);

  if (args.sourceKey && manifests.length === 0) {
    throw new Error(
      args.failedOnly
        ? `未找到失败状态的 source manifest: ${args.sourceKey}`
        : `未找到 source manifest: ${args.sourceKey}`
    );
  }

  if (manifests.length === 0) {
    initializeEmptyIndex(
      args.db,
      args.embeddingProvider.fingerprint(args.config.index.chunking_version)
    );
    return {
      succeeded: [],
      failed: [],
    };
  }

  const indexState = inspectIndexState(
    args.db,
    args.embeddingProvider.fingerprint(args.config.index.chunking_version)
  );

  if (
    args.sourceKey &&
    indexState.needsRebuild &&
    listSourceManifests(args.db).length > 1
  ) {
    throw new Error(
      '当前 embedding fingerprint 已变化，不能只重建单个 source。请先对整个 scope 执行 db rebuild。'
    );
  }

  if (args.failedOnly && indexState.needsRebuild) {
    throw new Error(
      '当前 embedding fingerprint 已变化，不能只重试失败 source。请先执行完整 db rebuild。'
    );
  }

  if (!args.failedOnly && (!args.sourceKey || indexState.needsRebuild)) {
    initializeEmptyIndex(
      args.db,
      args.embeddingProvider.fingerprint(args.config.index.chunking_version)
    );
  }

  const succeeded: RebuildSourceResult[] = [];
  const failed: RebuildFailureResult[] = [];
  for (const manifest of manifests) {
    let lastError: unknown;
    let attempts = 0;

    for (let attempt = 0; attempt <= args.retryCount; attempt += 1) {
      attempts = attempt + 1;
      try {
        const result = await reingestManifest({
          manifest,
          config: args.config,
          db: args.db,
          scope: args.scope,
          scopePaths: args.scopePaths,
          embeddingProvider: args.embeddingProvider,
          webIngestProvider: args.webIngestProvider,
        });
        succeeded.push(result);
        updateSourceManifestRebuildState(args.db, manifest.sourceKey, {
          status: 'success',
          error: null,
          attempts,
          rebuildAt: new Date().toISOString(),
          rebuildSuccessAt: new Date().toISOString(),
        });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      failed.push({
        sourceKey: manifest.sourceKey,
        sourceKind: manifest.sourceKind,
        provider: manifest.provider,
        rootLocator: manifest.rootLocator,
        attempts,
        error:
          lastError instanceof Error ? lastError.message : String(lastError),
      });
      updateSourceManifestRebuildState(args.db, manifest.sourceKey, {
        status: 'failed',
        error:
          lastError instanceof Error ? lastError.message : String(lastError),
        attempts,
        rebuildAt: new Date().toISOString(),
        rebuildSuccessAt: manifest.lastRebuildSuccessAt,
      });

      if (args.failFast) {
        break;
      }
    }
  }

  return {
    succeeded,
    failed,
  };
}

export async function autoRebuildIfNeeded(args: {
  config: AppConfig;
  db: Database;
  scope: ScopeMode;
  scopePaths: ScopePaths;
  embeddingProvider: EmbeddingProvider;
  webIngestProvider: WebIngestProvider;
}): Promise<{ rebuildTriggered: boolean; reason: string | null }> {
  const fingerprint = args.embeddingProvider.fingerprint(
    args.config.index.chunking_version
  );
  const indexState = inspectIndexState(args.db, fingerprint);

  if (!indexState.needsRebuild) {
    return {
      rebuildTriggered: false,
      reason: null,
    };
  }

  if (indexState.sourceManifests === 0) {
    initializeEmptyIndex(args.db, fingerprint);
    return {
      rebuildTriggered: true,
      reason: indexState.reason,
    };
  }

  const summary = await rebuildSourcesFromManifest({
    config: args.config,
    db: args.db,
    scope: args.scope,
    scopePaths: args.scopePaths,
    embeddingProvider: args.embeddingProvider,
    webIngestProvider: args.webIngestProvider,
    sourceKey: undefined,
    retryCount: 0,
    failFast: true,
    failedOnly: false,
  });

  if (summary.failed.length > 0) {
    throw new Error(
      `自动重建失败: ${summary.failed
        .map((item) => `${item.sourceKey} (${item.error})`)
        .join('; ')}`
    );
  }

  return {
    rebuildTriggered: true,
    reason: indexState.reason,
  };
}
