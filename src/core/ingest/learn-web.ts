import type { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';

import type { ScopePaths } from '../../config/paths';
import {
  replaceSourceData,
  type SourceKind,
  upsertSourceManifest,
} from '../../db/database';
import type {
  EmbeddingFingerprint,
  EmbeddingProvider,
  WebCrawlResult,
  WebFetchedPage,
  WebIngestProvider,
  WebPageAttempt,
  WebPageFailure,
} from '../../providers/types';
import type { ProgressReporter } from '../../tui/types';
import type { AppConfig, ScopeMode, WebFetchMode } from '../../types/config';
import { sha256 } from '../../utils/hash';
import { normalizeLocatorForStorage } from '../../utils/redaction';
import { chunkTextDocument } from '../chunking/chunk-text';

type CollectedWebPage = {
  sourceKey: string;
  sourceLocator: string;
  canonicalLocator: string | null;
  path: string;
  language: string;
  title: string;
  content: string;
  contentHash: string;
  attempts: number;
};

type CollectPagesResult = {
  pages: CollectedWebPage[];
  pageFailures: WebPageFailure[];
  pageAttempts: WebPageAttempt[];
  crawlTempDir: string | null;
};

export type LearnWebResult = {
  source: string;
  sourceKind: SourceKind;
  scope: ScopeMode;
  databasePath: string;
  documentsIndexed: number;
  chunksIndexed: number;
  failedPages: number;
  pageFailures: WebPageFailure[];
  pageAttempts: WebPageAttempt[];
  crawlTempDir: string | null;
  rebuildTriggered: boolean;
  rebuildReason: string | null;
  fingerprint: EmbeddingFingerprint;
  crawledPages: number;
};

function normalizeWebPageUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.toString();
}

function normalizeWebPageIdentity(url: string): string {
  return normalizeLocatorForStorage(normalizeWebPageUrl(url), {
    stripFragment: true,
  });
}

function normalizeWebSourceIdentity(url: string): string {
  return normalizeLocatorForStorage(url, { stripFragment: true });
}

function sameOrigin(left: string, right: string): boolean {
  return new URL(left).origin === new URL(right).origin;
}

function computeWebCrawlScope(rootUrl: string): {
  origin: string;
  rootPath: string;
  pathPrefix: string;
} {
  const root = new URL(normalizeWebPageUrl(rootUrl));
  const rootPath = root.pathname || '/';
  const pathPrefix = rootPath.endsWith('/')
    ? rootPath
    : extname(rootPath)
      ? `${dirname(rootPath).replace(/\/+$/, '')}/`
      : `${rootPath}/`;
  return {
    origin: root.origin,
    rootPath,
    pathPrefix,
  };
}

function hasNonHtmlExtension(pathname: string): boolean {
  const ext = extname(pathname).toLowerCase();
  if (!ext) {
    return false;
  }

  // 常见非 HTML 资源，默认不纳入 crawl
  return new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.svg',
    '.webp',
    '.ico',
    '.css',
    '.js',
    '.mjs',
    '.cjs',
    '.map',
    '.json',
    '.xml',
    '.pdf',
    '.zip',
    '.gz',
    '.tgz',
    '.tar',
    '.rar',
    '.7z',
    '.woff',
    '.woff2',
    '.ttf',
    '.otf',
    '.eot',
    '.mp4',
    '.webm',
    '.mp3',
    '.wav',
  ]).has(ext);
}

function isNoisePath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  if (lower === '/robots.txt' || lower === '/sitemap.xml') {
    return true;
  }
  return (
    lower.startsWith('/assets/') ||
    lower.startsWith('/static/') ||
    lower.startsWith('/img/') ||
    lower.startsWith('/images/') ||
    lower.startsWith('/_next/') ||
    lower.startsWith('/favicon')
  );
}

