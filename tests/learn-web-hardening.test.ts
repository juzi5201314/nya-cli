import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { learnWebSource } from '../src/core/ingest/learn-web';
import {
  closeDatabase,
  getDbStats,
  initializeEmptyIndex,
  listSourceManifests,
  openDatabase,
} from '../src/db/database';
import type {
  EmbeddingFingerprint,
  EmbeddingProvider,
  WebIngestProvider,
} from '../src/providers/types';
import { createWebIngestProvider } from '../src/providers/web';
import type { AppConfig } from '../src/types/config';

const tempRoot = '/tmp/nya-cli-learn-web-hardening-tests';

const fixtureBin = join(import.meta.dir, 'fixtures', 'bin');
process.env.PATH = `${fixtureBin}:${process.env.PATH ?? ''}`;

function createConfig(overrides?: {
  retryMaxRetries?: number;
  retryDelaySeconds?: number;
  minMarkdownChars?: number;
  getPageTimeoutMs?: number;
  fetchPageTimeoutMs?: number;
}): AppConfig {
  return {
    app: {
      default_output: 'text',
      project_dir_name: '.nya-cli',
    },
    web: {
      search: {
        provider: 'tavily',
        providers: {
          tavily: {
            api_key_env: 'TAVILY_API_KEY',
            default_topic: 'general',
            default_search_depth: 'basic',
            rpm: 0,
            tpm: 0,
            retry_max_retries: 0,
            retry_delay_seconds: 0,
          },
        },
      },
      ingest: {
        provider: 'crawl4ai',
        providers: {
          crawl4ai: {
            command: 'crwl',
            default_fetch_mode: 'auto',
            default_crawl: false,
            default_max_pages: 10,
            default_max_depth: 2,
            min_markdown_chars: overrides?.minMarkdownChars ?? 20,
            get_page_timeout_ms: overrides?.getPageTimeoutMs ?? 1000,
            fetch_page_timeout_ms: overrides?.fetchPageTimeoutMs ?? 1000,
            rpm: 0,
            tpm: 0,
            retry_max_retries: overrides?.retryMaxRetries ?? 0,
            retry_delay_seconds: overrides?.retryDelaySeconds ?? 0,
          },
          cloudflare: {
            account_id: '',
            api_token_env: 'CLOUDFLARE_API_TOKEN',
            base_url: 'https://api.cloudflare.com/client/v4',
            default_fetch_mode: 'auto',
            default_crawl: false,
            default_max_pages: 10,
            default_max_depth: 2,
            min_markdown_chars: 20,
            poll_interval_ms: 5000,
            max_poll_attempts: 60,
            source: 'all',
            include_external_links: false,
            include_subdomains: false,
            include_patterns: [],
            exclude_patterns: [],
            rpm: 0,
            tpm: 0,
            retry_max_retries: 0,
            retry_delay_seconds: 0,
          },
        },
      },
    },
    embedding: {
      provider: 'google',
      model: 'fake-google-embedding',
      task_type: 'RETRIEVAL_DOCUMENT',
      providers: {
        google: {
          api_key_env: 'GOOGLE_GENERATIVE_AI_API_KEY',
          output_dimensionality: 4,
          rpm: 0,
          tpm: 0,
          retry_max_retries: 0,
          retry_delay_seconds: 0,
        },
        openai: {
          api_key_env: 'OPENAI_API_KEY',
          base_url: 'https://api.openai.com/v1',
          dimensions: 4,
          rpm: 0,
          tpm: 0,
          retry_max_retries: 0,
          retry_delay_seconds: 0,
        },
      },
    },
    rerank: {
      provider: 'none',
    },
    llm: {
      provider: 'google',
      model: 'fake-llm',
      providers: {
        google: {
          api_key_env: 'GOOGLE_GENERATIVE_AI_API_KEY',
          rpm: 0,
          tpm: 0,
          retry_max_retries: 0,
          retry_delay_seconds: 0,
        },
        openai: {
          api_key_env: 'OPENAI_API_KEY',
          base_url: 'https://api.openai.com/v1',
          rpm: 0,
          tpm: 0,
          retry_max_retries: 0,
          retry_delay_seconds: 0,
        },
      },
    },
    ai_search: {
      max_steps: 3,
      max_queries_per_step: 3,
      retrieval_limit: 8,
      max_evidence_chunks: 12,
    },
    index: {
      chunk_size: 200,
      chunk_overlap: 20,
      chunking_version: 'v1',
      fts: true,
      vector: true,
      max_file_bytes: 262144,
    },
  };
}

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'google' as const;
  readonly model = 'fake-google-embedding';
  readonly dimensions = 4;

  private encode(text: string): number[] {
    const normalized = text.toLowerCase();
    return [
      normalized.includes('home') ? 10 : 0,
      normalized.includes('guide') ? 10 : 0,
      normalized.includes('retry') ? 10 : 0,
      normalized.includes('secret') ? 10 : 0,
    ];
  }

  async embedDocuments(values: string[]): Promise<number[][]> {
    return values.map((value) => this.encode(value));
  }

  async embedQuery(value: string): Promise<number[]> {
    return this.encode(value);
  }

  fingerprint(chunkingVersion: string): EmbeddingFingerprint {
    return {
      provider: this.id,
      model: this.model,
      dimensions: this.dimensions,
      taskType: 'RETRIEVAL_DOCUMENT',
      chunkingVersion,
      chunker: 'tree-sitter',
    };
  }
}

