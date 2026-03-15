import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { learnGitSource } from '../src/core/ingest/learn-git';
import { searchIndex } from '../src/core/search/search-index';
import {
  closeDatabase,
  initializeEmptyIndex,
  openDatabase,
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
      provider: 'scrapling',
      providers: {
        scrapling: {
          command: 'scrapling',
          default_fetch_mode: 'auto',
          default_crawl: false,
          default_max_pages: 25,
          default_max_depth: 2,
          same_origin_only: true,
          min_markdown_chars: 200,
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
});
