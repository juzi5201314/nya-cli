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

const tempRoot = '/tmp/nya-cli-web-tests';

const config: AppConfig = {
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
          retry_max_retries: 3,
          retry_delay_seconds: 10,
        },
      },
    },
    ingest: {
      provider: 'scrapling',
      providers: {
        scrapling: {
          command: 'scrapling',
          default_fetch_mode: 'auto',
          default_crawl: false,
          default_max_pages: 10,
          default_max_depth: 1,
          same_origin_only: true,
          min_markdown_chars: 20,
          get_timeout_seconds: 30,
          fetch_timeout_ms: 30000,
          fetch_wait_ms: 0,
          rpm: 0,
          tpm: 0,
          retry_max_retries: 3,
          retry_delay_seconds: 10,
        },
        cloudflare: {
          account_id: '',
          api_token_env: 'CLOUDFLARE_API_TOKEN',
          base_url: 'https://api.cloudflare.com/client/v4',
          default_fetch_mode: 'auto',
          default_crawl: false,
          default_max_pages: 10,
          default_max_depth: 1,
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
          retry_max_retries: 3,
          retry_delay_seconds: 10,
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
        retry_max_retries: 3,
        retry_delay_seconds: 10,
      },
      openai: {
        api_key_env: 'OPENAI_API_KEY',
        base_url: 'https://api.openai.com/v1',
        dimensions: 4,
        rpm: 0,
        tpm: 0,
        retry_max_retries: 3,
        retry_delay_seconds: 10,
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
        retry_max_retries: 3,
        retry_delay_seconds: 10,
      },
      openai: {
        api_key_env: 'OPENAI_API_KEY',
        base_url: 'https://api.openai.com/v1',
        rpm: 0,
        tpm: 0,
        retry_max_retries: 3,
        retry_delay_seconds: 10,
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

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'google' as const;
  readonly model = 'fake-google-embedding';
  readonly dimensions = 4;

  private encode(text: string): number[] {
    const normalized = text.toLowerCase();
    return [
      normalized.includes('tavily') ? 10 : 0,
      normalized.includes('gemini') ? 10 : 0,
      normalized.includes('crawl') ? 10 : 0,
      normalized.includes('agents') ? 10 : 0,
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

beforeEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
});

describe('learn web', () => {
  test('learns a single page with scrapling', async () => {
    const db = await openDatabase(join(tempRoot, 'index.sqlite'));
    const provider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      provider.fingerprint(config.index.chunking_version)
    );

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/docs') {
          return new Response(
            `
              <html>
                <head><title>Docs</title></head>
                <body>
                  <article>
                    <h1>Docs</h1>
                    <p>Tavily and Gemini help agents search knowledge bases.</p>
                  </article>
                </body>
              </html>
            `,
            {
              headers: {
                'content-type': 'text/html',
              },
            }
          );
        }

        return new Response('not found', { status: 404 });
      },
    });

    try {
      const result = await learnWebSource({
        source: `http://127.0.0.1:${server.port}/docs`,
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
        embeddingProvider: provider,
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

  test('crawls multiple pages when --crawl is enabled', async () => {
    const db = await openDatabase(join(tempRoot, 'crawl.sqlite'));
    const provider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      provider.fingerprint(config.index.chunking_version)
    );

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/') {
          return new Response(
            `
              <html>
                <head><title>Home</title></head>
                <body>
                  <article>
                    <h1>Home</h1>
                    <p>Tavily helps search the open web.</p>
                  </article>
                  <a href="/guide">Guide</a>
                </body>
              </html>
            `,
            { headers: { 'content-type': 'text/html' } }
          );
        }

        if (url.pathname === '/guide') {
          return new Response(
            `
              <html>
                <head><title>Guide</title></head>
                <body>
                  <article>
                    <h1>Guide</h1>
                    <p>Gemini embeddings power local search for agents.</p>
                  </article>
                </body>
              </html>
            `,
            { headers: { 'content-type': 'text/html' } }
          );
        }

        return new Response('not found', { status: 404 });
      },
    });

    try {
      const result = await learnWebSource({
        source: `http://127.0.0.1:${server.port}/`,
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
        embeddingProvider: provider,
        webIngestProvider: createWebIngestProvider(config),
        rebuildTriggered: false,
        rebuildReason: null,
        crawl: true,
        maxPages: 10,
        maxDepth: 2,
        fetchMode: 'auto',
      });

      expect(result.crawledPages).toBe(2);
      expect(getDbStats(db).documents).toBe(2);
    } finally {
      server.stop(true);
      closeDatabase(db);
    }
  });
});
