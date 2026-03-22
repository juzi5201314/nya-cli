import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { learnGitSource } from '../src/core/ingest/learn-git';
import { searchIndex } from '../src/core/search/search-index';
import {
  closeDatabase,
  initializeEmptyIndex,
  openDatabase,
  replaceSourceData,
} from '../src/db/database';
import type {
  EmbeddingFingerprint,
  EmbeddingProvider,
} from '../src/providers/types';
import type { AppConfig } from '../src/types/config';

const tempRoot = '/tmp/nya-cli-tests';

const baseConfig: AppConfig = {
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
      provider: 'crawl4ai',
      providers: {
        crawl4ai: {
          command: 'crwl',
          default_fetch_mode: 'auto',
          default_crawl: false,
          default_max_pages: 25,
          default_max_depth: 2,
          min_markdown_chars: 200,
          get_page_timeout_ms: 30000,
          fetch_page_timeout_ms: 60000,
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
          default_max_pages: 25,
          default_max_depth: 2,
          min_markdown_chars: 200,
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
    chunk_size: 120,
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
      normalized.includes('vector') ? 10 : 0,
      normalized.includes('search') ? 10 : 0,
      normalized.includes('git') ? 10 : 0,
      normalized.includes('agent') ? 10 : 0,
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

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderr);
  }
}

beforeEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
});

