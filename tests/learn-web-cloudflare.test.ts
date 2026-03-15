import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { learnWebSource } from '../src/core/ingest/learn-web';
import {
  closeDatabase,
  getDbStats,
  initializeEmptyIndex,
  openDatabase,
} from '../src/db/database';
import type {
  EmbeddingFingerprint,
  EmbeddingProvider,
} from '../src/providers/types';
import { createWebIngestProvider } from '../src/providers/web';
import type { AppConfig } from '../src/types/config';

const tempRoot = '/tmp/nya-cli-web-cloudflare-tests';

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'google' as const;
  readonly model = 'fake-google-embedding';
  readonly dimensions = 4;

  async embedDocuments(values: string[]): Promise<number[][]> {
    return values.map(() => [0, 0, 0, 0]);
  }

  async embedQuery(): Promise<number[]> {
    return [0, 0, 0, 0];
  }

  fingerprint(chunkingVersion: string): EmbeddingFingerprint {
    return {
      provider: this.id,
      model: this.model,
      dimensions: this.dimensions,
      taskType: 'RETRIEVAL_DOCUMENT',
      chunkingVersion,
    };
  }
}

beforeEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
});

function createConfig(args: { baseUrl: string }): AppConfig {
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
          },
        },
      },
      ingest: {
        provider: 'cloudflare',
        providers: {
          scrapling: {
            command: 'scrapling',
            default_fetch_mode: 'auto',
            default_crawl: false,
            default_max_pages: 25,
            default_max_depth: 2,
            same_origin_only: true,
            min_markdown_chars: 20,
            get_timeout_seconds: 30,
            fetch_timeout_ms: 30000,
            fetch_wait_ms: 0,
          },
          cloudflare: {
            account_id: 'test-account',
            api_token_env: 'CLOUDFLARE_API_TOKEN',
            base_url: args.baseUrl,
            default_fetch_mode: 'auto',
            default_crawl: false,
            default_max_pages: 25,
            default_max_depth: 2,
            min_markdown_chars: 20,
            poll_interval_ms: 10,
            max_poll_attempts: 5,
            source: 'all',
            include_external_links: false,
            include_subdomains: false,
            include_patterns: [],
            exclude_patterns: [],
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
        },
        openai: {
          api_key_env: 'OPENAI_API_KEY',
          base_url: 'https://api.openai.com/v1',
          dimensions: 4,
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
        },
        openai: {
          api_key_env: 'OPENAI_API_KEY',
          base_url: 'https://api.openai.com/v1',
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

describe('learn web (cloudflare)', () => {
  test('learns a single page; auto falls back to render=true', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';

    let jobCounter = 0;
    const jobs = new Map<
      string,
      {
        render: boolean;
        url: string;
        limit: number;
        depth: number;
      }
    >();

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        if (
          request.method === 'POST' &&
          pathname ===
            '/client/v4/accounts/test-account/browser-rendering/crawl'
        ) {
          const body = (await request.json()) as {
            url: string;
            limit: number;
            depth: number;
            render: boolean;
          };
          const jobId = `job-${jobCounter++}`;
          jobs.set(jobId, {
            render: Boolean(body.render),
            url: body.url,
            limit: body.limit,
            depth: body.depth,
          });
          return Response.json({ success: true, result: jobId });
        }

        const match = /^\/client\/v4\/accounts\/test-account\/browser-rendering\/crawl\/([^/]+)$/.exec(
          pathname
        );
        if (request.method === 'GET' && match) {
          const jobId = match[1] ?? '';
          const job = jobs.get(jobId);
          if (!job) {
            return Response.json({ success: false, errors: ['not found'] }, { status: 404 });
          }

          if (url.searchParams.get('limit') === '1' && !url.searchParams.get('status')) {
            return Response.json({
              success: true,
              result: { id: jobId, status: 'completed' },
            });
          }

          const render = job.render;
          const markdown = render
            ? '# Docs\n\nThis page contains enough content for indexing.'
            : 'short';

          return Response.json({
            success: true,
            result: {
              id: jobId,
              status: 'completed',
              records: [
                {
                  url: job.url,
                  status: 'completed',
                  markdown,
                  metadata: { status: 200, title: 'Docs', url: job.url },
                },
              ],
            },
          });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const config = createConfig({
      baseUrl: `http://127.0.0.1:${server.port}/client/v4`,
    });

    const db = await openDatabase(join(tempRoot, 'index.sqlite'));
    const embeddingProvider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
    );

    try {
      const result = await learnWebSource({
        source: 'https://example.com/docs',
        config,
        db,
        scope: 'project',
        scopePaths: {
          scope: 'project',
          projectDirName: '.nya-cli',
          databasePath: join(tempRoot, 'index.sqlite'),
          databaseDir: tempRoot,
          remoteCacheDir: join(tempRoot, 'cache'),
        },
        embeddingProvider,
        webIngestProvider: createWebIngestProvider(config),
        rebuildTriggered: false,
        rebuildReason: null,
        crawl: false,
        maxPages: 10,
        maxDepth: 1,
        fetchMode: 'auto',
      });

      expect(result.documentsIndexed).toBe(1);
      expect(getDbStats(db).documents).toBe(1);
    } finally {
      server.stop(true);
      closeDatabase(db);
    }
  });

  test('crawls multiple pages and supports cursor pagination', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';

    let jobCounter = 0;
    const jobs = new Map<
      string,
      {
        render: boolean;
        url: string;
        limit: number;
        depth: number;
      }
    >();

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        if (
          request.method === 'POST' &&
          pathname ===
            '/client/v4/accounts/test-account/browser-rendering/crawl'
        ) {
          const body = (await request.json()) as {
            url: string;
            limit: number;
            depth: number;
            render: boolean;
          };
          const jobId = `job-${jobCounter++}`;
          jobs.set(jobId, {
            render: Boolean(body.render),
            url: body.url,
            limit: body.limit,
            depth: body.depth,
          });
          return Response.json({ success: true, result: jobId });
        }

        const match = /^\/client\/v4\/accounts\/test-account\/browser-rendering\/crawl\/([^/]+)$/.exec(
          pathname
        );
        if (request.method === 'GET' && match) {
          const jobId = match[1] ?? '';
          const job = jobs.get(jobId);
          if (!job) {
            return Response.json({ success: false, errors: ['not found'] }, { status: 404 });
          }

          if (url.searchParams.get('limit') === '1' && !url.searchParams.get('status')) {
            return Response.json({
              success: true,
              result: { id: jobId, status: 'completed' },
            });
          }

          const cursor = url.searchParams.get('cursor');
          const offset = cursor ? Number.parseInt(cursor, 10) : 0;

          const all = [
            {
              url: `${job.url}`.replace(/\/+$/, '') + '/',
              status: 'completed',
              markdown: '# Home\n\nFirst page content is long enough for indexing.',
              metadata: { status: 200, title: 'Home', url: `${job.url}` },
            },
            {
              url: `${job.url}`.replace(/\/+$/, '') + '/guide',
              status: 'completed',
              markdown: '# Guide\n\nSecond page content is also long enough for indexing.',
              metadata: { status: 200, title: 'Guide', url: `${job.url}` },
            },
          ];

          const batch = all.slice(offset, offset + 1);
          const nextCursor = offset + batch.length < all.length ? offset + batch.length : null;

          return Response.json({
            success: true,
            result: {
              id: jobId,
              status: 'completed',
              records: batch,
              cursor: nextCursor ?? undefined,
            },
          });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const config = createConfig({
      baseUrl: `http://127.0.0.1:${server.port}/client/v4`,
    });

    const db = await openDatabase(join(tempRoot, 'crawl.sqlite'));
    const embeddingProvider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
    );

    try {
      const result = await learnWebSource({
        source: 'https://example.com',
        config,
        db,
        scope: 'project',
        scopePaths: {
          scope: 'project',
          projectDirName: '.nya-cli',
          databasePath: join(tempRoot, 'crawl.sqlite'),
          databaseDir: tempRoot,
          remoteCacheDir: join(tempRoot, 'cache'),
        },
        embeddingProvider,
        webIngestProvider: createWebIngestProvider(config),
        rebuildTriggered: false,
        rebuildReason: null,
        crawl: true,
        maxPages: 10,
        maxDepth: 2,
        fetchMode: 'get',
      });

      expect(result.crawledPages).toBe(2);
      expect(getDbStats(db).documents).toBe(2);
    } finally {
      server.stop(true);
      closeDatabase(db);
    }
  });
});

