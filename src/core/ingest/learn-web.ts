import type { Database } from 'bun:sqlite';
import { extname } from 'node:path';

import type { ScopePaths } from '../../config/paths';
import {
  replaceSourceData,
  type SourceKind,
  upsertSourceManifest,
} from '../../db/database';
import type {
  EmbeddingFingerprint,
  EmbeddingProvider,
  WebIngestProvider,
} from '../../providers/types';
import type { ProgressReporter } from '../../tui/types';
import type { AppConfig, ScopeMode, WebFetchMode } from '../../types/config';
import { sha256 } from '../../utils/hash';
import { chunkTextDocument } from '../chunking/chunk-text';

export type LearnWebResult = {
  source: string;
  sourceKind: SourceKind;
  scope: ScopeMode;
  databasePath: string;
  documentsIndexed: number;
  chunksIndexed: number;
  rebuildTriggered: boolean;
  rebuildReason: string | null;
  fingerprint: EmbeddingFingerprint;
  crawledPages: number;
};

function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.toString();
}

function sameOrigin(left: string, right: string): boolean {
  return new URL(left).origin === new URL(right).origin;
}

function toChunkPath(url: string): string {
  const parsed = new URL(url);
  const pathname = parsed.pathname;
  if (!pathname || pathname === '/') {
    return 'index.md';
  }

  return extname(pathname) ? pathname.slice(1) : `${pathname.slice(1)}.md`;
}

async function collectPages(args: {
  rootUrl: string;
  crawl: boolean;
  maxPages: number;
  maxDepth: number;
  fetchMode: WebFetchMode;
  config: AppConfig;
  provider: WebIngestProvider;
  progress?: ProgressReporter;
}): Promise<
  Array<{
    sourceKey: string;
    sourceLocator: string;
    canonicalLocator: string | null;
    path: string;
    language: string;
    title: string;
    content: string;
    contentHash: string;
  }>
> {
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [
    {
      url: normalizeUrl(args.rootUrl),
      depth: 0,
    },
  ];
  const pages: Array<{
    sourceKey: string;
    sourceLocator: string;
    canonicalLocator: string | null;
    path: string;
    language: string;
    title: string;
    content: string;
    contentHash: string;
  }> = [];

  if (args.crawl && args.provider.crawl) {
    const crawlTask = args.progress?.task('Crawl pages', args.maxPages);
    const crawled = await args.provider.crawl(normalizeUrl(args.rootUrl), {
      maxPages: args.maxPages,
      maxDepth: args.maxDepth,
      fetchMode: args.fetchMode,
    });

    for (const page of crawled) {
      pages.push({
        sourceKey: normalizeUrl(args.rootUrl),
        sourceLocator: page.finalUrl,
        canonicalLocator: page.canonicalUrl,
        path: page.finalUrl,
        language: 'markdown',
        title: page.title,
        content: page.markdown,
        contentHash: sha256(page.markdown),
      });
      crawlTask?.increment(1);
    }

    crawlTask?.stop();
    return pages;
  }

  const crawlTask = args.progress?.task('Crawl pages', args.maxPages);
  while (queue.length > 0 && pages.length < args.maxPages) {
    const next = queue.shift();
    if (!next) {
      break;
    }

    const normalized = normalizeUrl(next.url);
    if (visited.has(normalized)) {
      continue;
    }
    visited.add(normalized);

    const page = await args.provider.fetchPage(normalized, {
      fetchMode: args.fetchMode,
    });

    pages.push({
      sourceKey: normalizeUrl(args.rootUrl),
      sourceLocator: page.finalUrl,
      canonicalLocator: page.canonicalUrl,
      path: page.finalUrl,
      language: 'markdown',
      title: page.title,
      content: page.markdown,
      contentHash: sha256(page.markdown),
    });
    crawlTask?.increment(1);

    if (!args.crawl || next.depth >= args.maxDepth) {
      continue;
    }

    for (const link of page.links) {
      const normalizedLink = normalizeUrl(link);
      if (
        args.config.web.ingest.providers.scrapling.same_origin_only &&
        !sameOrigin(args.rootUrl, normalizedLink)
      ) {
        continue;
      }
      if (visited.has(normalizedLink)) {
        continue;
      }

      queue.push({
        url: normalizedLink,
        depth: next.depth + 1,
      });
    }
  }

  crawlTask?.stop();
  return pages;
}

export async function learnWebSource(args: {
  source: string;
  config: AppConfig;
  db: Database;
  scope: ScopeMode;
  scopePaths: ScopePaths;
  embeddingProvider: EmbeddingProvider;
  webIngestProvider: WebIngestProvider;
  rebuildTriggered: boolean;
  rebuildReason: string | null;
  crawl: boolean;
  maxPages: number;
  maxDepth: number;
  fetchMode: WebFetchMode;
  recordManifest?: boolean;
  progress?: ProgressReporter;
}): Promise<LearnWebResult> {
  await args.webIngestProvider.assertAvailable();

  const pages = await collectPages({
    rootUrl: args.source,
    crawl: args.crawl,
    maxPages: args.maxPages,
    maxDepth: args.maxDepth,
    fetchMode: args.fetchMode,
    config: args.config,
    provider: args.webIngestProvider,
    ...(args.progress ? { progress: args.progress } : {}),
  });

  const embedTask = args.progress?.task('Embed pages', pages.length);
  const preparedDocuments = [];
  for (const page of pages) {
    const chunks = chunkTextDocument({
      filePath: toChunkPath(page.sourceLocator),
      content: page.content,
      config: args.config,
    });
    if (chunks.length === 0) {
      embedTask?.increment(1);
      continue;
    }

    const embeddings = await args.embeddingProvider.embedDocuments(
      chunks.map((chunk) => chunk.content)
    );

    preparedDocuments.push({
      document: {
        sourceKey: page.sourceKey,
        sourceKind: 'web' as const,
        sourceLocator: page.sourceLocator,
        canonicalLocator: page.canonicalLocator,
        path: page.path,
        language: page.language,
        title: page.title,
        contentHash: page.contentHash,
      },
      chunks: chunks.map((chunk, index) => ({
        chunkIndex: index,
        section: chunk.section,
        content: chunk.content,
        tokenEstimate: chunk.tokenEstimate,
        contentHash: chunk.contentHash,
      })),
      embedding: embeddings,
    });

    embedTask?.increment(1);
  }
  embedTask?.stop();

  const sourceKey = normalizeUrl(args.source);
  const counts = replaceSourceData({
    db: args.db,
    sourceKey,
    documents: preparedDocuments,
  });

  if (args.recordManifest !== false) {
    upsertSourceManifest(args.db, {
      sourceKey,
      sourceKind: 'web',
      provider: args.webIngestProvider.id,
      rootLocator: normalizeUrl(args.source),
      displayLocator: args.source,
      reingestPayloadJson: JSON.stringify({
        kind: 'web',
        source: normalizeUrl(args.source),
        crawl: args.crawl,
        maxPages: args.maxPages,
        maxDepth: args.maxDepth,
        fetchMode: args.fetchMode,
      }),
    });
  }

  return {
    source: args.source,
    sourceKind: 'web',
    scope: args.scope,
    databasePath: args.scopePaths.databasePath,
    documentsIndexed: counts.documentCount,
    chunksIndexed: counts.chunkCount,
    rebuildTriggered: args.rebuildTriggered,
    rebuildReason: args.rebuildReason,
    fingerprint: args.embeddingProvider.fingerprint(
      args.config.index.chunking_version
    ),
    crawledPages: pages.length,
  };
}