describe('learn and search', () => {
  test('indexes a local git repository and returns search hits', async () => {
    const repoDir = join(tempRoot, 'repo');
    const dbDir = join(tempRoot, 'db');
    await mkdir(repoDir, { recursive: true });

    await writeFile(
      join(repoDir, 'README.md'),
      '# Intro\n\nThis repository explains vector search for agent workflows.\n'
    );
    await writeFile(
      join(repoDir, 'guide.ts'),
      'export const guide = "git repositories can be indexed for search";\n'
    );

    await runGit(repoDir, ['init']);
    await runGit(repoDir, ['add', '.']);

    const db = await openDatabase(join(dbDir, 'index.sqlite'));
    const provider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      provider.fingerprint(baseConfig.index.chunking_version)
    );

    const learnResult = await learnGitSource({
      source: repoDir,
      config: baseConfig,
      db,
      scope: 'project',
      scopePaths: {
        scope: 'project',
        projectDirName: '.nya-cli',
        databasePath: join(dbDir, 'index.sqlite'),
        databaseDir: dbDir,
        remoteCacheDir: join(tempRoot, 'cache'),
      },
      embeddingProvider: provider,
      rebuildTriggered: true,
      rebuildReason: 'index bootstrap required',
    });

    expect(learnResult.documentsIndexed).toBe(2);
    expect(learnResult.chunksIndexed).toBeGreaterThanOrEqual(2);

    const searchResult = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'vector search',
      limit: 5,
      scope: 'project',
      databasePath: join(dbDir, 'index.sqlite'),
    });

    expect(searchResult.results.length).toBeGreaterThan(0);
    expect(searchResult.results[0]?.path).toBe('README.md');

    closeDatabase(db);
  });

  test('skips binary files and common ignored paths during git ingest', async () => {
    const repoDir = join(tempRoot, 'repo');
    const dbDir = join(tempRoot, 'db');
    await mkdir(join(repoDir, 'node_modules/pkg'), { recursive: true });
    await mkdir(join(repoDir, 'dist'), { recursive: true });

    await writeFile(
      join(repoDir, 'README.md'),
      '# Intro\n\nOnly this file should be indexed.\n'
    );
    await writeFile(
      join(repoDir, 'node_modules/pkg/index.js'),
      'export const ignored = "node_modules should be skipped";\n'
    );
    await writeFile(
      join(repoDir, 'dist/app.js'),
      'export const bundle = "dist output should be skipped";\n'
    );
    await writeFile(
      join(repoDir, 'package-lock.json'),
      '{"name":"fixture","lockfileVersion":3}\n'
    );
    await writeFile(
      join(repoDir, 'binary.dat'),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x80, 0x81, 0x82, 0x83])
    );

    await runGit(repoDir, ['init']);
    await runGit(repoDir, ['add', '.']);

    const db = await openDatabase(join(dbDir, 'index.sqlite'));
    const provider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      provider.fingerprint(baseConfig.index.chunking_version)
    );

    const learnResult = await learnGitSource({
      source: repoDir,
      config: baseConfig,
      db,
      scope: 'project',
      scopePaths: {
        scope: 'project',
        projectDirName: '.nya-cli',
        databasePath: join(dbDir, 'index.sqlite'),
        databaseDir: dbDir,
        remoteCacheDir: join(tempRoot, 'cache'),
      },
      embeddingProvider: provider,
      rebuildTriggered: false,
      rebuildReason: null,
    });

    const readmeResult = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'indexed file',
      limit: 5,
      scope: 'project',
      databasePath: join(dbDir, 'index.sqlite'),
    });
    const ignoredResult = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'node_modules ignored bundle skipped',
      limit: 5,
      scope: 'project',
      databasePath: join(dbDir, 'index.sqlite'),
    });

    expect(learnResult.documentsIndexed).toBe(1);
    expect(readmeResult.results[0]?.path).toBe('README.md');
    expect(
      ignoredResult.results.some(
        (item) =>
          item.path.includes('node_modules') ||
          item.path.includes('dist/') ||
          item.path === 'binary.dat' ||
          item.path === 'package-lock.json'
      )
    ).toBe(false);

    closeDatabase(db);
  });

  test('prefers path and section matches for code identifier queries', async () => {
    const dbDir = join(tempRoot, 'db');
    const dbPath = join(dbDir, 'index.sqlite');
    const db = await openDatabase(dbPath);
    const provider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      provider.fingerprint(baseConfig.index.chunking_version)
    );

    replaceSourceData({
      db,
      sourceKey: 'repo',
      documents: [
        {
          document: {
            sourceKey: 'repo',
            sourceKind: 'local_git',
            sourceLocator: '/repo',
            canonicalLocator: null,
            path: 'src/core/search/search-index.ts',
            language: 'ts',
            title: 'search-index.ts',
            contentHash: 'doc-1',
            content: 'Implements reciprocal rank fusion for local retrieval.',
          },
          chunks: [
            {
              chunkIndex: 0,
              section: 'search-index.ts',
              content: 'Implements reciprocal rank fusion for local retrieval.',
              tokenEstimate: 10,
              contentHash: 'chunk-1',
            },
          ],
          embedding: [[0, 0, 0, 0]],
        },
        {
          document: {
            sourceKey: 'repo',
            sourceKind: 'local_git',
            sourceLocator: '/repo',
            canonicalLocator: null,
            path: 'src/commands/search.ts',
            language: 'ts',
            title: 'search.ts',
            contentHash: 'doc-2',
            content:
              'import { searchIndex } from "../core/search/search-index";',
          },
          chunks: [
            {
              chunkIndex: 0,
              section: 'search.ts',
              content:
                'import { searchIndex } from "../core/search/search-index";',
              tokenEstimate: 10,
              contentHash: 'chunk-2',
            },
          ],
          embedding: [[10, 10, 10, 10]],
        },
      ],
    });

    const searchResult = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'searchIndex',
      limit: 5,
      scope: 'project',
      databasePath: dbPath,
    });

    expect(searchResult.results[0]?.path).toBe(
      'src/core/search/search-index.ts'
    );

    closeDatabase(db);
  });

  test('builds snippets around the query instead of always using content prefix', async () => {
    const dbDir = join(tempRoot, 'db');
    const dbPath = join(dbDir, 'index.sqlite');
    const db = await openDatabase(dbPath);
    const provider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      provider.fingerprint(baseConfig.index.chunking_version)
    );

    replaceSourceData({
      db,
      sourceKey: 'repo',
      documents: [
        {
          document: {
            sourceKey: 'repo',
            sourceKind: 'local_git',
            sourceLocator: '/repo',
            canonicalLocator: null,
            path: 'src/db/database.ts',
            language: 'ts',
            title: 'database.ts',
            contentHash: 'doc-3',
            content: `${'prefix '.repeat(48)}embedding fingerprint changed requires rebuild before continuing.`,
          },
          chunks: [
            {
              chunkIndex: 0,
              section: 'database.ts',
              content: `${'prefix '.repeat(48)}embedding fingerprint changed requires rebuild before continuing.`,
              tokenEstimate: 90,
              contentHash: 'chunk-3',
            },
          ],
          embedding: [[0, 0, 0, 0]],
        },
      ],
    });

    const searchResult = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'embedding fingerprint changed',
      limit: 5,
      scope: 'project',
      databasePath: dbPath,
    });

    expect(searchResult.results[0]?.snippet).toContain(
      'embedding fingerprint changed'
    );
    expect(searchResult.results[0]?.snippet.startsWith('…')).toBe(true);

    closeDatabase(db);
  });

  test('filters search results by explicit file suffixes', async () => {
    const dbDir = join(tempRoot, 'db');
    const dbPath = join(dbDir, 'index.sqlite');
    const db = await openDatabase(dbPath);
    const provider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      provider.fingerprint(baseConfig.index.chunking_version)
    );

    replaceSourceData({
      db,
      sourceKey: 'repo',
      documents: [
        {
          document: {
            sourceKey: 'repo',
            sourceKind: 'local_git',
            sourceLocator: '/repo',
            canonicalLocator: null,
            path: 'docs/guide.md',
            language: 'md',
            title: 'guide.md',
            contentHash: 'doc-4',
            content: 'vector guide for agents in markdown format',
          },
          chunks: [
            {
              chunkIndex: 0,
              section: 'guide.md',
              content: 'vector guide for agents in markdown format',
              tokenEstimate: 10,
              contentHash: 'chunk-4',
            },
          ],
          embedding: [[10, 0, 0, 10]],
        },
        {
          document: {
            sourceKey: 'repo',
            sourceKind: 'local_git',
            sourceLocator: '/repo',
            canonicalLocator: null,
            path: 'src/guide.ts',
            language: 'ts',
            title: 'guide.ts',
            contentHash: 'doc-5',
            content: 'vector guide for agents in typescript format',
          },
          chunks: [
            {
              chunkIndex: 0,
              section: 'guide.ts',
              content: 'vector guide for agents in typescript format',
              tokenEstimate: 10,
              contentHash: 'chunk-5',
            },
          ],
          embedding: [[10, 0, 0, 10]],
        },
        {
          document: {
            sourceKey: 'repo',
            sourceKind: 'local_git',
            sourceLocator: '/repo',
            canonicalLocator: null,
            path: 'src/native/main.c',
            language: 'c',
            title: 'main.c',
            contentHash: 'doc-6',
            content: 'vector guide for agents in native c format',
          },
          chunks: [
            {
              chunkIndex: 0,
              section: 'main.c',
              content: 'vector guide for agents in native c format',
              tokenEstimate: 10,
              contentHash: 'chunk-6',
            },
          ],
          embedding: [[10, 0, 0, 10]],
        },
      ],
    });

    const tsOnly = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'vector guide',
      extensions: ['ts'],
      limit: 5,
      scope: 'project',
      databasePath: dbPath,
    });
    const mixed = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'vector guide',
      extensions: ['md', '.ts'],
      limit: 5,
      scope: 'project',
      databasePath: dbPath,
    });
    const cOnly = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'vector guide',
      extensions: ['c'],
      limit: 5,
      scope: 'project',
      databasePath: dbPath,
    });

    expect(tsOnly.extensions).toEqual(['.ts']);
    expect(tsOnly.results.map((item) => item.path)).toEqual(['src/guide.ts']);
    expect(mixed.extensions).toEqual(['.md', '.ts']);
    expect(mixed.results.map((item) => item.path).sort()).toEqual([
      'docs/guide.md',
      'src/guide.ts',
    ]);
    expect(cOnly.results.map((item) => item.path)).toEqual([
      'src/native/main.c',
    ]);

    closeDatabase(db);
  });
});