function createScopePaths(dbPath: string) {
  return {
    scope: 'project' as const,
    projectDirName: '.nya-cli',
    databasePath: dbPath,
    databaseDir: dirname(dbPath),
    remoteCacheDir: join(tempRoot, 'cache'),
  };
}

beforeEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
});

describe('learn web hardening', () => {
  test('crawl continues after per-page failures and records structured failures', async () => {
    const dbPath = join(tempRoot, 'crawl.sqlite');
    const db = await openDatabase(dbPath);
    const embeddingProvider = new FakeEmbeddingProvider();
    const config = createConfig();
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
    );

    const provider: WebIngestProvider = {
      id: 'crawl4ai',
      async assertAvailable() {},
      async fetchPage(url, _options) {
        if (url.endsWith('/')) {
          return {
            requestedUrl: url,
            finalUrl: url,
            title: 'Home',
            canonicalUrl: null,
            markdown:
              '# Home\n\nThis page is long enough to be indexed and links out.',
            html: '',
            links: [`${url}bad-one`, `${url}bad-two`],
            fetchModeUsed: 'get',
          };
        }

        throw new Error(
          url.includes('bad-one')
            ? 'simulated timeout while fetching page'
            : 'simulated parse failure while fetching page'
        );
      },
    };

    try {
      const result = await learnWebSource({
        source: 'https://example.com/docs/',
        config,
        db,
        scope: 'project',
        scopePaths: createScopePaths(dbPath),
        embeddingProvider,
        webIngestProvider: provider,
        rebuildTriggered: false,
        rebuildReason: null,
        crawl: true,
        maxPages: 10,
        maxDepth: 2,
        fetchMode: 'get',
      });

      expect(result.documentsIndexed).toBe(1);
      expect(result.failedPages).toBe(2);
      expect(result.pageFailures).toHaveLength(2);
      expect(result.pageFailures.every((item) => item.attempts === 1)).toBe(
        true
      );
      expect(result.pageAttempts).toHaveLength(1);
      expect(result.pageAttempts[0]?.attempts).toBe(1);
      expect(getDbStats(db).documents).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  test('single-page learn is atomic on failure', async () => {
    const dbPath = join(tempRoot, 'atomic.sqlite');
    const db = await openDatabase(dbPath);
    const embeddingProvider = new FakeEmbeddingProvider();
    const config = createConfig();
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
    );

    const provider: WebIngestProvider = {
      id: 'crawl4ai',
      async assertAvailable() {},
      async fetchPage(_url, _options) {
        throw new Error('page fetch boom');
      },
    };

    try {
      await expect(
        learnWebSource({
          source: 'https://example.com/atomic',
          config,
          db,
          scope: 'project',
          scopePaths: createScopePaths(dbPath),
          embeddingProvider,
          webIngestProvider: provider,
          rebuildTriggered: false,
          rebuildReason: null,
          crawl: false,
          maxPages: 10,
          maxDepth: 1,
          fetchMode: 'get',
        })
      ).rejects.toThrow(/learn web 失败|page fetch boom/);

      expect(getDbStats(db).documents).toBe(0);
      expect(getDbStats(db).chunks).toBe(0);
      const vectorRows = db
        .query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM chunk_vec')
        .get();
      expect(Number(vectorRows?.count ?? 0n)).toBe(0);

      const manifests = listSourceManifests(db);
      if (manifests.length > 0) {
        expect(
          manifests.every((item) => item.lastRebuildStatus === 'failed')
        ).toBe(true);
      }
    } finally {
      closeDatabase(db);
    }
  });

  test('Crawl4AI timeouts are surfaced and the run temp dir is cleaned', async () => {
    const dbPath = join(tempRoot, 'timeout.sqlite');
    const db = await openDatabase(dbPath);
    const embeddingProvider = new FakeEmbeddingProvider();
    const config = createConfig({
      getPageTimeoutMs: 1000,
      fetchPageTimeoutMs: 1000,
    });
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
    );

    process.env.CRWL_CHILD_PATH = 'slow';
    process.env.CRWL_SLEEP_MATCH = 'slow';
    process.env.CRWL_SLEEP_SECONDS = '3';

    try {
      const result = await learnWebSource({
        source: 'https://example.com/docs/',
        config,
        db,
        scope: 'project',
        scopePaths: createScopePaths(dbPath),
        embeddingProvider,
        webIngestProvider: createWebIngestProvider(config),
        rebuildTriggered: false,
        rebuildReason: null,
        crawl: true,
        maxPages: 10,
        maxDepth: 2,
        fetchMode: 'get',
      });

      expect(result.failedPages).toBe(1);
      expect(result.pageFailures[0]?.reason).toBe('timeout');
      expect(result.pageFailures[0]?.attempts).toBe(1);
      expect(result.crawlTempDir).toBeTruthy();
      expect(existsSync(result.crawlTempDir ?? '')).toBe(false);
      expect(result.documentsIndexed).toBe(1);
    } finally {
      delete process.env.CRWL_CHILD_PATH;
      delete process.env.CRWL_SLEEP_MATCH;
      delete process.env.CRWL_SLEEP_SECONDS;
      closeDatabase(db);
    }
  });

  test('Crawl4AI retries are observable in attempts', async () => {
    const dbPath = join(tempRoot, 'retry.sqlite');
    const db = await openDatabase(dbPath);
    const embeddingProvider = new FakeEmbeddingProvider();
    const config = createConfig({ retryMaxRetries: 2, retryDelaySeconds: 0 });
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
    );

    process.env.CRWL_STATE_FILE = join(tempRoot, 'crwl-state');
    process.env.CRWL_FAIL_MATCH = 'retry';
    process.env.CRWL_FAIL_UNTIL_ATTEMPT = '2';

    try {
      const result = await learnWebSource({
        source: 'https://example.com/retry',
        config,
        db,
        scope: 'project',
        scopePaths: createScopePaths(dbPath),
        embeddingProvider,
        webIngestProvider: createWebIngestProvider(config),
        rebuildTriggered: false,
        rebuildReason: null,
        crawl: false,
        maxPages: 10,
        maxDepth: 1,
        fetchMode: 'get',
      });

      expect(result.documentsIndexed).toBe(1);
      expect(result.pageAttempts).toHaveLength(1);
      expect(result.pageAttempts[0]?.attempts).toBe(3);
      expect(result.failedPages).toBe(0);
    } finally {
      delete process.env.CRWL_STATE_FILE;
      delete process.env.CRWL_FAIL_MATCH;
      delete process.env.CRWL_FAIL_UNTIL_ATTEMPT;
      closeDatabase(db);
    }
  });

  test('fragment-only URLs share identity', async () => {
    const dbPath = join(tempRoot, 'fragment.sqlite');
    const db = await openDatabase(dbPath);
    const embeddingProvider = new FakeEmbeddingProvider();
    const config = createConfig();
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
    );

    const provider: WebIngestProvider = {
      id: 'crawl4ai',
      async assertAvailable() {},
      async fetchPage(url, _options) {
        return {
          requestedUrl: url,
          finalUrl: url,
          title: 'Docs',
          canonicalUrl: null,
          markdown: '# Docs\n\nThis fragment is ignored for source identity.',
          html: '',
          links: [],
          fetchModeUsed: 'get',
        };
      },
    };

    try {
      await learnWebSource({
        source: 'https://example.com/docs#section-a',
        config,
        db,
        scope: 'project',
        scopePaths: createScopePaths(dbPath),
        embeddingProvider,
        webIngestProvider: provider,
        rebuildTriggered: false,
        rebuildReason: null,
        crawl: false,
        maxPages: 10,
        maxDepth: 1,
        fetchMode: 'get',
      });

      await learnWebSource({
        source: 'https://example.com/docs#section-b',
        config,
        db,
        scope: 'project',
        scopePaths: createScopePaths(dbPath),
        embeddingProvider,
        webIngestProvider: provider,
        rebuildTriggered: false,
        rebuildReason: null,
        crawl: false,
        maxPages: 10,
        maxDepth: 1,
        fetchMode: 'get',
      });

      const manifests = listSourceManifests(db);
      expect(manifests).toHaveLength(1);
      expect(manifests[0]?.sourceKey).not.toContain('#');
      expect(manifests[0]?.sourceKey).toContain('https://example.com/docs');
    } finally {
      closeDatabase(db);
    }
  });

  test('secret query params do not affect source identity', async () => {
    const dbPath = join(tempRoot, 'secret.sqlite');
    const db = await openDatabase(dbPath);
    const embeddingProvider = new FakeEmbeddingProvider();
    const config = createConfig();
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
    );

    const provider: WebIngestProvider = {
      id: 'crawl4ai',
      async assertAvailable() {},
      async fetchPage(url, _options) {
        return {
          requestedUrl: url,
          finalUrl: url,
          title: 'Docs',
          canonicalUrl: null,
          markdown: '# Docs\n\nSecret query params should not leak.',
          html: '',
          links: [],
          fetchModeUsed: 'get',
        };
      },
    };

    try {
      await learnWebSource({
        source: 'https://example.com/docs?token=alpha',
        config,
        db,
        scope: 'project',
        scopePaths: createScopePaths(dbPath),
        embeddingProvider,
        webIngestProvider: provider,
        rebuildTriggered: false,
        rebuildReason: null,
        crawl: false,
        maxPages: 10,
        maxDepth: 1,
        fetchMode: 'get',
      });

      await learnWebSource({
        source: 'https://example.com/docs?token=beta',
        config,
        db,
        scope: 'project',
        scopePaths: createScopePaths(dbPath),
        embeddingProvider,
        webIngestProvider: provider,
        rebuildTriggered: false,
        rebuildReason: null,
        crawl: false,
        maxPages: 10,
        maxDepth: 1,
        fetchMode: 'get',
      });

      const manifests = listSourceManifests(db);
      expect(manifests).toHaveLength(1);

      const serialized = JSON.stringify(manifests);
      expect(serialized).not.toContain('alpha');
      expect(serialized).not.toContain('beta');
      expect(serialized).toContain('[REDACTED]');
    } finally {
      closeDatabase(db);
    }
  });

  test('crawl dedupes secret-query variants before insertion', async () => {
    const dbPath = join(tempRoot, 'crawl-secret-dedupe.sqlite');
    const db = await openDatabase(dbPath);
    const embeddingProvider = new FakeEmbeddingProvider();
    const config = createConfig();
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
    );

    const fetchedUrls: string[] = [];
    const provider: WebIngestProvider = {
      id: 'crawl4ai',
      async assertAvailable() {},
      async fetchPage(url, _options) {
        fetchedUrls.push(url);

        if (
          url === 'https://example.com/docs/' ||
          url === 'https://example.com/docs'
        ) {
          return {
            requestedUrl: url,
            finalUrl: 'https://example.com/docs/',
            title: 'Docs Home',
            canonicalUrl: null,
            markdown:
              '# Docs Home\n\nThis page links to the same page with secret query variants.',
            html: '',
            links: [
              'https://example.com/docs/secure?token=alpha',
              'https://example.com/docs/secure?token=beta',
            ],
            fetchModeUsed: 'get',
          };
        }

        if (url.includes('/docs/secure?token=alpha')) {
          return {
            requestedUrl: url,
            finalUrl: url,
            title: 'Secure Alpha',
            canonicalUrl: null,
            markdown: '# Secure Alpha\n\nAlpha variant content.',
            html: '',
            links: [],
            fetchModeUsed: 'get',
          };
        }

        if (url.includes('/docs/secure?token=beta')) {
          return {
            requestedUrl: url,
            finalUrl: url,
            title: 'Secure Beta',
            canonicalUrl: null,
            markdown: '# Secure Beta\n\nBeta variant content.',
            html: '',
            links: [],
            fetchModeUsed: 'get',
          };
        }

        throw new Error(`unexpected crawl url: ${url}`);
      },
    };

    try {
      const result = await learnWebSource({
        source: 'https://example.com/docs/',
        config,
        db,
        scope: 'project',
        scopePaths: createScopePaths(dbPath),
        embeddingProvider,
        webIngestProvider: provider,
        rebuildTriggered: false,
        rebuildReason: null,
        crawl: true,
        maxPages: 10,
        maxDepth: 2,
        fetchMode: 'get',
      });

      expect(result.documentsIndexed).toBe(2);
      expect(result.crawledPages).toBe(2);
      expect(result.failedPages).toBe(0);
      expect(result.pageAttempts).toHaveLength(2);
      expect(
        fetchedUrls.filter((url) => url.includes('/docs/secure?token='))
      ).toHaveLength(1);
      expect(getDbStats(db).documents).toBe(2);
    } finally {
      closeDatabase(db);
    }
  });
});
