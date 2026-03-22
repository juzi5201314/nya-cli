import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { learnGitSource } from '../src/core/ingest/learn-git';
import {
  closeDatabase,
  initializeEmptyIndex,
  openDatabase,
  openReadonlyDatabase,
} from '../src/db/database';
import type {
  EmbeddingFingerprint,
  EmbeddingProvider,
} from '../src/providers/types';
import type { AppConfig } from '../src/types/config';

const tempRoot = '/tmp/nya-cli-db-doctor-tests';
const cliEntry = '/root/projects/nya2/src/index.ts';

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
      provider: 'crawl4ai',
      providers: {
        crawl4ai: {
          command: 'crwl',
          default_fetch_mode: 'auto',
          default_crawl: false,
          default_max_pages: 25,
          default_max_depth: 2,
          min_markdown_chars: 40,
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
      normalized.includes('doctor') ? 10 : 0,
      normalized.includes('health') ? 10 : 0,
      normalized.includes('rebuild') ? 10 : 0,
      normalized.includes('sqlite') ? 10 : 0,
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

async function runCli(cwd: string, args: string[]) {
  const proc = Bun.spawn(['bun', 'run', cliEntry, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    stdout,
    stderr,
    exitCode,
  };
}

function expectNoSidecars(files: Array<{ path: string; exists: boolean }>) {
  for (const sidecar of files.slice(1)) {
    expect(sidecar.exists).toBe(false);
  }
}

function snapshotFiles(databasePath: string) {
  const filePaths = [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ];

  return Promise.all(
    filePaths.map(async (filePath) => {
      if (!existsSync(filePath)) {
        return {
          path: filePath,
          exists: false,
        };
      }

      const bytes = await readFile(filePath);
      return {
        path: filePath,
        exists: true,
        size: bytes.length,
        hash: createHash('sha256').update(bytes).digest('hex'),
      };
    })
  );
}

function createMinimalDoctorDb(args: {
  databasePath: string;
  includeIndexMetadata: boolean;
  includeSearchTables: boolean;
}): void {
  const db = new Database(args.databasePath, {
    create: true,
    strict: true,
    safeIntegers: true,
  });

  db.run(`
    CREATE TABLE source_manifests (
      source_key TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      root_locator TEXT NOT NULL,
      display_locator TEXT NOT NULL,
      reingest_payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_ingested_at TEXT NOT NULL,
      last_rebuild_status TEXT NOT NULL,
      last_rebuild_error TEXT,
      last_rebuild_attempts INTEGER NOT NULL,
      last_rebuild_at TEXT,
      last_rebuild_success_at TEXT
    );
  `);

  if (args.includeIndexMetadata) {
    db.run(`
      CREATE TABLE index_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO index_metadata(key, value, updated_at)
      VALUES (
        'embedding_fingerprint',
        '{"provider":"google","model":"fixture-model","dimensions":4,"taskType":"RETRIEVAL_DOCUMENT","chunkingVersion":"v1","chunker":"tree-sitter"}',
        '2026-03-22T00:00:00.000Z'
      );
    `);
  }

  if (args.includeSearchTables) {
    db.run(`
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
        content TEXT NOT NULL,
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

      CREATE TABLE chunk_fts (
        content TEXT NOT NULL,
        path TEXT,
        section TEXT
      );

      CREATE TABLE chunk_vec (
        embedding BLOB
      );
    `);
  }

  db.close(false);
}

beforeEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
});

describe('db doctor', () => {
  test('does not create project database files in an empty directory', async () => {
    const result = await runCli(tempRoot, [
      'db',
      'doctor',
      '--project',
      '--json',
      '--no-tui',
    ]);

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout) as {
      dbExists: boolean;
      healthStatus: string;
      needsRebuild: boolean;
      rebuildReason: string | null;
    };
    expect(json.dbExists).toBe(false);
    expect(json.healthStatus).toBe('missing');
    expect(json.needsRebuild).toBe(true);
    expect(json.rebuildReason).toBe('database missing');
    expect(existsSync(join(tempRoot, '.nya-cli'))).toBe(false);
    expect(existsSync(join(tempRoot, '.nya-cli', 'index.sqlite'))).toBe(false);
  });

  test('is read-only on an existing database and reports health fields', async () => {
    const repoDir = join(tempRoot, 'repo');
    const dbPath = join(tempRoot, '.nya-cli', 'index.sqlite');
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      join(repoDir, 'README.md'),
      '# Doctor\n\nHealth reporting should stay read-only.\n'
    );

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
        databaseDir: join(tempRoot, '.nya-cli'),
        remoteCacheDir: join(tempRoot, 'cache'),
      },
      embeddingProvider: provider,
      rebuildTriggered: false,
      rebuildReason: null,
    });

    db.query('PRAGMA wal_checkpoint(TRUNCATE);').all();

    await closeDatabase(db);
    await Bun.sleep(200);
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });

    const before = await snapshotFiles(dbPath);
    expectNoSidecars(before);

    const readonlyDb = openReadonlyDatabase(dbPath);
    readonlyDb.query('SELECT 1;').get();
    closeDatabase(readonlyDb);

    const result = await runCli(tempRoot, [
      'db',
      'doctor',
      '--project',
      '--json',
      '--no-tui',
    ]);
    await Bun.sleep(200);
    const after = await snapshotFiles(dbPath);
    expectNoSidecars(after);

    expect(result.exitCode).toBe(0);
    expect(after).toEqual(before);

    const json = JSON.parse(result.stdout) as {
      dbExists: boolean;
      healthStatus: string;
      needsRebuild: boolean;
      rebuildReason: string | null;
      failedSourceManifests: number;
    };

    expect(json.dbExists).toBe(true);
    expect(json.healthStatus).toBe('ok');
    expect(json.needsRebuild).toBe(false);
    expect(json.rebuildReason).toBeNull();
    expect(json.failedSourceManifests).toBe(0);
  });

  test('reports degraded health when index metadata is missing from an existing DB', async () => {
    const dbPath = join(tempRoot, '.nya-cli', 'index.sqlite');
    await mkdir(join(tempRoot, '.nya-cli'), { recursive: true });
    createMinimalDoctorDb({
      databasePath: dbPath,
      includeIndexMetadata: false,
      includeSearchTables: true,
    });

    const result = await runCli(tempRoot, [
      'db',
      'doctor',
      '--project',
      '--json',
      '--no-tui',
    ]);

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout) as {
      dbExists: boolean;
      healthStatus: string;
      needsRebuild: boolean;
      rebuildReason: string | null;
      fingerprint: unknown;
      hasFts: boolean;
      hasVector: boolean;
    };

    expect(json.dbExists).toBe(true);
    expect(json.healthStatus).toBe('degraded');
    expect(json.needsRebuild).toBe(true);
    expect(json.rebuildReason).toBe('embedding fingerprint missing');
    expect(json.fingerprint).toBeNull();
    expect(json.hasFts).toBe(true);
    expect(json.hasVector).toBe(true);
  });

  test('reports degraded health when search tables are missing from an existing DB', async () => {
    const dbPath = join(tempRoot, '.nya-cli', 'index.sqlite');
    await mkdir(join(tempRoot, '.nya-cli'), { recursive: true });
    createMinimalDoctorDb({
      databasePath: dbPath,
      includeIndexMetadata: true,
      includeSearchTables: false,
    });

    const result = await runCli(tempRoot, [
      'db',
      'doctor',
      '--project',
      '--json',
      '--no-tui',
    ]);

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout) as {
      dbExists: boolean;
      healthStatus: string;
      needsRebuild: boolean;
      rebuildReason: string | null;
      fingerprint: unknown;
      hasFts: boolean;
      hasVector: boolean;
    };

    expect(json.dbExists).toBe(true);
    expect(json.healthStatus).toBe('degraded');
    expect(json.needsRebuild).toBe(true);
    expect(json.rebuildReason).toBe('index bootstrap required');
    expect(json.fingerprint).not.toBeNull();
    expect(json.hasFts).toBe(false);
    expect(json.hasVector).toBe(false);
  });
});
