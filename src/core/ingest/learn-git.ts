import type { Database } from 'bun:sqlite';
import type { ScopePaths } from '../../config/paths';
import { replaceSourceData, upsertSourceManifest } from '../../db/database';
import type {
  EmbeddingFingerprint,
  EmbeddingProvider,
} from '../../providers/types';
import type { ProgressReporter } from '../../tui/types';
import type { AppConfig, ScopeMode } from '../../types/config';
import { sha256 } from '../../utils/hash';
import { chunkTextDocument } from '../chunking/chunk-text';
import {
  getGitSourceProviderId,
  readRepositoryFiles,
  resolveGitSource,
} from './git-source';

export type LearnGitResult = {
  source: string;
  sourceKind: 'local_git' | 'remote_git';
  scope: ScopeMode;
  databasePath: string;
  documentsIndexed: number;
  chunksIndexed: number;
  rebuildTriggered: boolean;
  rebuildReason: string | null;
  fingerprint: EmbeddingFingerprint;
};

export async function learnGitSource(args: {
  source: string;
  config: AppConfig;
  db: Database;
  scope: ScopeMode;
  scopePaths: ScopePaths;
  embeddingProvider: EmbeddingProvider;
  rebuildTriggered: boolean;
  rebuildReason: string | null;
  recordManifest?: boolean;
  progress?: ProgressReporter;
}): Promise<LearnGitResult> {
  const resolvedSource = await resolveGitSource({
    source: args.source,
    paths: args.scopePaths,
  });
  const repoFiles = await readRepositoryFiles({
    source: resolvedSource,
    config: args.config,
  });

  const fileTask = args.progress?.task('Index git files', repoFiles.length);
  const preparedDocuments = [];
  for (const repoFile of repoFiles) {
    const chunks = await chunkTextDocument({
      filePath: repoFile.relativePath,
      content: repoFile.content,
      config: args.config,
    });
    if (chunks.length === 0) {
      fileTask?.increment(1);
      continue;
    }

    const embeddings = await args.embeddingProvider.embedDocuments(
      chunks.map((chunk) => chunk.content)
    );

    preparedDocuments.push({
      document: {
        sourceKey: resolvedSource.sourceKey,
        sourceKind: resolvedSource.sourceKind,
        sourceLocator:
          resolvedSource.sourceKind === 'remote_git'
            ? resolvedSource.repoUrl
            : repoFile.absolutePath,
        canonicalLocator: null,
        path: repoFile.relativePath,
        language: repoFile.language,
        title: repoFile.title,
        contentHash: sha256(repoFile.content),
        content: repoFile.content,
      },
      chunks: chunks.map((chunk, index) => ({
        documentId: 0,
        chunkIndex: index,
        section: chunk.section,
        content: chunk.content,
        tokenEstimate: chunk.tokenEstimate,
        contentHash: chunk.contentHash,
      })),
      embedding: embeddings,
    });

    fileTask?.increment(1);
  }
  fileTask?.stop();

  const counts = replaceSourceData({
    db: args.db,
    sourceKey: resolvedSource.sourceKey,
    documents: preparedDocuments,
  });

  if (args.recordManifest !== false) {
    upsertSourceManifest(args.db, {
      sourceKey: resolvedSource.sourceKey,
      sourceKind: resolvedSource.sourceKind,
      provider: getGitSourceProviderId(resolvedSource),
      rootLocator:
        resolvedSource.sourceKind === 'remote_git'
          ? resolvedSource.repoUrl
          : resolvedSource.repoRoot,
      displayLocator: args.source,
      reingestPayloadJson: JSON.stringify({
        kind: 'git',
        source: args.source,
      }),
    });
  }

  return {
    source: args.source,
    sourceKind: resolvedSource.sourceKind,
    scope: args.scope,
    databasePath: args.scopePaths.databasePath,
    documentsIndexed: counts.documentCount,
    chunksIndexed: counts.chunkCount,
    rebuildTriggered: args.rebuildTriggered,
    rebuildReason: args.rebuildReason,
    fingerprint: args.embeddingProvider.fingerprint(
      args.config.index.chunking_version
    ),
  };
}
