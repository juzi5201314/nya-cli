import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { learnGitSource } from '../src/core/ingest/learn-git';
import { aiSearchIndex } from '../src/core/search/ai-search';
import {
  closeDatabase,
  initializeEmptyIndex,
  openDatabase,
} from '../src/db/database';
import type {
  EmbeddingFingerprint,
  EmbeddingProvider,
  LlmProvider,
} from '../src/providers/types';
import type { AppConfig } from '../src/types/config';

const tempRoot = '/tmp/nya-cli-ai-search-tests';

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
      normalized.includes('gemini') ? 10 : 0,
      normalized.includes('tavily') ? 10 : 0,
      normalized.includes('agents') ? 10 : 0,
      normalized.includes('search') ? 10 : 0,
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

class FakeLlmProvider implements LlmProvider {
  readonly id = 'google' as const;
  readonly model = 'fake-llm';

  async generateText(): Promise<{ text: string }> {
    return {
      text: 'unused',
    };
  }

  async generateObject<T>(args: { schemaName?: string }): Promise<T> {
    if (args.schemaName === 'ai_search_planner') {
      return {
        enough: false,
        rationale: 'Need queries',
        queries: ['gemini tavily agents', 'local search'],
      } as T;
    }

    return {
      answer: '本地知识库显示 Gemini 和 Tavily 被用于 agent 搜索。',
      citationIds: [1, 2],
    } as T;
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

describe('ai-search', () => {
  test('uses multi-query retrieval and returns grounded citations', async () => {
    const repoDir = join(tempRoot, 'repo');
    const dbDir = join(tempRoot, 'db');
    await mkdir(repoDir, { recursive: true });

    await writeFile(
      join(repoDir, 'README.md'),
      '# Search\n\nGemini and Tavily are used to help agents search knowledge.\n'
    );
    await writeFile(
      join(repoDir, 'guide.md'),
      '# Guide\n\nLocal search retrieves evidence for agents.\n'
    );

    await runGit(repoDir, ['init']);
    await runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    await runGit(repoDir, ['config', 'user.name', 'Test User']);
    await runGit(repoDir, ['add', '.']);
    await runGit(repoDir, ['commit', '-m', 'initial']);

    const db = await openDatabase(join(dbDir, 'index.sqlite'));
    const embeddingProvider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
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
      embeddingProvider,
      rebuildTriggered: false,
      rebuildReason: null,
    });

    const result = await aiSearchIndex({
      db,
      embeddingProvider,
      llmProvider: new FakeLlmProvider(),
      query: 'Gemini 和 Tavily 如何用于 agent 搜索？',
      limit: 5,
      scope: 'project',
      databasePath: join(dbDir, 'index.sqlite'),
      maxSteps: 2,
      maxQueriesPerStep: 2,
      maxEvidenceChunks: 5,
    });

    expect(result.usedQueries.length).toBeGreaterThan(0);
    expect(result.answer).toContain('Gemini');
    expect(result.citations.length).toBeGreaterThan(0);
    closeDatabase(db);
  });
});
