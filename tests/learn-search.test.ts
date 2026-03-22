import type { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chunkTextDocument } from '../src/core/chunking/chunk-text';
import { learnGitSource } from '../src/core/ingest/learn-git';
import {
  normalizeSearchExtensions,
  searchIndex,
} from '../src/core/search/search-index';
import {
  closeDatabase,
  initializeEmptyIndex,
  openDatabase,
  replaceSourceData,
  searchFts,
  searchVector,
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

class TieEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'google' as const;
  readonly model = 'tie-provider';
  readonly dimensions = 2;

  private encode(value: string): number[] {
    const normalized = value.toLowerCase();
    if (normalized.includes('vec1')) {
      return [10, 0];
    }

    if (normalized.includes('vec2')) {
      return [0, 10];
    }

    return [10, 0];
  }

  async embedDocuments(values: string[]): Promise<number[][]> {
    return values.map((value) => this.encode(value));
  }

  async embedQuery(): Promise<number[]> {
    return [10, 0];
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

function seedTiedSearchRows(args: {
  db: Database;
  documentId: number;
  chunkId: number;
  path: string;
  content: string;
  section: string;
  embedding: number[];
}): void {
  const insertDocument = args.db.prepare(`
    INSERT INTO documents(
      id,
      source_key,
      source_kind,
      source_locator,
      canonical_locator,
      path,
      language,
      title,
      content_hash,
      content,
      created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
  `);
  const insertChunk = args.db.prepare(`
    INSERT INTO chunks(
      id,
      document_id,
      chunk_index,
      section,
      content,
      token_estimate,
      content_hash,
      created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  `);
  const insertFts = args.db.prepare(
    'INSERT INTO chunk_fts(rowid, content, path, section) VALUES (?1, ?2, ?3, ?4)'
  );
  const insertVec = args.db.prepare(
    'INSERT INTO chunk_vec(rowid, embedding) VALUES (?1, ?2)'
  );

  const createdAt = '2026-03-22T00:00:00.000Z';
  const sourceLocator = '/repo';
  const title = args.path.split('/').pop() ?? args.path;

  insertDocument.run(
    args.documentId,
    'repo',
    'local_git',
    sourceLocator,
    null,
    args.path,
    'md',
    title,
    `doc-${args.documentId}`,
    args.content,
    createdAt
  );
  insertChunk.run(
    args.chunkId,
    args.documentId,
    0,
    args.section,
    args.content,
    10,
    `chunk-${args.chunkId}`,
    createdAt
  );
  insertFts.run(args.chunkId, args.content, args.path, args.section);
  insertVec.run(args.chunkId, new Float32Array(args.embedding));
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

  test('anchors snippets around punctuated identifier matches', async () => {
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
            path: 'src/search-index.ts',
            language: 'ts',
            title: 'search-index.ts',
            contentHash: 'doc-snippet-1',
            content: `${'search '.repeat(50)}the search-index.ts helper keeps the indexed symbol near the end.`,
          },
          chunks: [
            {
              chunkIndex: 0,
              section: 'search-index.ts',
              content: `${'search '.repeat(50)}the search-index.ts helper keeps the indexed symbol near the end.`,
              tokenEstimate: 90,
              contentHash: 'chunk-snippet-1',
            },
          ],
          embedding: [[10, 10, 0, 0]],
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

    expect(searchResult.results[0]?.snippet).toContain('search-index.ts');
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

    const allResults = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'vector guide',
      limit: 5,
      scope: 'project',
      databasePath: dbPath,
    });
    const tsOnly = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'vector guide',
      extensions: ['TS'],
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
    const normalized = normalizeSearchExtensions([
      undefined as unknown as string,
      ' TS ',
      '.md',
      'undefined',
      '.undefined',
      ' ',
    ]);

    expect(allResults.extensions).toEqual([]);
    expect(allResults.results.map((item) => item.path).sort()).toEqual([
      'docs/guide.md',
      'src/guide.ts',
      'src/native/main.c',
    ]);
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
    expect(normalized).toEqual(['.ts', '.md']);

    closeDatabase(db);
  });

  test('labels code chunks with symbol names', async () => {
    const chunks = await chunkTextDocument({
      filePath: 'src/example.ts',
      content: [
        'export function firstFeature() {',
        '  const label = "first";',
        '  return label.repeat(2);',
        '}',
        '',
        'export function secondFeature() {',
        '  const label = "second";',
        '  return label.repeat(3);',
        '}',
      ].join('\n'),
      config: baseConfig,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.section)).toEqual([
      'example.ts · firstFeature',
      'example.ts · secondFeature',
    ]);
  });

  test('dedupes shared hits across retrievers and reports hybrid usage', async () => {
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
            contentHash: 'doc-10',
            content: 'vector search for agents and git workflows',
          },
          chunks: [
            {
              chunkIndex: 0,
              section: 'guide.md',
              content: 'vector search for agents and git workflows',
              tokenEstimate: 10,
              contentHash: 'chunk-10',
            },
          ],
          embedding: [[10, 10, 10, 10]],
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
            contentHash: 'doc-11',
            content: 'vector search for agents and git workflows',
          },
          chunks: [
            {
              chunkIndex: 0,
              section: 'guide.ts',
              content: 'vector search for agents and git workflows',
              tokenEstimate: 10,
              contentHash: 'chunk-11',
            },
          ],
          embedding: [[10, 10, 10, 10]],
        },
      ],
    });

    const searchResult = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'vector search',
      limit: 5,
      scope: 'project',
      databasePath: dbPath,
    });

    const chunkIds = searchResult.results.map((item) => item.chunkId);

    expect(new Set(chunkIds).size).toBe(chunkIds.length);
    expect(searchResult.retrieversUsed).toEqual(['vector', 'fts']);
    expect(searchResult.vectorCandidates).toBeGreaterThan(0);
    expect(searchResult.ftsCandidates).toBeGreaterThan(0);
    expect(searchResult.rrfUsed).toBe(true);

    closeDatabase(db);
  });

  test('oversamples to avoid underfill after extension filtering', async () => {
    const dbDir = join(tempRoot, 'db');
    const dbPath = join(dbDir, 'index.sqlite');
    const db = await openDatabase(dbPath);
    const provider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      provider.fingerprint(baseConfig.index.chunking_version)
    );

    const documents = [] as Array<{
      document: {
        sourceKey: string;
        sourceKind: 'local_git';
        sourceLocator: string;
        canonicalLocator: null;
        path: string;
        language: string;
        title: string;
        contentHash: string;
        content: string;
      };
      chunks: Array<{
        chunkIndex: number;
        section: string;
        content: string;
        tokenEstimate: number;
        contentHash: string;
      }>;
      embedding: number[][];
    }>;

    for (let index = 0; index < 30; index += 1) {
      const path = `docs/overflow-${String(index).padStart(2, '0')}.md`;
      const content = `vector search md document ${index}`;
      documents.push({
        document: {
          sourceKey: 'repo',
          sourceKind: 'local_git',
          sourceLocator: '/repo',
          canonicalLocator: null,
          path,
          language: 'md',
          title: `overflow-${index}.md`,
          contentHash: `doc-md-${index}`,
          content,
        },
        chunks: [
          {
            chunkIndex: 0,
            section: `overflow-${index}.md`,
            content,
            tokenEstimate: 10,
            contentHash: `chunk-md-${index}`,
          },
        ],
        embedding: [[10, 10, 0, 0]],
      });
    }

    for (let index = 0; index < 8; index += 1) {
      const path = `src/match-${String(index).padStart(2, '0')}.ts`;
      const content = `vector search ts document ${index}`;
      documents.push({
        document: {
          sourceKey: 'repo',
          sourceKind: 'local_git',
          sourceLocator: '/repo',
          canonicalLocator: null,
          path,
          language: 'ts',
          title: `match-${index}.ts`,
          contentHash: `doc-ts-${index}`,
          content,
        },
        chunks: [
          {
            chunkIndex: 0,
            section: `match-${index}.ts`,
            content,
            tokenEstimate: 10,
            contentHash: `chunk-ts-${index}`,
          },
        ],
        embedding: [[10, 10, 0, 0]],
      });
    }

    replaceSourceData({
      db,
      sourceKey: 'repo',
      documents,
    });

    const searchResult = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'vector search',
      extensions: ['ts'],
      limit: 5,
      scope: 'project',
      databasePath: dbPath,
    });

    expect(searchResult.results).toHaveLength(5);
    expect(
      searchResult.results.every((item) => item.path.endsWith('.ts'))
    ).toBe(true);
    expect(searchResult.retrieversUsed).toEqual(['vector', 'fts']);
    expect(searchResult.vectorCandidates).toBeGreaterThan(0);
    expect(searchResult.ftsCandidates).toBeGreaterThan(0);
    expect(searchResult.rrfUsed).toBe(true);

    closeDatabase(db);
  });

  test('uses deterministic tie-break ordering when scores are effectively tied', async () => {
    const dbDir = join(tempRoot, 'db');
    const dbPath = join(dbDir, 'index.sqlite');
    const db = await openDatabase(dbPath);
    const provider = new TieEmbeddingProvider();
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
            path: 'docs/two.md',
            language: 'md',
            title: 'two.md',
            contentHash: 'doc-20',
            content: 'alpha alpha alpha vec2',
          },
          chunks: [
            {
              chunkIndex: 0,
              section: 'two.md',
              content: 'alpha alpha alpha vec2',
              tokenEstimate: 10,
              contentHash: 'chunk-20',
            },
          ],
          embedding: [[0, 10]],
        },
        {
          document: {
            sourceKey: 'repo',
            sourceKind: 'local_git',
            sourceLocator: '/repo',
            canonicalLocator: null,
            path: 'docs/one.md',
            language: 'md',
            title: 'one.md',
            contentHash: 'doc-21',
            content: 'alpha vec1',
          },
          chunks: [
            {
              chunkIndex: 0,
              section: 'one.md',
              content: 'alpha vec1',
              tokenEstimate: 10,
              contentHash: 'chunk-21',
            },
          ],
          embedding: [[10, 0]],
        },
      ],
    });

    const firstRun = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'alpha',
      limit: 2,
      scope: 'project',
      databasePath: dbPath,
    });

    const secondRun = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'alpha',
      limit: 2,
      scope: 'project',
      databasePath: dbPath,
    });

    expect(firstRun.results.map((item) => item.path)).toEqual([
      'docs/two.md',
      'docs/one.md',
    ]);
    expect(secondRun.results.map((item) => item.path)).toEqual([
      'docs/two.md',
      'docs/one.md',
    ]);
    expect(firstRun.results[0]?.score).toBeCloseTo(
      firstRun.results[1]?.score ?? 0,
      12
    );
    expect(firstRun.results[0]?.documentId).toBeLessThan(
      firstRun.results[1]?.documentId ?? 0
    );

    closeDatabase(db);
  });

  test('vector retriever orders tied distances by chunk id', async () => {
    const dbDir = join(tempRoot, 'db');
    const db = await openDatabase(join(dbDir, 'index.sqlite'));
    initializeEmptyIndex(
      db,
      new TieEmbeddingProvider().fingerprint(baseConfig.index.chunking_version)
    );

    seedTiedSearchRows({
      db,
      documentId: 200,
      chunkId: 200,
      path: 'docs/later.md',
      section: 'later.md',
      content: 'vector tie alpha',
      embedding: [10, 0],
    });
    seedTiedSearchRows({
      db,
      documentId: 100,
      chunkId: 100,
      path: 'docs/earlier.md',
      section: 'earlier.md',
      content: 'vector tie beta',
      embedding: [10, 0],
    });

    const firstRun = searchVector(db, [10, 0], 10);
    const secondRun = searchVector(db, [10, 0], 10);

    expect(firstRun.map((row) => row.chunkId)).toEqual([100, 200]);
    expect(secondRun.map((row) => row.chunkId)).toEqual([100, 200]);

    closeDatabase(db);
  });

  test('fts retriever orders tied bm25 scores by chunk id', async () => {
    const dbDir = join(tempRoot, 'db');
    const db = await openDatabase(join(dbDir, 'index.sqlite'));
    initializeEmptyIndex(
      db,
      new FakeEmbeddingProvider().fingerprint(baseConfig.index.chunking_version)
    );

    seedTiedSearchRows({
      db,
      documentId: 200,
      chunkId: 200,
      path: 'docs/later.md',
      section: 'later.md',
      content: 'alpha beta gamma',
      embedding: [0, 0, 0, 0],
    });
    seedTiedSearchRows({
      db,
      documentId: 100,
      chunkId: 100,
      path: 'docs/earlier.md',
      section: 'earlier.md',
      content: 'alpha beta gamma',
      embedding: [0, 0, 0, 0],
    });

    const firstRun = searchFts(db, 'alpha beta', 10);
    const secondRun = searchFts(db, 'alpha beta', 10);

    expect(firstRun.map((row) => row.chunkId)).toEqual([100, 200]);
    expect(secondRun.map((row) => row.chunkId)).toEqual([100, 200]);

    closeDatabase(db);
  });

  test('orders fallback matches by relevance instead of insertion order', async () => {
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
            path: 'docs/early.md',
            language: 'md',
            title: 'early.md',
            contentHash: 'doc-early',
            content: 'alpha something else beta',
          },
          chunks: [
            {
              chunkIndex: 0,
              section: 'early.md',
              content: 'alpha something else beta',
              tokenEstimate: 10,
              contentHash: 'chunk-early',
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
            path: 'docs/later.md',
            language: 'md',
            title: 'later.md',
            contentHash: 'doc-later',
            content: 'alpha beta details are here',
          },
          chunks: [
            {
              chunkIndex: 0,
              section: 'later.md',
              content: 'alpha beta details are here',
              tokenEstimate: 10,
              contentHash: 'chunk-later',
            },
          ],
          embedding: [[0, 0, 0, 0]],
        },
      ],
    });

    const searchResult = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'alpha beta',
      limit: 2,
      scope: 'project',
      databasePath: dbPath,
    });

    expect(searchResult.results.map((item) => item.path)).toEqual([
      'docs/later.md',
      'docs/early.md',
    ]);

    closeDatabase(db);
  });

  test('skips tracked symlinks and keeps outside marker text out of search', async () => {
    const repoDir = join(tempRoot, 'fixture-repo');
    const dbDir = join(tempRoot, 'fixture-db');
    const outsideFile = join(tempRoot, 'outside.txt');
    const escapeMarker = 'ZXQJXQJXQJ_98765';
    const searchOnlyConfig: AppConfig = {
      ...baseConfig,
      index: {
        ...baseConfig.index,
        vector: false,
        fts: false,
      },
    };

    await mkdir(repoDir, { recursive: true });
    await writeFile(
      outsideFile,
      `This file lives outside the repo and contains ${escapeMarker}.\n`
    );
    await writeFile(
      join(repoDir, 'README.md'),
      '# Symlink\n\nThis repository still has normal searchable content.\n'
    );
    await symlink(outsideFile, join(repoDir, 'escape.txt'));

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
      config: searchOnlyConfig,
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

    db.run('DROP TABLE IF EXISTS chunk_vec');

    const searchResult = await searchIndex({
      db,
      embeddingProvider: provider,
      query: escapeMarker,
      limit: 5,
      scope: 'project',
      databasePath: join(dbDir, 'index.sqlite'),
    });

    expect(learnResult.documentsIndexed).toBe(1);
    expect(learnResult.skippedSymlinks).toBe(1);
    expect(searchResult.results).toHaveLength(0);

    closeDatabase(db);
  });
});
