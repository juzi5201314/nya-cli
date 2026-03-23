import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APICallError } from 'ai';
import { z } from 'zod';

import { renderAiSearchText } from '../src/commands/ai-search';
import { learnGitSource } from '../src/core/ingest/learn-git';
import { aiSearchIndex } from '../src/core/search/ai-search';
import {
  closeDatabase,
  findDocumentsByPath,
  initializeEmptyIndex,
  openDatabase,
} from '../src/db/database';
import { generateObjectWithFallback as generateObjectWithFallbackHelper } from '../src/providers/llm';
import type {
  EmbeddingFingerprint,
  EmbeddingProvider,
  LlmProvider,
} from '../src/providers/types';
import type { AppConfig } from '../src/types/config';

const tempRoot = '/tmp/nya-cli-ai-search-tests';
const cliEntrypoint = join(import.meta.dir, '..', 'src', 'index.ts');

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
      chunker: 'tree-sitter',
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
      return {
        object: {
          enough: false,
          rationale: 'Need queries',
          queries: ['gemini tavily agents', 'local search'],
        } as T,
        structuredOutputFallbackUsed: false,
      };
    }

    return {
      object: {
        answer: '本地知识库显示 Gemini 和 Tavily 被用于 agent 搜索。',
        citationIds: [1, 2],
      } as T,
      structuredOutputFallbackUsed: false,
    };
  }
}

class ScriptedLlmProvider implements LlmProvider {
  readonly id = 'google' as const;
  readonly model = 'fake-llm';

  readonly plannerPrompts: string[] = [];
  readonly answerPrompts: string[] = [];

  private plannerCallCount = 0;
  private answerCallCount = 0;

  constructor(
    private readonly plannerResponses: Array<{
      enough: boolean;
      rationale: string;
      queries: string[];
    }>,
    private readonly answerResponses: Array<{
      answer: string;
      citationIds?: number[];
      citations?: Array<number | { evidenceId: number; quote?: string }>;
    }>,
    private readonly structuredOutputFallbackUsed = false
  ) {}

  async generateText(): Promise<{ text: string }> {
    return {
      text: 'unused',
    };
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
      const response =
        this.plannerResponses[
          Math.min(this.plannerCallCount, this.plannerResponses.length - 1)
        ] ?? this.plannerResponses[this.plannerResponses.length - 1];
      if (!response) {
        throw new Error('plannerResponses must contain at least one response');
      }
      this.plannerCallCount += 1;

      return {
        object: {
          enough: response.enough,
          rationale: response.rationale,
          queries: response.queries,
        } as T,
        structuredOutputFallbackUsed: false,
      };
    }

    this.answerPrompts.push(args.prompt);
    const response =
      this.answerResponses[
        Math.min(this.answerCallCount, this.answerResponses.length - 1)
      ] ?? this.answerResponses[this.answerResponses.length - 1];
    if (!response) {
      throw new Error('answerResponses must contain at least one response');
    }
    this.answerCallCount += 1;
    return {
      object: {
        answer: response.answer,
        citationIds: response.citationIds ?? [],
        citations: response.citations ?? [],
      } as T,
      structuredOutputFallbackUsed: this.structuredOutputFallbackUsed,
    };
  }
}

class TieBreakingEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'google' as const;
  readonly model = 'fake-tie-embedding';
  readonly dimensions = 2;

  private encode(text: string): number[] {
    const normalized = text.toLowerCase();
    return [
      normalized.includes('alpha-only-token') ? 10 : 0,
      normalized.includes('beta-only-token') ? 10 : 0,
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

async function runGetByDocumentId(
  cwd: string,
  documentId: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [
      'bun',
      'run',
      cliEntrypoint,
      'get',
      '--document-id',
      String(documentId),
      '--project',
      '--json',
    ],
    {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

function extractEvidenceBodies(prompt: string): string[] {
  const begin = '<<<BEGIN_UNTRUSTED_EVIDENCE>>>';
  const end = '<<<END_UNTRUSTED_EVIDENCE>>>';
  const bodies: string[] = [];
  let cursor = 0;

  while (cursor < prompt.length) {
    const beginIndex = prompt.indexOf(begin, cursor);
    if (beginIndex < 0) {
      break;
    }

    const contentStart = beginIndex + begin.length;
    const endIndex = prompt.indexOf(end, contentStart);
    if (endIndex < 0) {
      break;
    }

    bodies.push(prompt.slice(contentStart, endIndex));
    cursor = endIndex + end.length;
  }

  return bodies;
}

function stripEvidenceBlocks(prompt: string): string {
  return prompt.replace(
    /<<<BEGIN_UNTRUSTED_EVIDENCE>>>[\s\S]*?<<<END_UNTRUSTED_EVIDENCE>>>/g,
    ''
  );
}

function expectPromptEvidenceToBeHardened(
  prompt: string,
  sentinel: string
): void {
  expect(prompt).toContain('<<<BEGIN_UNTRUSTED_EVIDENCE>>>');
  expect(prompt).toContain('<<<END_UNTRUSTED_EVIDENCE>>>');

  const bodies = extractEvidenceBodies(prompt);
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.some((body) => body.includes(`metadata: {`))).toBe(true);
  expect(
    bodies.some((body) => body.includes('BEGIN_UNTRUSTED_EVID\u200bENCE'))
  ).toBe(true);
  expect(
    bodies.some((body) => body.includes('END_UNTRUSTED_EVID\u200bENCE'))
  ).toBe(true);
  expect(bodies.some((body) => body.includes('BEGIN_UNTRUSTED_EVIDENCE'))).toBe(
    false
  );
  expect(bodies.some((body) => body.includes('END_UNTRUSTED_EVIDENCE'))).toBe(
    false
  );
  expect(bodies.some((body) => body.includes(sentinel))).toBe(true);
  expect(stripEvidenceBlocks(prompt)).not.toContain(sentinel);
}

class FallbackLlmProvider implements LlmProvider {
  readonly id = 'google' as const;
  readonly model = 'fake-llm';

  async generateText(): Promise<{ text: string }> {
    return {
      text: 'unused',
    };
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
      return {
        object: {
          enough: false,
          rationale: 'Need queries',
          queries: ['gemini tavily agents'],
        } as T,
        structuredOutputFallbackUsed: false,
      };
    }

    return {
      object: {
        answer: '本地知识库显示 Gemini 和 Tavily 被用于 agent 搜索。',
        citationIds: [1],
      } as T,
      structuredOutputFallbackUsed: true,
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

describe('ai-search', () => {
  test('renders executable get commands for citations', () => {
    const rendered = renderAiSearchText({
      query: 'question',
      scope: 'project',
      databasePath: '/tmp/index.sqlite',
      answer: 'answer',
      usedQueries: ['query a'],
      iterations: 1,
      citations: [
        {
          evidenceId: 1,
          chunkId: 10,
          documentId: 12,
          sourceKey: '/repo',
          path: 'README.md',
          section: 'Intro',
          snippet: 'snippet',
          excerpt: 'snippet excerpt',
          quote: 'snippet',
          score: 0.9,
          sourceKind: 'local_git',
        },
      ],
      evidence: [
        {
          evidenceId: 1,
          chunkId: 10,
          documentId: 12,
          sourceKey: '/repo',
          path: 'README.md',
          section: 'Intro',
          snippet: 'snippet',
          excerpt: 'snippet excerpt',
          score: 0.9,
          sourceKind: 'local_git',
        },
      ],
      groundingStatus: 'grounded',
      structuredOutputFallbackUsed: false,
    });

    expect(rendered).toContain('[1] doc=12 README.md :: Intro');
    expect(rendered).toContain('get: nya get --document-id 12 --project');
  });

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
    expect(result.citations[0]?.documentId).toBeGreaterThan(0);
    expect(result.citations[0]?.sourceKey).toBe(repoDir);
    expect(result.evidence.some((item) => item.documentId > 0)).toBe(true);
    expect(
      result.evidence.some((item) => item.excerpt.includes('Gemini'))
    ).toBe(true);
    expect(result.groundingStatus).toBe('grounded');
    expect(result.structuredOutputFallbackUsed).toBe(false);
    expect(
      result.citations.some((item) => item.excerpt.includes('Gemini'))
    ).toBe(true);
    closeDatabase(db);
  });

  test('accepts numeric citation arrays from model output', async () => {
    const repoDir = join(tempRoot, 'repo-numeric-citations');
    const dbDir = join(tempRoot, 'db-numeric-citations');
    await mkdir(repoDir, { recursive: true });

    await writeFile(
      join(repoDir, 'README.md'),
      '# Search\n\nGemini and Tavily are used to help agents search knowledge.\n'
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
        remoteCacheDir: join(tempRoot, 'cache-numeric-citations'),
      },
      embeddingProvider,
      rebuildTriggered: false,
      rebuildReason: null,
    });

    const result = await aiSearchIndex({
      db,
      embeddingProvider,
      llmProvider: new ScriptedLlmProvider(
        [
          {
            enough: false,
            rationale: 'Need a focused search query.',
            queries: ['Gemini Tavily agents'],
          },
        ],
        [
          {
            answer: 'The repository discusses search tooling.',
            citations: [1],
          },
        ]
      ),
      query: 'Gemini Tavily agents',
      limit: 5,
      scope: 'project',
      databasePath: join(dbDir, 'index.sqlite'),
      maxSteps: 1,
      maxQueriesPerStep: 1,
      maxEvidenceChunks: 5,
    });

    expect(result.groundingStatus).toBe('grounded');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.documentId).toBeGreaterThan(0);
    expect(result.citations[0]?.excerpt).toContain('Gemini');

    closeDatabase(db);
  });
  test('includes chunk excerpts in prompts and JSON output', async () => {
    const repoDir = join(tempRoot, 'repo-excerpts');
    const dbDir = join(tempRoot, 'db-excerpts');
    await mkdir(repoDir, { recursive: true });

    const sentinel = 'EXCERPT_SENTINEL_ALPHA';
    const longBody = [
      '# Search',
      '',
      'Gemini and Tavily help agents search the knowledge base.',
      'This chunk is intentionally long so the excerpt stays beyond the snippet window.',
      'x'.repeat(260),
      sentinel,
    ].join('\n');

    await writeFile(join(repoDir, 'README.md'), longBody);

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
        remoteCacheDir: join(tempRoot, 'cache-excerpts'),
      },
      embeddingProvider,
      rebuildTriggered: false,
      rebuildReason: null,
    });

    const llmProvider = new ScriptedLlmProvider(
      [
        {
          enough: false,
          rationale: 'Need to inspect the evidence.',
          queries: ['Gemini Tavily agents'],
        },
        {
          enough: true,
          rationale: 'Enough evidence is available.',
          queries: [],
        },
      ],
      [
        {
          answer: 'Gemini and Tavily support agent search.',
          citationIds: [1],
        },
      ]
    );

    const result = await aiSearchIndex({
      db,
      embeddingProvider,
      llmProvider,
      query: 'Gemini Tavily agents',
      limit: 5,
      scope: 'project',
      databasePath: join(dbDir, 'index.sqlite'),
      maxSteps: 2,
      maxQueriesPerStep: 2,
      maxEvidenceChunks: 5,
    });

    expect(llmProvider.plannerPrompts).toHaveLength(2);
    expect(llmProvider.plannerPrompts[1]).toContain(sentinel);
    expect(llmProvider.answerPrompts).toHaveLength(1);
    expect(llmProvider.answerPrompts[0]).toContain(sentinel);
    expect(result.evidence[0]?.chunkId).toBeGreaterThan(0);
    expect(
      result.evidence.some((item) => item.excerpt.includes(sentinel))
    ).toBe(true);
    expect(result.citations.some((item) => item.excerpt.length > 0)).toBe(true);
    expect(result.groundingStatus).toBe('grounded');
    expect(result.citations[0]?.quote?.length ?? 0).toBeGreaterThan(0);
    expect(
      result.citations[0]?.excerpt.includes(result.citations[0]?.quote ?? '')
    ).toBe(true);

    closeDatabase(db);
  });

  test('uses hardened evidence blocks in every planner and answer prompt that includes evidence', async () => {
    const repoDir = join(tempRoot, 'repo-hardened-prompts');
    const dbDir = join(tempRoot, 'db-hardened-prompts');
    await mkdir(repoDir, { recursive: true });

    const delimiterSentinel =
      'BEGIN_UNTRUSTED_EVIDENCE and END_UNTRUSTED_EVIDENCE must stay escaped';
    const excerptSentinel = 'PROMPT_HARDENING_SENTINEL';

    await writeFile(
      join(repoDir, 'README.md'),
      [
        '# Search',
        '',
        'Gemini and Tavily help agents search the knowledge base.',
        delimiterSentinel,
        excerptSentinel,
      ].join('\n')
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
        remoteCacheDir: join(tempRoot, 'cache-hardened-prompts'),
      },
      embeddingProvider,
      rebuildTriggered: false,
      rebuildReason: null,
    });

    const llmProvider = new ScriptedLlmProvider(
      [
        {
          enough: false,
          rationale: 'Need to retrieve evidence first.',
          queries: ['Gemini Tavily agents'],
        },
        {
          enough: true,
          rationale: 'Retrieved evidence is sufficient.',
          queries: [],
        },
      ],
      [
        {
          answer: 'The repository discusses search tooling.',
          citations: [{ evidenceId: 999, quote: 'fabricated quote' }],
        },
        {
          answer: 'The repository discusses search tooling.',
          citations: [{ evidenceId: 1 }],
        },
      ]
    );

    const result = await aiSearchIndex({
      db,
      embeddingProvider,
      llmProvider,
      query: 'Gemini Tavily agents',
      limit: 5,
      scope: 'project',
      databasePath: join(dbDir, 'index.sqlite'),
      maxSteps: 2,
      maxQueriesPerStep: 1,
      maxEvidenceChunks: 5,
    });

    expect(result.groundingStatus).toBe('grounded');
    expect(llmProvider.plannerPrompts).toHaveLength(2);
    expect(llmProvider.answerPrompts).toHaveLength(2);

    const hardenedPrompts = [
      llmProvider.plannerPrompts[1],
      llmProvider.answerPrompts[0],
      llmProvider.answerPrompts[1],
    ];

    for (const prompt of hardenedPrompts) {
      if (!prompt) {
        throw new Error('expected captured hardened prompt');
      }
      expectPromptEvidenceToBeHardened(prompt, excerptSentinel);
    }

    closeDatabase(db);
  });

  test('repairs invalid citation ids once and falls back to excerpt-only citations when quotes are not verifiable', async () => {
    const repoDir = join(tempRoot, 'repo-repair');
    const dbDir = join(tempRoot, 'db-repair');
    await mkdir(repoDir, { recursive: true });

    await writeFile(
      join(repoDir, 'README.md'),
      '# Search\n\nGemini and Tavily are used to help agents search knowledge.\n'
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
        remoteCacheDir: join(tempRoot, 'cache-repair'),
      },
      embeddingProvider,
      rebuildTriggered: false,
      rebuildReason: null,
    });

    const llmProvider = new ScriptedLlmProvider(
      [
        {
          enough: false,
          rationale: 'Need a focused search query.',
          queries: ['Gemini Tavily agents'],
        },
      ],
      [
        {
          answer: 'The repository discusses search tooling.',
          citations: [
            {
              evidenceId: 999,
              quote: 'fabricated quote that cannot be verified',
            },
          ],
        },
        {
          answer: 'The repository discusses search tooling.',
          citations: [
            {
              evidenceId: 1,
              quote: 'fabricated quote that cannot be verified',
            },
          ],
        },
      ]
    );

    const result = await aiSearchIndex({
      db,
      embeddingProvider,
      llmProvider,
      query: 'Gemini Tavily agents',
      limit: 5,
      scope: 'project',
      databasePath: join(dbDir, 'index.sqlite'),
      maxSteps: 1,
      maxQueriesPerStep: 1,
      maxEvidenceChunks: 5,
    });

    expect(llmProvider.answerPrompts).toHaveLength(2);
    expect(result.groundingStatus).toBe('grounded');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.evidenceId).toBe(1);
    expect(result.citations[0]?.quote).toBeUndefined();
    expect(result.citations[0]?.excerpt).toContain('Gemini');

    closeDatabase(db);
  });

  test('returns insufficient evidence status when retrieval finds nothing', async () => {
    const dbPath = join(tempRoot, 'empty.sqlite');
    const db = await openDatabase(dbPath);
    const embeddingProvider = new FakeEmbeddingProvider();
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
    );

    const llmProvider = new ScriptedLlmProvider(
      [
        {
          enough: false,
          rationale: 'Try a search query first.',
          queries: ['nothing-indexed-here'],
        },
      ],
      [
        {
          answer: 'This should not be used.',
          citationIds: [1],
        },
      ]
    );

    const result = await aiSearchIndex({
      db,
      embeddingProvider,
      llmProvider,
      query: 'nothing-indexed-here',
      limit: 5,
      scope: 'project',
      databasePath: dbPath,
      maxSteps: 1,
      maxQueriesPerStep: 1,
      maxEvidenceChunks: 5,
    });

    expect(result.groundingStatus).toBe('insufficient_evidence');
    expect(result.citations).toEqual([]);
    expect(result.answer).toContain('足够证据');
    expect(llmProvider.answerPrompts).toHaveLength(0);

    closeDatabase(db);
  });

  test('orders evidence deterministically and citations can be fetched with get', async () => {
    const projectDir = join(tempRoot, 'repo-tie-break');
    const dbDir = join(projectDir, '.nya-cli');
    const dbPath = join(dbDir, 'index.sqlite');
    await mkdir(projectDir, { recursive: true });

    await writeFile(
      join(projectDir, 'A.md'),
      ['# Alpha', '', 'alpha-only-token', 'alpha-only-token'].join('\n')
    );
    await writeFile(
      join(projectDir, 'B.md'),
      ['# Beta', '', 'beta-only-token', 'beta-only-token'].join('\n')
    );

    await runGit(projectDir, ['init']);
    await runGit(projectDir, ['config', 'user.email', 'test@example.com']);
    await runGit(projectDir, ['config', 'user.name', 'Test User']);
    await runGit(projectDir, ['add', '.']);
    await runGit(projectDir, ['commit', '-m', 'initial']);

    const db = await openDatabase(dbPath);
    const embeddingProvider = new TieBreakingEmbeddingProvider();
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(config.index.chunking_version)
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
        remoteCacheDir: join(tempRoot, 'cache-tie-break'),
      },
      embeddingProvider,
      rebuildTriggered: false,
      rebuildReason: null,
    });

    const alphaDocumentId = findDocumentsByPath(db, 'A.md')[0]?.documentId;
    const betaDocumentId = findDocumentsByPath(db, 'B.md')[0]?.documentId;

    if (alphaDocumentId === undefined || betaDocumentId === undefined) {
      throw new Error('expected document ids for tie-break fixture');
    }

    const alphaId = alphaDocumentId;
    const betaId = betaDocumentId;

    const llmProvider = new ScriptedLlmProvider(
      [
        {
          enough: false,
          rationale: 'Need both evidence items.',
          queries: ['beta-only-token', 'alpha-only-token'],
        },
      ],
      [
        {
          answer: 'Both documents matter.',
          citationIds: [1, 2],
        },
      ]
    );

    const result = await aiSearchIndex({
      db,
      embeddingProvider,
      llmProvider,
      query: 'beta-only-token alpha-only-token',
      limit: 5,
      scope: 'project',
      databasePath: dbPath,
      maxSteps: 1,
      maxQueriesPerStep: 2,
      maxEvidenceChunks: 5,
    });

    expect(result.evidence.map((item) => item.documentId)).toEqual([
      alphaId,
      betaId,
    ]);
    expect(new Set(result.evidence.map((item) => item.chunkId)).size).toBe(
      result.evidence.length
    );

    for (const citation of result.citations.slice(0, 3)) {
      const getResult = await runGetByDocumentId(
        projectDir,
        citation.documentId
      );
      expect(getResult.exitCode).toBe(0);
      expect(getResult.stderr).toBe('');

      const payload = JSON.parse(getResult.stdout) as {
        document: { documentId: number; path: string };
      };
      expect(payload.document.documentId).toBe(citation.documentId);
      expect(payload.document.path).toBe(citation.path);
    }

    closeDatabase(db);
  });
  test('propagates structured output fallback through ai-search responses', async () => {
    const repoDir = join(tempRoot, 'repo-fallback');
    const dbDir = join(tempRoot, 'db-fallback');
    await mkdir(repoDir, { recursive: true });

    await writeFile(
      join(repoDir, 'README.md'),
      '# Search\n\nGemini and Tavily are used to help agents search knowledge.\n'
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
        remoteCacheDir: join(tempRoot, 'cache-fallback'),
      },
      embeddingProvider,
      rebuildTriggered: false,
      rebuildReason: null,
    });

    const result = await aiSearchIndex({
      db,
      embeddingProvider,
      llmProvider: new FallbackLlmProvider(),
      query: 'Gemini 和 Tavily 如何用于 agent 搜索？',
      limit: 5,
      scope: 'project',
      databasePath: join(dbDir, 'index.sqlite'),
      maxSteps: 2,
      maxQueriesPerStep: 2,
      maxEvidenceChunks: 5,
    });

    expect(result.structuredOutputFallbackUsed).toBe(true);
    expect(result.answer).toContain('Gemini');
    closeDatabase(db);
  });
});

