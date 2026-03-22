import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import { printOutput } from '../src/commands/shared';
import { learnGitSource } from '../src/core/ingest/learn-git';
import { learnWebSource } from '../src/core/ingest/learn-web';
import { aiSearchIndex } from '../src/core/search/ai-search';
import {
  closeDatabase,
  initializeEmptyIndex,
  openDatabase,
  replaceSourceData,
} from '../src/db/database';
import type {
  EmbeddingFingerprint,
  EmbeddingProvider,
  LlmProvider,
  WebFetchedPage,
  WebIngestProvider,
} from '../src/providers/types';
import type { AppConfig } from '../src/types/config';
import { sha256 } from '../src/utils/hash';
import { normalizeLocatorForStorage } from '../src/utils/redaction';

const tempRoot = '/tmp/nya-cli-redaction-tests';

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
          default_max_pages: 10,
          default_max_depth: 1,
          min_markdown_chars: 20,
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
    chunk_size: 160,
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
      normalized.includes('secret') ? 10 : 0,
      normalized.includes('marker') ? 10 : 0,
      normalized.includes('git') ? 10 : 0,
      normalized.includes('web') ? 10 : 0,
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

class FakeWebIngestProvider implements WebIngestProvider {
  readonly id = 'crawl4ai' as const;

  async assertAvailable(): Promise<void> {}

  async fetchPage(url: string): Promise<WebFetchedPage> {
    const finalUrl =
      'https://alice:secret-pass@example.com/docs?token=query-secret-123&foo=1#sig=fragment-secret-456';

    return {
      requestedUrl: url,
      finalUrl,
      title: 'Docs',
      canonicalUrl: finalUrl,
      markdown: 'Secret marker content for redaction tests.',
      html: '<html></html>',
      links: [],
      fetchModeUsed: 'get',
    };
  }
}

class CapturingLlmProvider implements LlmProvider {
  readonly id = 'google' as const;
  readonly model = 'fake-llm';

  public readonly plannerPrompts: string[] = [];
  public readonly answerPrompts: string[] = [];

  async generateText(): Promise<{ text: string }> {
    return { text: 'unused' };
  }

  async generateObject<T>(args: {
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    schemaName?: string;
    schemaDescription?: string;
  }): Promise<T> {
    return (await this.generateObjectWithFallback(args)).object;
  }

  async generateObjectWithFallback<T>(args: {
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    schemaName?: string;
    schemaDescription?: string;
  }): Promise<{
    object: T;
    structuredOutputFallbackUsed: boolean;
  }> {
    if (args.schemaName === 'ai_search_planner') {
      this.plannerPrompts.push(args.prompt);
      return {
        object: {
          enough: false,
          rationale: 'need one more query',
          queries: ['secret marker'],
        } as T,
        structuredOutputFallbackUsed: false,
      };
    }

    this.answerPrompts.push(args.prompt);
    return {
      object: {
        answer: 'grounded answer',
        citationIds: [1],
      } as T,
      structuredOutputFallbackUsed: false,
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

async function readTextTree(root: string): Promise<string> {
  const chunks: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }

      if (entry.isFile()) {
        chunks.push(await readFile(path, 'utf8'));
      }
    }
  }

  await walk(root);
  return chunks.join('\n');
}

async function captureConsoleOutput(fn: () => Promise<void> | void): Promise<{
  stdout: string;
  stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };

  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return {
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
  };
}

beforeEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
});

