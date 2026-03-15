import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { learnGitSource } from '../src/core/ingest/learn-git';
import { rebuildSourcesFromManifest } from '../src/core/ingest/rebuild-sources';
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
} from '../src/providers/types';
import type { AppConfig } from '../src/types/config';

const tempRoot = '/tmp/nya-cli-rebuild-tests';

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
      normalized.includes('remote') ? 10 : 0,
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
    };
  }
}

const fakeWebIngestProvider = {
  id: 'scrapling' as const,
  async assertAvailable() {},
  async fetchPage() {
    throw new Error('not used in git rebuild tests');
  },
};

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

describe('rebuild and remote git', () => {
  test('rebuilds sources from source manifest', async () => {
    const repoDir = join(tempRoot, 'repo');
    const dbDir = join(tempRoot, 'db');
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      join(repoDir, 'README.md'),
      '# Intro\n\nRemote rebuild keeps git sources searchable.\n'
    );

    await runGit(repoDir, ['init']);
    await runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    await runGit(repoDir, ['config', 'user.name', 'Test User']);
    await runGit(repoDir, ['add', '.']);
    await runGit(repoDir, ['commit', '-m', 'initial']);

    const db = await openDatabase(join(dbDir, 'index.sqlite'));
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
        databasePath: join(dbDir, 'index.sqlite'),
        databaseDir: dbDir,
        remoteCacheDir: join(tempRoot, 'cache'),
      },
      embeddingProvider: provider,
      rebuildTriggered: false,
      rebuildReason: null,
    });

    initializeEmptyIndex(
      db,
      provider.fingerprint(config.index.chunking_version)
    );

    const rebuildResults = await rebuildSourcesFromManifest({
      config,
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
      webIngestProvider: fakeWebIngestProvider,
      sourceKey: undefined,
      retryCount: 0,
      failFast: true,
      failedOnly: false,
    });

    expect(rebuildResults.succeeded.length).toBe(1);
    expect(rebuildResults.failed.length).toBe(0);
    expect(getDbStats(db).documents).toBe(1);
    closeDatabase(db);
  });

  test('refreshes cached remote git urls on repeated learn', async () => {
    const sourceRepo = join(tempRoot, 'source-repo');
    const remoteRepo = join(tempRoot, 'remote.git');
    const dbDir = join(tempRoot, 'db');
    await mkdir(sourceRepo, { recursive: true });
    await writeFile(
      join(sourceRepo, 'README.md'),
      '# Remote\n\nFirst remote version.\n'
    );

    await runGit(sourceRepo, ['init']);
    await runGit(sourceRepo, ['config', 'user.email', 'test@example.com']);
    await runGit(sourceRepo, ['config', 'user.name', 'Test User']);
    await runGit(sourceRepo, ['add', '.']);
    await runGit(sourceRepo, ['commit', '-m', 'initial']);
    await runGit(tempRoot, ['clone', '--bare', sourceRepo, remoteRepo]);

    const db = await openDatabase(join(dbDir, 'index.sqlite'));
    const provider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      provider.fingerprint(config.index.chunking_version)
    );

    await learnGitSource({
      source: `file://${remoteRepo}`,
      config,
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

    await writeFile(
      join(sourceRepo, 'README.md'),
      '# Remote\n\nSecond remote version with vector update.\n'
    );
    await runGit(sourceRepo, ['add', '.']);
    await runGit(sourceRepo, ['commit', '-m', 'update']);
    await runGit(sourceRepo, ['remote', 'add', 'origin', remoteRepo]);
    await runGit(sourceRepo, ['push', '--force', 'origin', 'HEAD:master']);

    const second = await learnGitSource({
      source: `file://${remoteRepo}`,
      config,
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

    expect(second.documentsIndexed).toBe(1);
    closeDatabase(db);
  });

  test('retries failed sources and reports them when they still fail', async () => {
    const db = await openDatabase(join(tempRoot, 'failed.sqlite'));
    const provider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      provider.fingerprint(config.index.chunking_version)
    );

    const missingPath = join(tempRoot, 'missing-repo');
    await learnGitSource({
      source: missingPath,
      config,
      db,
      scope: 'project',
      scopePaths: {
        scope: 'project',
        projectDirName: '.nya-cli',
        databasePath: join(tempRoot, 'failed.sqlite'),
        databaseDir: tempRoot,
        remoteCacheDir: join(tempRoot, 'cache'),
      },
      embeddingProvider: provider,
      rebuildTriggered: false,
      rebuildReason: null,
      recordManifest: false,
    }).catch(() => {});

    db.query(
      `
        INSERT INTO source_manifests(
          source_key,
          source_kind,
          provider,
          root_locator,
          display_locator,
        reingest_payload_json,
        created_at,
        updated_at,
        last_ingested_at,
        last_rebuild_status,
        last_rebuild_error,
        last_rebuild_attempts,
        last_rebuild_at,
        last_rebuild_success_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
      `
    ).run(
      missingPath,
      'local_git',
      'git-local',
      missingPath,
      missingPath,
      JSON.stringify({ kind: 'git', source: missingPath }),
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
      'idle',
      null,
      0,
      null,
      null
    );

    const summary = await rebuildSourcesFromManifest({
      config,
      db,
      scope: 'project',
      scopePaths: {
        scope: 'project',
        projectDirName: '.nya-cli',
        databasePath: join(tempRoot, 'failed.sqlite'),
        databaseDir: tempRoot,
        remoteCacheDir: join(tempRoot, 'cache'),
      },
      embeddingProvider: provider,
      webIngestProvider: fakeWebIngestProvider,
      sourceKey: undefined,
      retryCount: 2,
      failFast: false,
      failedOnly: false,
    });

    expect(summary.succeeded.length).toBe(0);
    expect(summary.failed.length).toBe(1);
    expect(summary.failed[0]?.attempts).toBe(3);
    expect(listSourceManifests(db)[0]?.lastRebuildStatus).toBe('failed');
    closeDatabase(db);
  });

  test('failed-only rebuild only retries failed sources and preserves successful data', async () => {
    const goodRepo = join(tempRoot, 'good-repo');
    const dbPath = join(tempRoot, 'failed-only.sqlite');
    await mkdir(goodRepo, { recursive: true });
    await writeFile(
      join(goodRepo, 'README.md'),
      '# Good\n\nSuccessful source remains indexed.\n'
    );

    await runGit(goodRepo, ['init']);
    await runGit(goodRepo, ['config', 'user.email', 'test@example.com']);
    await runGit(goodRepo, ['config', 'user.name', 'Test User']);
    await runGit(goodRepo, ['add', '.']);
    await runGit(goodRepo, ['commit', '-m', 'good']);

    const db = await openDatabase(dbPath);
    const provider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      provider.fingerprint(config.index.chunking_version)
    );

    await learnGitSource({
      source: goodRepo,
      config,
      db,
      scope: 'project',
      scopePaths: {
        scope: 'project',
        projectDirName: '.nya-cli',
        databasePath: dbPath,
        databaseDir: tempRoot,
        remoteCacheDir: join(tempRoot, 'cache'),
      },
      embeddingProvider: provider,
      rebuildTriggered: false,
      rebuildReason: null,
    });

    const missingPath = join(tempRoot, 'retry-missing');
    db.query(
      `
        INSERT INTO source_manifests(
          source_key,
          source_kind,
          provider,
          root_locator,
          display_locator,
          reingest_payload_json,
          created_at,
          updated_at,
          last_ingested_at,
          last_rebuild_status,
          last_rebuild_error,
          last_rebuild_attempts,
          last_rebuild_at,
          last_rebuild_success_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
      `
    ).run(
      missingPath,
      'local_git',
      'git-local',
      missingPath,
      missingPath,
      JSON.stringify({ kind: 'git', source: missingPath }),
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
      'failed',
      'previous failure',
      1,
      new Date().toISOString(),
      null
    );

    await mkdir(missingPath, { recursive: true });
    await writeFile(
      join(missingPath, 'README.md'),
      '# Fixed\n\nRecovered failed source.\n'
    );
    await runGit(missingPath, ['init']);
    await runGit(missingPath, ['config', 'user.email', 'test@example.com']);
    await runGit(missingPath, ['config', 'user.name', 'Test User']);
    await runGit(missingPath, ['add', '.']);
    await runGit(missingPath, ['commit', '-m', 'fixed']);

    const summary = await rebuildSourcesFromManifest({
      config,
      db,
      scope: 'project',
      scopePaths: {
        scope: 'project',
        projectDirName: '.nya-cli',
        databasePath: dbPath,
        databaseDir: tempRoot,
        remoteCacheDir: join(tempRoot, 'cache'),
      },
      embeddingProvider: provider,
      webIngestProvider: fakeWebIngestProvider,
      sourceKey: undefined,
      retryCount: 1,
      failFast: false,
      failedOnly: true,
    });

    expect(summary.succeeded.length).toBe(1);
    expect(summary.failed.length).toBe(0);
    expect(getDbStats(db).documents).toBe(2);

    const manifests = listSourceManifests(db);
    const goodManifest = manifests.find((item) => item.sourceKey === goodRepo);
    const fixedManifest = manifests.find(
      (item) => item.sourceKey === missingPath
    );
    expect(goodManifest?.lastRebuildStatus).toBe('idle');
    expect(fixedManifest?.lastRebuildStatus).toBe('success');
    closeDatabase(db);
  });
});