function isUrlInScope(args: {
  rootUrl: string;
  candidateUrl: string;
}): boolean {
  const scope = computeWebCrawlScope(args.rootUrl);
  const candidate = new URL(args.candidateUrl);
  if (candidate.origin !== scope.origin) {
    return false;
  }

  if (scope.pathPrefix === '/') {
    return true;
  }

  const pathname = candidate.pathname || '/';
  return pathname === scope.rootPath || pathname.startsWith(scope.pathPrefix);
}

function toChunkPath(url: string): string {
  const parsed = new URL(url);
  const pathname = parsed.pathname;
  if (!pathname || pathname === '/') {
    return 'index.md';
  }

  return extname(pathname) ? pathname.slice(1) : `${pathname.slice(1)}.md`;
}

function classifyWebPageFailure(error: unknown): {
  stage: WebPageFailure['stage'];
  reason: string;
  error: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('timed out') || lower.includes('timeout')) {
    return { stage: 'fetch', reason: 'timeout', error: message };
  }

  if (lower.includes('too short') || lower.includes('内容过短')) {
    return { stage: 'fetch', reason: 'too_short', error: message };
  }

  if (lower.includes('json')) {
    return { stage: 'fetch', reason: 'parse_error', error: message };
  }

  return { stage: 'fetch', reason: 'fetch_error', error: message };
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await Bun.sleep(ms);
}

async function fetchPageWithRetries(args: {
  provider: WebIngestProvider;
  url: string;
  fetchMode: WebFetchMode;
  runTempDir: string | null;
  retryMaxRetries: number;
  retryDelaySeconds: number;
}): Promise<{
  page: (WebFetchedPage & { attempts: number }) | null;
  failure: WebPageFailure | null;
  attempts: number;
}> {
  let lastError: unknown = null;
  let attempts = 0;

  for (let attempt = 0; attempt <= args.retryMaxRetries; attempt += 1) {
    attempts = attempt + 1;
    try {
      const page = await args.provider.fetchPage(args.url, {
        fetchMode: args.fetchMode,
        ...(args.runTempDir ? { runTempDir: args.runTempDir } : {}),
      });

      const normalizedFinalUrl = normalizeWebPageUrl(page.finalUrl);
      return {
        page: {
          requestedUrl: args.url,
          finalUrl: normalizedFinalUrl,
          title: page.title,
          canonicalUrl: page.canonicalUrl
            ? normalizeWebPageUrl(page.canonicalUrl)
            : null,
          markdown: page.markdown,
          html: page.html,
          links: page.links.map((link) => normalizeWebPageUrl(link)),
          fetchModeUsed: page.fetchModeUsed,
          attempts,
        },
        failure: null,
        attempts,
      };
    } catch (error) {
      lastError = error;
      if (attempt < args.retryMaxRetries) {
        await sleep(args.retryDelaySeconds * 1000);
      }
    }
  }

  const failure = classifyWebPageFailure(lastError);
  return {
    page: null,
    failure: {
      url: normalizeWebPageIdentity(args.url),
      stage: failure.stage,
      reason: failure.reason,
      error: failure.error,
      attempts,
    },
    attempts,
  };
}

