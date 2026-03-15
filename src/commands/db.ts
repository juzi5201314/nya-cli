import { rebuildSourcesFromManifest } from '../core/ingest/rebuild-sources';
import {
  clearDatabase,
  closeDatabase,
  getDbStats,
  getDoctorReport,
  listSourceManifests,
  loadDbRuntime,
  loadOperationRuntime,
  printOutput,
  renderDoctor,
  renderScope,
  renderStats,
} from './shared';

export async function runDbStats(args: {
  configPath: string | undefined;
  scope: 'global' | 'project';
  asJson: boolean;
}): Promise<void> {
  const runtime = await loadDbRuntime({
    configPath: args.configPath,
    scope: args.scope,
  });

  try {
    const stats = getDbStats(runtime.db);
    if (args.asJson) {
      printOutput(
        {
          scope: runtime.scope,
          databasePath: runtime.scopePaths.databasePath,
          ...stats,
        },
        true
      );
      return;
    }
    printOutput(
      renderStats(stats, runtime.scope, runtime.scopePaths.databasePath),
      false
    );
  } finally {
    closeDatabase(runtime.db);
  }
}

export async function runDbDoctor(args: {
  configPath: string | undefined;
  scope: 'global' | 'project';
  asJson: boolean;
}): Promise<void> {
  const runtime = await loadDbRuntime({
    configPath: args.configPath,
    scope: args.scope,
  });

  try {
    const report = getDoctorReport(runtime.scopePaths.databasePath, runtime.db);
    if (args.asJson) {
      printOutput(
        {
          scope: runtime.scope,
          ...report,
        },
        true
      );
      return;
    }
    printOutput(renderDoctor(report, runtime.scope), false);
  } finally {
    closeDatabase(runtime.db);
  }
}

export async function runDbScope(args: {
  configPath: string | undefined;
  scope: 'global' | 'project';
  asJson: boolean;
}): Promise<void> {
  const runtime = await loadDbRuntime({
    configPath: args.configPath,
    scope: args.scope,
  });

  try {
    const stats = getDbStats(runtime.db);
    const manifests = listSourceManifests(runtime.db);
    if (args.asJson) {
      printOutput(
        {
          scope: runtime.scope,
          databasePath: runtime.scopePaths.databasePath,
          remoteCacheDir: runtime.scopePaths.remoteCacheDir,
          stats,
          manifests,
        },
        true
      );
      return;
    }

    printOutput(
      renderScope({
        scope: runtime.scope,
        databasePath: runtime.scopePaths.databasePath,
        remoteCacheDir: runtime.scopePaths.remoteCacheDir,
        stats,
        manifests,
      }),
      false
    );
  } finally {
    closeDatabase(runtime.db);
  }
}

export async function runDbClear(args: {
  configPath: string | undefined;
  scope: 'global' | 'project';
  asJson: boolean;
  yes: boolean;
}): Promise<void> {
  if (!args.yes) {
    throw new Error('db clear 是危险操作，必须显式传入 --yes');
  }

  const runtime = await loadDbRuntime({
    configPath: args.configPath,
    scope: args.scope,
  });

  try {
    clearDatabase(runtime.db);
    const result = {
      scope: runtime.scope,
      databasePath: runtime.scopePaths.databasePath,
      cleared: true,
    };

    printOutput(
      args.asJson
        ? result
        : `scope: ${result.scope}\ndatabase: ${result.databasePath}\ncleared: true`,
      args.asJson
    );
  } finally {
    closeDatabase(runtime.db);
  }
}

export async function runDbRebuild(args: {
  configPath: string | undefined;
  scope: 'global' | 'project';
  asJson: boolean;
  sourceKey: string | undefined;
  retryCount: number;
  failFast: boolean;
  failedOnly: boolean;
}): Promise<void> {
  const runtime = await loadOperationRuntime({
    configPath: args.configPath,
    scope: args.scope,
    autoRebuild: false,
  });

  try {
    const summary = await rebuildSourcesFromManifest({
      config: runtime.config,
      db: runtime.db,
      scope: runtime.scope,
      scopePaths: runtime.scopePaths,
      embeddingProvider: runtime.embeddingProvider,
      webIngestProvider: runtime.webIngestProvider,
      sourceKey: args.sourceKey,
      retryCount: args.retryCount,
      failFast: args.failFast,
      failedOnly: args.failedOnly,
    });

    if (args.asJson) {
      printOutput(
        {
          scope: runtime.scope,
          databasePath: runtime.scopePaths.databasePath,
          rebuilt: summary.succeeded.length,
          failed: summary.failed.length,
          succeeded: summary.succeeded,
          failures: summary.failed,
        },
        true
      );
      if (summary.failed.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    const lines = [
      `scope: ${runtime.scope}`,
      `database: ${runtime.scopePaths.databasePath}`,
      `rebuilt: ${summary.succeeded.length}`,
      `failed: ${summary.failed.length}`,
    ];

    for (const item of summary.succeeded) {
      lines.push('');
      lines.push(`[source] ${item.sourceKey}`);
      lines.push(`kind: ${item.sourceKind}`);
      lines.push(`provider: ${item.provider}`);
      lines.push(`documents: ${item.documentsIndexed}`);
      lines.push(`chunks: ${item.chunksIndexed}`);
    }

    for (const item of summary.failed) {
      lines.push('');
      lines.push(`[failed] ${item.sourceKey}`);
      lines.push(`kind: ${item.sourceKind}`);
      lines.push(`provider: ${item.provider}`);
      lines.push(`attempts: ${item.attempts}`);
      lines.push(`error: ${item.error}`);
    }

    printOutput(lines.join('\n'), false);

    if (summary.failed.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    closeDatabase(runtime.db);
  }
}
