import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { learnGitSource } from '../src/core/ingest/learn-git';
import { searchIndex } from '../src/core/search/search-index';
import {
  closeDatabase,
  findDocumentsByPath,
  getDocumentById,
  initializeEmptyIndex,
  openDatabase,
} from '../src/db/database';
import type {
  EmbeddingFingerprint,
  EmbeddingProvider,
} from '../src/providers/types';
import type { AppConfig } from '../src/types/config';

const tempRoot = '/tmp/nya-cli-get-tests';

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
          default_max_pages: 25,
          default_max_depth: 2,
          same_origin_only: true,
          min_markdown_chars: 40,
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
          default_max_pages: 25,
          default_max_depth: 2,
          min_markdown_chars: 40,
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
    chunk_size: 80,
    chunk_overlap: 12,
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
      normalized.includes('get') ? 10 : 0,
      normalized.includes('search') ? 10 : 0,
      normalized.includes('document') ? 10 : 0,
      normalized.includes('content') ? 10 : 0,
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

describe('get document', () => {
  test('returns full document content by path and document id', async () => {
    const repoDir = join(tempRoot, 'repo');
    const dbDir = join(tempRoot, 'db');
    const dbPath = join(dbDir, 'index.sqlite');
    await mkdir(repoDir, { recursive: true });

    const readmeContent = [
      '# Get',
      '',
      'The get command should return the full document content.',
      'It must not be limited to a snippet.',
    ].join('\n');

    await writeFile(join(repoDir, 'README.md'), readmeContent);
    await runGit(repoDir, ['init']);
    await runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    await runGit(repoDir, ['config', 'user.name', 'Test User']);
    await runGit(repoDir, ['add', '.']);
    await runGit(repoDir, ['commit', '-m', 'initial']);

    const db = await openDatabase(dbPath);
    const provider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      provider.fingerprint(config.index.chunking_version)
    );

    await learnGitSource({
      source: repoDir,
      config,
      db,
      scope: 'project',
      scopePaths: {
        scope: 'project',
        projectDirName: '.nya-cli',
        databasePath: dbPath,
        databaseDir: dbDir,
        remoteCacheDir: join(tempRoot, 'cache'),
      },
      embeddingProvider: provider,
      rebuildTriggered: false,
      rebuildReason: null,
    });

    const searchResult = await searchIndex({
      db,
      embeddingProvider: provider,
      query: 'get document content',
      limit: 5,
      scope: 'project',
      databasePath: dbPath,
    });
    const documentId = searchResult.results[0]?.documentId;

    expect(documentId).toBeDefined();
    expect(searchResult.results[0]?.sourceKey).toBe(repoDir);

    const byId = getDocumentById(db, documentId ?? 0);
    expect(byId?.content).toBe(readmeContent);

    const byPath = findDocumentsByPath(db, './README.md');
    expect(byPath).toHaveLength(1);
    expect(byPath[0]?.content).toBe(readmeContent);

    closeDatabase(db);
  });

  test('cli get returns full project document json', async () => {
    const projectDir = join(tempRoot, 'project');
    const dbDir = join(projectDir, '.nya-cli');
    const dbPath = join(dbDir, 'index.sqlite');
    await mkdir(projectDir, { recursive: true });

    const sourceContent = [
      'export function loadFullDocument() {',
      '  return "full content";',
      '}',
    ].join('\n');

    await writeFile(join(projectDir, 'guide.ts'), sourceContent);
    await runGit(projectDir, ['init']);
    await runGit(projectDir, ['config', 'user.email', 'test@example.com']);
    await runGit(projectDir, ['config', 'user.name', 'Test User']);
    await runGit(projectDir, ['add', '.']);
    await runGit(projectDir, ['commit', '-m', 'initial']);

    const db = await openDatabase(dbPath);
    const provider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      provider.fingerprint(config.index.chunking_version)
    );

    await learnGitSource({
      source: projectDir,
      config,
      db,
      scope: 'project',
      scopePaths: {
        scope: 'project',
        projectDirName: '.nya-cli',
        databasePath: dbPath,
        databaseDir: dbDir,
        remoteCacheDir: join(tempRoot, 'cache'),
      },
      embeddingProvider: provider,
      rebuildTriggered: false,
      rebuildReason: null,
    });
    closeDatabase(db);

    const proc = Bun.spawn(
      [
        'bun',
        'run',
        '/home/soeur/project/nya-cli/src/index.ts',
        'get',
        'guide.ts',
        '--project',
        '--json',
      ],
      {
        cwd: projectDir,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');

    const result = JSON.parse(stdout) as {
      document: { content: string; path: string };
    };
    expect(result.document.path).toBe('guide.ts');
    expect(result.document.content).toBe(sourceContent);
  });

  test('migrates schema v3 and backfills document content', async () => {
    const dbDir = join(tempRoot, 'legacy-db');
    const dbPath = join(dbDir, 'index.sqlite');
    await mkdir(dbDir, { recursive: true });

    const legacyDb = new Database(dbPath, {
      create: true,
      strict: true,
      safeIntegers: true,
    });
    legacyDb.run(`
      CREATE TABLE index_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO index_metadata(key, value, updated_at)
      VALUES ('schema_version', '3', '2026-03-16T00:00:00.000Z');

      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_key TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_locator TEXT NOT NULL,
        canonical_locator TEXT,
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        title TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        section TEXT NOT NULL,
        content TEXT NOT NULL,
        token_estimate INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      INSERT INTO documents(
        source_key,
        source_kind,
        source_locator,
        canonical_locator,
        path,
        language,
        title,
        content_hash,
        created_at
      ) VALUES (
        'legacy-source',
        'local_git',
        '/repo/README.md',
        NULL,
        'README.md',
        'markdown',
        'README.md',
        'hash-doc',
        '2026-03-16T00:00:00.000Z'
      );

      INSERT INTO chunks(
        document_id,
        chunk_index,
        section,
        content,
        token_estimate,
        content_hash,
        created_at
      ) VALUES
        (1, 0, 'README.md', 'Legacy content starts here', 10, 'hash-1', '2026-03-16T00:00:00.000Z'),
        (1, 1, 'README.md', ' starts here and continues there', 10, 'hash-2', '2026-03-16T00:00:00.000Z');
    `);
    legacyDb.close(false);

    const migratedDb = await openDatabase(dbPath);
    const document = getDocumentById(migratedDb, 1);

    expect(document?.content).toBe(
      'Legacy content starts here and continues there'
    );

    closeDatabase(migratedDb);
  });
});