async function collectPages(args: {
  rootUrl: string;
  crawl: boolean;
  maxPages: number;
  maxDepth: number;
  fetchMode: WebFetchMode;
  config: AppConfig;
  provider: WebIngestProvider;
  runTempDir: string | null;
  progress?: ProgressReporter;
}): Promise<CollectPagesResult> {
  const sourceKey = normalizeWebSourceIdentity(args.rootUrl);
  const retryConfig = args.config.web.ingest.providers.crawl4ai;
  const pageFailures: WebPageFailure[] = [];
  const pageAttempts: WebPageAttempt[] = [];

  const recordPage = (page: WebFetchedPage & { attempts: number }) => ({
    sourceKey,
    sourceLocator: normalizeWebPageIdentity(page.finalUrl),
    canonicalLocator: page.canonicalUrl
      ? normalizeWebPageIdentity(page.canonicalUrl)
      : null,
    path: normalizeWebPageIdentity(page.finalUrl),
    language: 'markdown',
    title: page.title,
    content: page.markdown,
    contentHash: sha256(page.markdown),
    attempts: page.attempts,
  });

  const crawlTask = args.progress?.task('Crawl pages', args.maxPages);
  const pages: CollectedWebPage[] = [];

  if (args.crawl && args.provider.id === 'crawl4ai') {
    const visited = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = [
      {
        url: args.rootUrl,
        depth: 0,
      },
    ];

    while (queue.length > 0 && pages.length < args.maxPages) {
      const next = queue.shift();
      if (!next) {
        break;
      }

      const normalized = normalizeWebPageUrl(next.url);
      const normalizedIdentity = normalizeWebPageIdentity(normalized);
      if (visited.has(normalizedIdentity)) {
        continue;
      }
      visited.add(normalizedIdentity);

      if (!sameOrigin(args.rootUrl, normalized)) {
        continue;
      }
      if (!isUrlInScope({ rootUrl: args.rootUrl, candidateUrl: normalized })) {
        continue;
      }

      const candidatePath = new URL(normalized).pathname || '/';
      if (hasNonHtmlExtension(candidatePath) || isNoisePath(candidatePath)) {
        continue;
      }

      const outcome = await fetchPageWithRetries({
        provider: args.provider,
        url: normalized,
        fetchMode: args.fetchMode,
        runTempDir: args.runTempDir,
        retryMaxRetries: retryConfig.retry_max_retries,
        retryDelaySeconds: retryConfig.retry_delay_seconds,
      });

      if (outcome.page) {
        pageAttempts.push({
          url: normalizedIdentity,
          stage: 'fetch',
          attempts: outcome.attempts,
        });
        const page = recordPage(outcome.page);
        pages.push(page);
        crawlTask?.increment(1);

        if (next.depth + 1 < args.maxDepth) {
          for (const link of outcome.page.links) {
            const normalizedLink = normalizeWebPageUrl(link);
            const normalizedLinkIdentity =
              normalizeWebPageIdentity(normalizedLink);
            if (visited.has(normalizedLinkIdentity)) {
              continue;
            }
            if (!sameOrigin(args.rootUrl, normalizedLink)) {
              continue;
            }
            if (
              !isUrlInScope({
                rootUrl: args.rootUrl,
                candidateUrl: normalizedLink,
              })
            ) {
              continue;
            }

            const linkPath = new URL(normalizedLink).pathname || '/';
            if (hasNonHtmlExtension(linkPath) || isNoisePath(linkPath)) {
              continue;
            }

            queue.push({
              url: normalizedLink,
              depth: next.depth + 1,
            });
          }
        }
      } else if (outcome.failure) {
        pageFailures.push(outcome.failure);
      }
    }

    crawlTask?.stop();
    return {
      pages,
      pageFailures,
      pageAttempts,
      crawlTempDir: args.runTempDir,
    };
  }

  if (args.crawl && args.provider.crawl) {
    const crawled: WebCrawlResult = await args.provider.crawl(args.rootUrl, {
      maxPages: args.maxPages,
      maxDepth: args.maxDepth,
      fetchMode: args.fetchMode,
    });

    for (const failure of crawled.pageFailures) {
      pageFailures.push(failure);
    }

    for (const attempt of crawled.pageAttempts) {
      pageAttempts.push(attempt);
    }

    for (const page of crawled.pages) {
      const normalized = normalizeWebPageUrl(page.finalUrl);
      pages.push({
        sourceKey,
        sourceLocator: normalized,
        canonicalLocator: page.canonicalUrl,
        path: normalized,
        language: 'markdown',
        title: page.title,
        content: page.markdown,
        contentHash: sha256(page.markdown),
        attempts: 1,
      });
      crawlTask?.increment(1);
    }

    crawlTask?.stop();
    return {
      pages,
      pageFailures,
      pageAttempts,
      crawlTempDir: null,
    };
  }

  const outcome = await fetchPageWithRetries({
    provider: args.provider,
    url: args.rootUrl,
    fetchMode: args.fetchMode,
    runTempDir: args.runTempDir,
    retryMaxRetries: retryConfig.retry_max_retries,
    retryDelaySeconds: retryConfig.retry_delay_seconds,
  });

  if (!outcome.page) {
    crawlTask?.stop();
    if (outcome.failure) {
      pageFailures.push(outcome.failure);
      return {
        pages,
        pageFailures,
        pageAttempts,
        crawlTempDir: args.runTempDir,
      };
    }

    return {
      pages,
      pageFailures,
      pageAttempts,
      crawlTempDir: args.runTempDir,
    };
  }

  const page = recordPage(outcome.page);
  pages.push(page);
  pageAttempts.push({
    url: normalizeWebPageIdentity(args.rootUrl),
    stage: 'fetch',
    attempts: outcome.attempts,
  });
  crawlTask?.increment(1);
  crawlTask?.stop();
  return {
    pages,
    pageFailures,
    pageAttempts,
    crawlTempDir: args.runTempDir,
  };
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
  const crawlTempDir =
    args.webIngestProvider.id === 'crawl4ai'
      ? await mkdtemp(join(tmpdir(), 'nya-cli-crawl4ai-run-'))
      : null;

  try {
    const collected = await collectPages({
      rootUrl: args.source,
      crawl: args.crawl,
      maxPages: args.maxPages,
      maxDepth: args.maxDepth,
      fetchMode: args.fetchMode,
      config: args.config,
      provider: args.webIngestProvider,
      runTempDir: crawlTempDir,
      ...(args.progress ? { progress: args.progress } : {}),
    });

    const { pages, pageFailures, pageAttempts } = collected;
    if (pages.length === 0 && pageFailures.length > 0) {
      throw new Error(
        `learn web 失败：没有可索引的页面；pageFailures=${pageFailures.length}`
      );
    }

    const embedTask = args.progress?.task('Embed pages', pages.length);
    const preparedDocuments = [];
    for (const page of pages) {
      try {
        const chunks = await chunkTextDocument({
          filePath: toChunkPath(page.sourceLocator),
          content: page.content,
          config: args.config,
        });
        if (chunks.length === 0) {
          if (args.crawl) {
            pageFailures.push({
              url: page.sourceLocator,
              stage: 'chunk',
              reason: 'no_chunks',
              error: '页面未生成任何 chunk',
              attempts: page.attempts,
            });
            embedTask?.increment(1);
            continue;
          }

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
            content: page.content,
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
      } catch (error) {
        if (!args.crawl) {
          throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        pageFailures.push({
          url: page.sourceLocator,
          stage: /embed/i.test(message) ? 'embed' : 'chunk',
          reason: /embed/i.test(message) ? 'embed_error' : 'chunk_error',
          error: message,
          attempts: page.attempts,
        });
        embedTask?.increment(1);
      }
    }
    embedTask?.stop();

    if (preparedDocuments.length === 0) {
      throw new Error(
        `learn web 失败：没有可索引的文档；pageFailures=${pageFailures.length}`
      );
    }

    const sourceKey = normalizeWebSourceIdentity(args.source);
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
        rootLocator: sourceKey,
        displayLocator: args.source,
        reingestPayloadJson: JSON.stringify({
          kind: 'web',
          source: sourceKey,
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
      failedPages: pageFailures.length,
      pageFailures,
      pageAttempts,
      crawlTempDir,
      rebuildTriggered: args.rebuildTriggered,
      rebuildReason: args.rebuildReason,
      fingerprint: args.embeddingProvider.fingerprint(
        args.config.index.chunking_version
      ),
      crawledPages: pages.length,
    };
  } finally {
    if (crawlTempDir) {
      await rm(crawlTempDir, { recursive: true, force: true });
    }
  }
}
