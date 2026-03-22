import { beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { learnGitSource } from '../src/core/ingest/learn-git';
import {
  closeDatabase,
  findDocumentsByPath,
  getDbStats,
  initializeEmptyIndex,
  openDatabase,
} from '../src/db/database';
import type {
  EmbeddingFingerprint,
  EmbeddingProvider,
} from '../src/providers/types';
import type { AppConfig } from '../src/types/config';

const tempRoot = '/tmp/nya-cli-learn-git-hardening-tests';

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
          min_markdown_chars: 120,
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
          min_markdown_chars: 120,
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
      normalized.includes('tracked-token') ||
      normalized.includes('alpha123tracked')
        ? 10
        : 0,
      normalized.includes('deleted-token') ||
      normalized.includes('beta456deleted')
        ? 10
        : 0,
      normalized.includes('untracked-token') ||
      normalized.includes('gamma789untracked')
        ? 10
        : 0,
      normalized.includes('timeout-token') ? 10 : 0,
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

async function runBunScript(args: {
  scriptPath: string;
  env?: Record<string, string>;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', args.scriptPath], {
    cwd: tempRoot,
    env: {
      ...(process.env as Record<string, string>),
      ...(args.env ?? {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

beforeEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
});

describe('learn git hardening', () => {
  test('repeated learns replace source data and deleted files disappear', async () => {
    const repoDir = join(tempRoot, 'repo');
    const dbDir = join(tempRoot, 'db');
    const dbPath = join(dbDir, 'index.sqlite');
    await mkdir(repoDir, { recursive: true });

    await writeFile(
      join(repoDir, 'README.md'),
      '# Alpha\n\nThis file carries alpha123tracked for stable indexing.\n'
    );
    await writeFile(
      join(repoDir, 'guide.ts'),
      'export const deletedMarker = "beta456deleted for removal";\n'
    );

    await runGit(repoDir, ['init']);
    await runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    await runGit(repoDir, ['config', 'user.name', 'Test User']);
    await runGit(repoDir, ['add', '.']);
    await runGit(repoDir, ['commit', '-m', 'initial']);

    const db = await openDatabase(dbPath);
    try {
      const provider = new FakeEmbeddingProvider();
      initializeEmptyIndex(
        db,
        provider.fingerprint(baseConfig.index.chunking_version)
      );

      const first = await learnGitSource({
        source: repoDir,
        config: baseConfig,
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

      const second = await learnGitSource({
        source: repoDir,
        config: baseConfig,
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

      expect(first.documentsIndexed).toBe(2);
      expect(second.documentsIndexed).toBe(2);
      expect(getDbStats(db).documents).toBe(2);

      await runGit(repoDir, ['rm', 'guide.ts']);

      const third = await learnGitSource({
        source: repoDir,
        config: baseConfig,
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

      expect(third.documentsIndexed).toBe(1);
      expect(getDbStats(db).documents).toBe(1);
      expect(findDocumentsByPath(db, 'guide.ts', repoDir)).toHaveLength(0);
      expect(findDocumentsByPath(db, 'README.md', repoDir)).toHaveLength(1);
    } finally {
      closeDatabase(db);
    }
  });

  test('untracked files are not indexed', async () => {
    const repoDir = join(tempRoot, 'repo');
    const dbDir = join(tempRoot, 'db');
    const dbPath = join(dbDir, 'index.sqlite');
    await mkdir(repoDir, { recursive: true });

    await writeFile(
      join(repoDir, 'tracked.md'),
      '# Tracked\n\ntracked-token should be searchable.\n'
    );
    await writeFile(
      join(repoDir, 'untracked.md'),
      '# Untracked\n\ngamma789untracked must never be indexed.\n'
    );

    await runGit(repoDir, ['init']);
    await runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    await runGit(repoDir, ['config', 'user.name', 'Test User']);
    await runGit(repoDir, ['add', 'tracked.md']);
    await runGit(repoDir, ['commit', '-m', 'initial']);

    const db = await openDatabase(dbPath);
    try {
      const provider = new FakeEmbeddingProvider();
      initializeEmptyIndex(
        db,
        provider.fingerprint(baseConfig.index.chunking_version)
      );

      const result = await learnGitSource({
        source: repoDir,
        config: baseConfig,
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

      expect(result.documentsIndexed).toBe(1);
      expect(findDocumentsByPath(db, 'tracked.md', repoDir)).toHaveLength(1);
      expect(findDocumentsByPath(db, 'untracked.md', repoDir)).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  test('records skipped files and file failures in structured learn output', async () => {
    const repoDir = join(tempRoot, 'fixture-repo');
    const dbDir = join(tempRoot, 'db');
    const dbPath = join(dbDir, 'index.sqlite');
    const fakeGitDir = join(tempRoot, 'fake-git-bin');
    const runnerPath = join(tempRoot, 'partial-failure-runner.ts');
    await mkdir(repoDir, { recursive: true });
    await mkdir(fakeGitDir, { recursive: true });

    await writeFile(
      join(repoDir, 'tracked.md'),
      '# Tracked\n\ntracked-token should still be indexed.\n\nThis fixture has enough text to produce at least one chunk.\nIt should survive skipped and missing tracked files.\n'
    );
    await writeFile(
      join(repoDir, 'ignored.lock'),
      'ignored-token should be skipped.\n'
    );

    await writeFile(
      join(fakeGitDir, 'git'),
      `#!/bin/sh
set -eu
repo_dir=${JSON.stringify(repoDir)}

if [ "${'$'}1" = "-C" ] && [ "${'$'}3" = "rev-parse" ]; then
  printf '%s\n' "${'$'}repo_dir"
  exit 0
fi

if [ "${'$'}1" = "-C" ] && [ "${'$'}3" = "ls-files" ]; then
  python3 - <<'PY'
import sys
sys.stdout.buffer.write(b'tracked.md\\x00ignored.lock\\x00missing.md\\x00')
PY
  exit 0
fi

exit 0
`
    );
    await chmod(join(fakeGitDir, 'git'), 0o755);

    await writeFile(
      runnerPath,
      `import { join } from 'node:path';
import { learnGitSource } from 'file:///root/projects/nya2/src/core/ingest/learn-git.ts';
import { closeDatabase, getDbStats, initializeEmptyIndex, openDatabase } from 'file:///root/projects/nya2/src/db/database.ts';

class FakeEmbeddingProvider {
  id = 'google';
  model = 'fake-google-embedding';
  dimensions = 4;

  fingerprint(chunkingVersion) {
    return {
      provider: 'google',
      model: 'fake-google-embedding',
      dimensions: this.dimensions,
      taskType: 'RETRIEVAL_DOCUMENT',
      chunkingVersion,
      chunker: 'tree-sitter',
    };
  }

  encode(text) {
    const normalized = text.toLowerCase();
    return [
      normalized.includes('tracked-token') ? 10 : 0,
      normalized.includes('missing-token') ? 10 : 0,
      normalized.includes('ignored-token') ? 10 : 0,
      0,
    ];
  }

  async embedDocuments(values) {
    return values.map((value) => this.encode(value));
  }

  async embedQuery(value) {
    return this.encode(value);
  }
}

const repoDir = ${JSON.stringify(repoDir)};
const dbPath = ${JSON.stringify(dbPath)};
const dbDir = ${JSON.stringify(dbDir)};

const config = ${JSON.stringify(baseConfig)};

const db = await openDatabase(dbPath);
const provider = new FakeEmbeddingProvider();
initializeEmptyIndex(db, provider.fingerprint(config.index.chunking_version));

try {
  const result = await learnGitSource({
    source: repoDir,
    config,
    db,
    scope: 'project',
    scopePaths: {
      scope: 'project',
      projectDirName: '.nya-cli',
      databasePath: dbPath,
      databaseDir: dbDir,
      remoteCacheDir: join(${JSON.stringify(tempRoot)}, 'cache'),
    },
    embeddingProvider: provider,
    rebuildTriggered: false,
    rebuildReason: null,
  });

  const stats = getDbStats(db);
  console.log(JSON.stringify({
    ok: true,
    result,
    stats,
  }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    name: error instanceof Error ? error.name : String(error),
    message: error instanceof Error ? error.message : String(error),
  }));
} finally {
  closeDatabase(db);
}
`
    );

    const started = Date.now();
    const output = await runBunScript({
      scriptPath: runnerPath,
      env: {
        PATH: `${fakeGitDir}:${process.env.PATH ?? ''}`,
      },
    });
    const elapsed = Date.now() - started;
    const parsed = JSON.parse(output.stdout.trim()) as {
      ok: boolean;
      result?: {
        documentsIndexed: number;
        skippedFiles: Array<{ reason: string }>;
        fileFailures: Array<{ stage: string; error: string }>;
      };
      stats?: { documents: number };
      name?: string;
      message?: string;
    };

    expect(output.exitCode).toBe(0);
    if (!parsed.ok || !parsed.result || !parsed.stats) {
      throw new Error(
        parsed.message ?? parsed.name ?? 'structured learn output failed'
      );
    }
    expect(parsed.result.documentsIndexed).toBe(1);
    expect(parsed.result.skippedFiles).toHaveLength(1);
    expect(parsed.result.skippedFiles[0]?.reason).toBe('ignored');
    expect(parsed.result.fileFailures).toHaveLength(1);
    expect(parsed.result.fileFailures[0]?.stage).toBe('stat');
    expect(parsed.result.fileFailures[0]?.error).toContain('ENOENT');
    expect(parsed.stats.documents).toBe(1);
    expect(elapsed).toBeLessThan(5000);
  });

  test.skip('hung git subprocesses time out with a clear error', async () => {
    const repoDir = join(tempRoot, 'timeout-repo');
    const dbDir = join(tempRoot, 'timeout-db');
    const dbPath = join(dbDir, 'index.sqlite');
    const fakeGitDir = join(tempRoot, 'timeout-fake-git-bin');
    const runnerPath = join(tempRoot, 'timeout-runner.ts');

    await mkdir(repoDir, { recursive: true });
    await mkdir(fakeGitDir, { recursive: true });

    await writeFile(
      join(fakeGitDir, 'git'),
      `#!/bin/sh
set -eu
/bin/sleep 5
`
    );
    await chmod(join(fakeGitDir, 'git'), 0o755);

    await writeFile(
      runnerPath,
      `import { join } from 'node:path';
import { learnGitSource } from 'file:///root/projects/nya2/src/core/ingest/learn-git.ts';
import { closeDatabase, initializeEmptyIndex, openDatabase } from 'file:///root/projects/nya2/src/db/database.ts';

class FakeEmbeddingProvider {
  id = 'google';
  model = 'fake-google-embedding';
  dimensions = 4;

  fingerprint(chunkingVersion) {
    return {
      provider: 'google',
      model: 'fake-google-embedding',
      dimensions: this.dimensions,
      taskType: 'RETRIEVAL_DOCUMENT',
      chunkingVersion,
      chunker: 'tree-sitter',
    };
  }

  async embedDocuments(values) {
    return values.map(() => [0, 0, 0, 0]);
  }

  async embedQuery() {
    return [0, 0, 0, 0];
  }
}

const config = ${JSON.stringify(baseConfig)};
const repoDir = ${JSON.stringify(repoDir)};
const dbPath = ${JSON.stringify(dbPath)};
const dbDir = ${JSON.stringify(dbDir)};

const db = await openDatabase(dbPath);
const provider = new FakeEmbeddingProvider();
initializeEmptyIndex(db, provider.fingerprint(config.index.chunking_version));

try {
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
      remoteCacheDir: join(${JSON.stringify(tempRoot)}, 'cache'),
    },
    embeddingProvider: provider,
    rebuildTriggered: false,
    rebuildReason: null,
    gitTimeoutMs: 50,
  });
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    name: error instanceof Error ? error.name : String(error),
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' ? error.code ?? null : null,
  }));
} finally {
  closeDatabase(db);
}
`
    );

    const started = Date.now();
    const output = await runBunScript({
      scriptPath: runnerPath,
      env: {
        PATH: `${fakeGitDir}:${process.env.PATH ?? ''}`,
      },
    });
    const elapsed = Date.now() - started;
    const parsed = JSON.parse(output.stdout.trim()) as {
      ok: boolean;
      name: string;
      message: string;
      code: string | null;
    };

    expect(output.exitCode).toBe(0);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('GIT_PROCESS_TIMEOUT');
    expect(parsed.name).toBe('GitProcessTimeoutError');
    expect(parsed.message).toContain('timed out after 50ms');
    expect(elapsed).toBeLessThan(5000);
  });
});