describe('secret redaction and at-rest hygiene', () => {
  test('printOutput redacts secrets in text and JSON output', async () => {
    const secretUrl =
      'https://alice:very-secret@example.com/path?token=query-secret-123&foo=1#sig=fragment-secret-456';

    const captured = await captureConsoleOutput(() => {
      printOutput(`open ${secretUrl}`, false);
      printOutput({ url: secretUrl, nested: [{ locator: secretUrl }] }, true);
    });

    expect(captured.stdout).not.toContain('very-secret');
    expect(captured.stdout).not.toContain('query-secret-123');
    expect(captured.stdout).not.toContain('fragment-secret-456');
    expect(captured.stdout).toContain('#sig=[REDACTED]');
    expect(captured.stdout).toContain('[REDACTED]');
  });

  test('learn web keeps secret-bearing locators out of SQLite', async () => {
    const dbPath = join(tempRoot, 'web.sqlite');
    const db = await openDatabase(dbPath);
    const embeddingProvider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
    );

    const sourceUrl =
      'https://alice:very-secret@example.com/docs?token=query-secret-123&foo=1#sig=fragment-secret-456';

    const result = await learnWebSource({
      source: sourceUrl,
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
      embeddingProvider,
      webIngestProvider: new FakeWebIngestProvider(),
      rebuildTriggered: false,
      rebuildReason: null,
      crawl: false,
      maxPages: 1,
      maxDepth: 1,
      fetchMode: 'get',
    });

    const output = await captureConsoleOutput(() => printOutput(result, true));
    expect(output.stdout).not.toContain('very-secret');
    expect(output.stdout).not.toContain('query-secret-123');
    expect(output.stdout).not.toContain('fragment-secret-456');
    expect(output.stdout).toContain('[REDACTED]');

    const manifestRows = db
      .query<
        {
          sourceKey: string;
          rootLocator: string;
          displayLocator: string;
          reingestPayloadJson: string;
        },
        []
      >(
        'SELECT source_key AS sourceKey, root_locator AS rootLocator, display_locator AS displayLocator, reingest_payload_json AS reingestPayloadJson FROM source_manifests'
      )
      .all();
    const documentRows = db
      .query<
        {
          sourceKey: string;
          sourceLocator: string;
          canonicalLocator: string | null;
          path: string;
        },
        []
      >(
        'SELECT source_key AS sourceKey, source_locator AS sourceLocator, canonical_locator AS canonicalLocator, path FROM documents'
      )
      .all();

    const manifestText = JSON.stringify(manifestRows);
    const documentText = JSON.stringify(documentRows);

    expect(manifestText).not.toContain('very-secret');
    expect(manifestText).not.toContain('query-secret-123');
    expect(manifestText).not.toContain('fragment-secret-456');
    expect(documentText).not.toContain('very-secret');
    expect(documentText).not.toContain('query-secret-123');
    expect(documentText).not.toContain('fragment-secret-456');

    closeDatabase(db);
  });

  test('learn git redacts remote credentials in outputs, SQLite, and cache config', async () => {
    const sourceRepo = join(tempRoot, 'source-repo');
    const remoteRepo = join(tempRoot, 'remote.git');
    const dbPath = join(tempRoot, 'git.sqlite');
    const cacheDir = join(tempRoot, 'cache');
    await mkdir(sourceRepo, { recursive: true });
    await writeFile(
      join(sourceRepo, 'README.md'),
      '# Remote\n\nSecret marker content for git redaction tests.\n'
    );

    await runGit(sourceRepo, ['init']);
    await runGit(sourceRepo, ['config', 'user.email', 'test@example.com']);
    await runGit(sourceRepo, ['config', 'user.name', 'Test User']);
    await runGit(sourceRepo, ['add', '.']);
    await runGit(sourceRepo, ['commit', '-m', 'initial']);
    await runGit(tempRoot, ['clone', '--bare', sourceRepo, remoteRepo]);

    const db = await openDatabase(dbPath);
    const embeddingProvider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
    );

    const sourceUrl = `file://alice:git-secret@${remoteRepo}`;
    const result = await learnGitSource({
      source: sourceUrl,
      config,
      db,
      scope: 'project',
      scopePaths: {
        scope: 'project',
        projectDirName: '.nya-cli',
        databasePath: dbPath,
        databaseDir: tempRoot,
        remoteCacheDir: cacheDir,
      },
      embeddingProvider,
      rebuildTriggered: false,
      rebuildReason: null,
    });

    const output = await captureConsoleOutput(() => printOutput(result, true));
    expect(output.stdout).not.toContain('git-secret');
    expect(output.stdout).toContain('[REDACTED]');

    const manifestRows = db
      .query<
        {
          sourceKey: string;
          rootLocator: string;
          displayLocator: string;
          reingestPayloadJson: string;
        },
        []
      >(
        'SELECT source_key AS sourceKey, root_locator AS rootLocator, display_locator AS displayLocator, reingest_payload_json AS reingestPayloadJson FROM source_manifests'
      )
      .all();
    const documentRows = db
      .query<
        {
          sourceKey: string;
          sourceLocator: string;
          canonicalLocator: string | null;
          path: string;
        },
        []
      >(
        'SELECT source_key AS sourceKey, source_locator AS sourceLocator, canonical_locator AS canonicalLocator, path FROM documents'
      )
      .all();

    const manifestText = JSON.stringify(manifestRows);
    const documentText = JSON.stringify(documentRows);

    expect(manifestText).not.toContain('git-secret');
    expect(documentText).not.toContain('git-secret');

    const cacheRoot = join(
      cacheDir,
      sha256(normalizeLocatorForStorage(sourceUrl))
    );
    const cacheConfig = await readFile(
      join(cacheRoot, '.git', 'config'),
      'utf8'
    );
    const cacheLogs = await readTextTree(join(cacheRoot, '.git', 'logs'));
    expect(cacheConfig).not.toContain('git-secret');
    expect(cacheLogs).not.toContain('git-secret');
    expect(cacheConfig).toContain('[REDACTED]');

    closeDatabase(db);
  });

  test('ai-search prompts redact secret-bearing queries and evidence', async () => {
    const dbPath = join(tempRoot, 'ai.sqlite');
    const db = await openDatabase(dbPath);
    const embeddingProvider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
    );

    const sourceUrl =
      'https://alice:prompt-secret@example.com/docs?token=prompt-query-secret#sig=prompt-frag-secret';
    replaceSourceData({
      db,
      sourceKey: sourceUrl,
      documents: [
        {
          document: {
            sourceKey: sourceUrl,
            sourceKind: 'web',
            sourceLocator: sourceUrl,
            canonicalLocator: sourceUrl,
            path: sourceUrl,
            language: 'markdown',
            title: 'Docs',
            contentHash: 'hash-doc',
            content: 'Secret marker content for prompt redaction tests.',
          },
          chunks: [
            {
              chunkIndex: 0,
              section: 'Docs',
              content: 'Secret marker content for prompt redaction tests.',
              tokenEstimate: 10,
              contentHash: 'hash-chunk',
            },
          ],
          embedding: [[10, 10, 0, 0]],
        },
      ],
    });

    const llmProvider = new CapturingLlmProvider();
    const query =
      'https://alice:prompt-secret@example.com/docs?token=prompt-query-secret#sig=prompt-frag-secret secret marker';

    const result = await aiSearchIndex({
      db,
      embeddingProvider,
      llmProvider,
      query,
      limit: 4,
      scope: 'project',
      databasePath: dbPath,
      maxSteps: 1,
      maxQueriesPerStep: 1,
      maxEvidenceChunks: 2,
    });

    expect(
      llmProvider.plannerPrompts.some((prompt) =>
        prompt.includes('prompt-secret')
      )
    ).toBe(false);
    expect(
      llmProvider.plannerPrompts.some((prompt) =>
        prompt.includes('prompt-query-secret')
      )
    ).toBe(false);
    expect(
      llmProvider.answerPrompts.some((prompt) =>
        prompt.includes('prompt-secret')
      )
    ).toBe(false);
    expect(
      llmProvider.answerPrompts.some((prompt) =>
        prompt.includes('prompt-query-secret')
      )
    ).toBe(false);
    expect(llmProvider.plannerPrompts.join('\n')).toContain('[REDACTED]');
    expect(llmProvider.answerPrompts.join('\n')).toContain('[REDACTED]');

    const output = await captureConsoleOutput(() => printOutput(result, true));
    expect(output.stdout).not.toContain('prompt-secret');
    expect(output.stdout).not.toContain('prompt-query-secret');
    expect(output.stdout).not.toContain('prompt-frag-secret');
    expect(output.stdout).toContain('[REDACTED]');

    closeDatabase(db);
  });
});