describe('structured output fallback helper', () => {
  test('falls back to text parsing when JSON mode is rejected', async () => {
    const schema = z.object({ answer: z.string() });
    let generateObjectCalls = 0;
    let generateTextCalls = 0;

    const result = await generateObjectWithFallbackHelper({
      system: 'system',
      prompt: 'prompt',
      schema,
      generateObjectImpl: async () => {
        generateObjectCalls += 1;
        throw new APICallError({
          message: 'The model rejected JSON mode.',
          url: 'https://generative.example/v1',
          requestBodyValues: {},
          statusCode: 400,
          responseBody: JSON.stringify({
            error: {
              code: 400,
              message:
                'responseMimeType application/json is not supported for this model',
              status: 'INVALID_ARGUMENT',
            },
          }),
        });
      },
      generateTextImpl: async () => {
        generateTextCalls += 1;
        return {
          text: '{"answer":"fallback answer"}',
        };
      },
    });

    expect(generateObjectCalls).toBe(1);
    expect(generateTextCalls).toBe(1);
    expect(result.structuredOutputFallbackUsed).toBe(true);
    expect(result.object).toEqual({ answer: 'fallback answer' });
  });

  test('does not fall back for unrelated API errors', async () => {
    const schema = z.object({ answer: z.string() });
    let generateTextCalls = 0;

    await expect(
      generateObjectWithFallbackHelper({
        system: 'system',
        prompt: 'prompt',
        schema,
        generateObjectImpl: async () => {
          throw new APICallError({
            message: 'invalid api key',
            url: 'https://generative.example/v1',
            requestBodyValues: {},
            statusCode: 400,
            responseBody: JSON.stringify({
              error: {
                code: 400,
                message: 'invalid api key',
                status: 'INVALID_ARGUMENT',
              },
            }),
          });
        },
        generateTextImpl: async () => {
          generateTextCalls += 1;
          return {
            text: '{"answer":"should not be used"}',
          };
        },
      })
    ).rejects.toThrow('invalid api key');

    expect(generateTextCalls).toBe(0);
  });
});
