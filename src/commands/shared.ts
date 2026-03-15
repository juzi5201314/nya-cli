import { loadConfig } from '../config/load-config';
import { loadProjectEnv } from '../config/load-env';
import { resolveScopePaths } from '../config/paths';
import { autoRebuildIfNeeded } from '../core/ingest/rebuild-sources';
import {
  clearDatabase,
  closeDatabase,
  getDbStats,
  getDoctorReport,
  inspectIndexState,
  listSourceManifests,
  openDatabase,
} from '../db/database';
import { createEmbeddingProvider } from '../providers/embedding';
import { createLlmProvider } from '../providers/llm';
import {
  createWebIngestProvider,
  createWebSearchProvider,
} from '../providers/web';
import type { ScopeMode } from '../types/config';

export function resolveDefaultScope(project: boolean): ScopeMode {
  return project ? 'project' : 'global';
}

export function requireDbScope(
  globalScope: boolean | undefined,
  projectScope: boolean | undefined
): ScopeMode {
  if (globalScope === projectScope) {
    throw new Error(
      'db 子命令必须显式指定且只能指定一个作用域：--global 或 --project'
    );
  }

  return globalScope ? 'global' : 'project';
}

export function printOutput(value: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (typeof value === 'string') {
    console.log(value);
    return;
  }

  console.log(JSON.stringify(value, null, 2));
}

export async function loadOperationRuntime(args: {
  configPath: string | undefined;
  scope: ScopeMode;
  autoRebuild?: boolean;
}) {
  await loadProjectEnv(args.configPath);
  const { config, path: configPath } = await loadConfig(args.configPath);
  await loadProjectEnv(configPath);

  const scopePaths = await resolveScopePaths({
    scope: args.scope,
    projectDirName: config.app.project_dir_name,
  });
  const db = await openDatabase(scopePaths.databasePath);
  const embeddingProvider = createEmbeddingProvider(config);
  const llmProvider = createLlmProvider(config);
  const webSearchProvider = createWebSearchProvider(config);
  const webIngestProvider = createWebIngestProvider(config);

  const lifecycle =
    args.autoRebuild === false
      ? (() => {
          const state = inspectIndexState(
            db,
            embeddingProvider.fingerprint(config.index.chunking_version)
          );
          return {
            rebuildTriggered: state.needsRebuild,
            reason: state.reason,
          };
        })()
      : await autoRebuildIfNeeded({
          config,
          db,
          scope: args.scope,
          scopePaths,
          embeddingProvider,
          webIngestProvider,
        });

  return {
    config,
    configPath,
    scope: args.scope,
    scopePaths,
    db,
    embeddingProvider,
    llmProvider,
    webSearchProvider,
    webIngestProvider,
    lifecycle,
  };
}

export async function loadDbRuntime(args: {
  configPath: string | undefined;
  scope: ScopeMode;
}) {
  await loadProjectEnv(args.configPath);
  let projectDirName = '.nya-cli';
  try {
    const loaded = await loadConfig(args.configPath);
    await loadProjectEnv(loaded.path);
    projectDirName = loaded.config.app.project_dir_name;
  } catch {
    // db 子命令允许在没有配置文件的情况下查看已有数据库。
  }

  const scopePaths = await resolveScopePaths({
    scope: args.scope,
    projectDirName,
  });
  const db = await openDatabase(scopePaths.databasePath);

  return {
    scope: args.scope,
    scopePaths,
    db,
  };
}

export function renderStats(
  stats: ReturnType<typeof getDbStats>,
  scope: ScopeMode,
  databasePath: string
): string {
  const lines = [
    `scope: ${scope}`,
    `database: ${databasePath}`,
    `documents: ${stats.documents}`,
    `chunks: ${stats.chunks}`,
    `sources: ${stats.sourceManifests}`,
    `failed_sources: ${stats.failedSourceManifests}`,
    `fts: ${stats.hasFts}`,
    `vector: ${stats.hasVector}`,
    `fingerprint: ${stats.fingerprint ? JSON.stringify(stats.fingerprint) : 'null'}`,
  ];
  return lines.join('\n');
}

export function renderDoctor(
  report: ReturnType<typeof getDoctorReport>,
  scope: ScopeMode
): string {
  const lines = [
    `scope: ${scope}`,
    `database: ${report.dbPath}`,
    `db_exists: ${report.dbExists}`,
    `sources: ${report.sourceManifests}`,
    `failed_sources: ${report.failedSourceManifests}`,
    `fts: ${report.hasFts}`,
    `vector: ${report.hasVector}`,
    `fingerprint: ${report.fingerprint ? JSON.stringify(report.fingerprint) : 'null'}`,
  ];
  return lines.join('\n');
}

export function renderScope(args: {
  scope: ScopeMode;
  databasePath: string;
  remoteCacheDir: string;
  stats: ReturnType<typeof getDbStats>;
  manifests: ReturnType<typeof listSourceManifests>;
}): string {
  const lines = [
    `scope: ${args.scope}`,
    `database: ${args.databasePath}`,
    `remote_cache: ${args.remoteCacheDir}`,
    `documents: ${args.stats.documents}`,
    `chunks: ${args.stats.chunks}`,
    `sources: ${args.stats.sourceManifests}`,
    `failed_sources: ${args.stats.failedSourceManifests}`,
    `fingerprint: ${args.stats.fingerprint ? JSON.stringify(args.stats.fingerprint) : 'null'}`,
  ];

  for (const manifest of args.manifests) {
    lines.push('');
    lines.push(`[source] ${manifest.sourceKey}`);
    lines.push(`kind: ${manifest.sourceKind}`);
    lines.push(`provider: ${manifest.provider}`);
    lines.push(`root: ${manifest.rootLocator}`);
    lines.push(`rebuild_status: ${manifest.lastRebuildStatus}`);
    lines.push(`rebuild_attempts: ${manifest.lastRebuildAttempts}`);
    if (manifest.lastRebuildError) {
      lines.push(`rebuild_error: ${manifest.lastRebuildError}`);
    }
  }

  return lines.join('\n');
}

export {
  clearDatabase,
  closeDatabase,
  getDbStats,
  getDoctorReport,
  listSourceManifests,
};
