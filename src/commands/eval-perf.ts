import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ZodType } from 'zod';

import { learnGitSource } from '../core/ingest/learn-git';
import { aiSearchIndex } from '../core/search/ai-search';
import { searchIndex } from '../core/search/search-index';
import {
  closeDatabase,
  initializeEmptyIndex,
  openDatabase,
} from '../db/database';
import type {
  EmbeddingFingerprint,
  EmbeddingProvider,
  LlmProvider,
} from '../providers/types';
import type { AppConfig } from '../types/config';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export const evalPerfBaselinePath = join(
  repoRoot,
  'tests/fixtures/eval-perf-baseline.json'
);

const evalPerfConfig: AppConfig = {
  app: {
    default_output: 'json',
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
          get_page_timeout_ms: 30_000,
          fetch_page_timeout_ms: 60_000,
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
    model: 'eval-perf-embedding',
    task_type: 'RETRIEVAL_DOCUMENT',
    providers: {
      google: {
        api_key_env: 'GOOGLE_GENERATIVE_AI_API_KEY',
        output_dimensionality: 6,
        rpm: 0,
        tpm: 0,
        retry_max_retries: 3,
        retry_delay_seconds: 10,
      },
      openai: {
        api_key_env: 'OPENAI_API_KEY',
        base_url: 'https://api.openai.com/v1',
        dimensions: 6,
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
    model: 'eval-perf-llm',
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
    max_steps: 1,
    max_queries_per_step: 1,
    retrieval_limit: 3,
    max_evidence_chunks: 3,
  },
  index: {
    chunk_size: 140,
    chunk_overlap: 20,
    chunking_version: 'v1',
    fts: true,
    vector: true,
    max_file_bytes: 262_144,
  },
};

const fixtureFiles = {
  'README.md': [
    '# Offline Eval Fixture',
    '',
    'This fixture exercises hybrid retrieval for grounded local answers.',
    'It combines vector search, FTS search, and evidence-aware summaries.',
    '',
  ].join('\n'),
  'docs/retrieval.md': [
    '# Retrieval Notes',
    '',
    'Hybrid retrieval keeps the offline fixture deterministic.',
    'Vector search finds semantic matches, while keyword search preserves exact evidence anchors.',
    'The eval baseline expects evidence counts to remain stable.',
    '',
  ].join('\n'),
  'src/search-index.ts': [
    'export function buildHybridRetrievalSummary() {',
    "  return 'Hybrid retrieval fuses vector search with keyword evidence for local agents.';",
    '}',
    '',
    'export function rankEvidencePaths() {',
    "  return ['README.md', 'docs/retrieval.md'];",
    '}',
    '',
  ].join('\n'),
  'src/answer.ts': [
    'export function answerWithEvidence() {',
    "  return 'Grounded answers cite local evidence and avoid network dependencies.';",
    '}',
    '',
  ].join('\n'),
} as const;

const searchQuery = 'hybrid retrieval evidence';
const aiSearchQuery = 'What keeps the offline eval fixture grounded?';
const stableMetricPaths = [
  'fixture.sourceFiles',
  'metrics.dataset.documentsIndexed',
  'metrics.dataset.chunksIndexed',
  'metrics.dataset.skippedSymlinks',
  'metrics.search.limit',
  'metrics.search.results',
  'metrics.search.retrieversUsed',
  'metrics.search.vectorCandidates',
  'metrics.search.ftsCandidates',
  'metrics.search.lexicalCandidates',
  'metrics.search.metadataCandidates',
  'metrics.aiSearch.limit',
  'metrics.aiSearch.maxSteps',
  'metrics.aiSearch.maxQueriesPerStep',
  'metrics.aiSearch.maxEvidenceChunks',
  'metrics.aiSearch.iterations',
  'metrics.aiSearch.usedQueries',
  'metrics.aiSearch.evidence',
  'metrics.aiSearch.citations',
  'metrics.aiSearch.groundingStatus',
  'metrics.aiSearch.structuredOutputFallbackUsed',
  'metrics.llm.plannerCalls',
  'metrics.llm.answerCalls',
  'metrics.llm.totalCalls',
] as const;

const defaultTimingMaxRegressionRatio = 1.5;
const defaultTimingAbsoluteBufferMs = 25;

export type EvalPerfResult = {
  schemaVersion: 1;
  fixture: {
    name: 'offline-eval-perf';
    sourceFiles: number;
    searchQuery: string;
    aiSearchQuery: string;
  };
  metrics: {
    dataset: {
      documentsIndexed: number;
      chunksIndexed: number;
      skippedSymlinks: number;
    };
    search: {
      limit: number;
      results: number;
      retrieversUsed: string[];
      vectorCandidates: number;
      ftsCandidates: number;
      lexicalCandidates: number;
      metadataCandidates: number;
    };
    aiSearch: {
      limit: number;
      maxSteps: number;
      maxQueriesPerStep: number;
      maxEvidenceChunks: number;
      iterations: number;
      usedQueries: number;
      evidence: number;
      citations: number;
      groundingStatus:
        | 'grounded'
        | 'insufficient_evidence'
        | 'citation_validation_failed';
      structuredOutputFallbackUsed: boolean;
    };
    llm: {
      plannerCalls: number;
      answerCalls: number;
      totalCalls: number;
    };
  };
  telemetry: {
    timingsMs: {
      fixtureSetup: number;
      learnGit: number;
      search: number;
      aiSearch: number;
      total: number;
    };
  };
};

export type EvalPerfRegression = {
  metricPath: string;
  rule: 'exact' | 'max_timing_regression';
  baseline: unknown;
  current: unknown;
  threshold?: {
    maxRegressionRatio: number;
    absoluteBufferMs: number;
  };
};

export type EvalPerfCheckResult = {
  schemaVersion: 1;
  status: 'passed' | 'failed';
  baselinePath: string;
  checkedMetricCount: number;
  timingChecks: {
    enabled: boolean;
    maxRegressionRatio: number;
    absoluteBufferMs: number;
  };
  regressions: EvalPerfRegression[];
};

export type RunEvalPerfOptions = {
  workspaceRoot?: string;
};

export type RunEvalPerfCheckOptions = {
  baselinePath?: string;
  currentResult?: EvalPerfResult;
  checkTimings?: boolean;
  timingMaxRegressionRatio?: number;
  timingAbsoluteBufferMs?: number;
};

type FixtureWriteMap = Record<string, string>;

class EvalPerfEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'google' as const;
  readonly model = 'eval-perf-embedding';
  readonly dimensions = 6;

  private encode(text: string): number[] {
    const normalized = text.toLowerCase();
    return [
      normalized.includes('hybrid') ? 10 : 0,
      normalized.includes('retrieval') ? 10 : 0,
      normalized.includes('vector') ? 10 : 0,
      normalized.includes('search') ? 10 : 0,
      normalized.includes('evidence') ? 10 : 0,
      normalized.includes('grounded') ? 10 : 0,
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

class EvalPerfLlmProvider implements LlmProvider {
  readonly id = 'google' as const;
  readonly model = 'eval-perf-llm';

  plannerCalls = 0;
  answerCalls = 0;

  async generateText(): Promise<{ text: string }> {
    return {
      text: 'unused',
    };
  }

  async generateObject<T>(args: {
    system: string;
    prompt: string;
    schema: ZodType<T>;
    schemaName?: string;
    schemaDescription?: string;
  }): Promise<T> {
    return (await this.generateObjectWithFallback(args)).object;
  }

  async generateObjectWithFallback<T>(args: {
    system: string;
    prompt: string;
    schema: ZodType<T>;
    schemaName?: string;
    schemaDescription?: string;
  }): Promise<{
    object: T;
    structuredOutputFallbackUsed: boolean;
  }> {
    if (args.schemaName === 'ai_search_planner') {
      this.plannerCalls += 1;
      return {
        object: {
          enough: false,
          rationale: 'Collect one deterministic retrieval pass.',
          queries: [searchQuery],
        } as T,
        structuredOutputFallbackUsed: false,
      };
    }

    this.answerCalls += 1;
    return {
      object: {
        answer:
          'The offline eval fixture stays grounded by combining hybrid retrieval with cited local evidence.',
        citationIds: [1],
      } as T,
      structuredOutputFallbackUsed: false,
    };
  }
}

async function runGitCommand(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  }
}

async function writeFixtureTree(rootDir: string, files: FixtureWriteMap) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(rootDir, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
}

async function createEvalPerfRepository(workspaceDir: string): Promise<string> {
  const repoDir = join(workspaceDir, 'source-repo');
  await mkdir(repoDir, { recursive: true });
  await writeFixtureTree(repoDir, fixtureFiles);
  await runGitCommand(repoDir, ['init', '-q']);
  await runGitCommand(repoDir, ['add', '.']);
  return repoDir;
}

function roundDurationMs(startTime: number): number {
  return Math.round(performance.now() - startTime);
}

function createEvalPerfDbPath(workspaceDir: string): string {
  return join(workspaceDir, '.nya-cli', 'index.sqlite');
}

function readPathValue(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current !== 'object') {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, value);
}

function valuesMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shouldCheckTimings(options: RunEvalPerfCheckOptions): boolean {
  if (options.checkTimings !== undefined) {
    return options.checkTimings;
  }

  const envValue = process.env.NYA_EVAL_PERF_CHECK_TIMINGS?.trim();
  return envValue === '1' || envValue?.toLowerCase() === 'true';
}

function resolveTimingMaxRegressionRatio(
  options: RunEvalPerfCheckOptions
): number {
  if (options.timingMaxRegressionRatio !== undefined) {
    return options.timingMaxRegressionRatio;
  }

  const envValue = Number(
    process.env.NYA_EVAL_PERF_TIMING_MAX_REGRESSION_RATIO
  );
  return Number.isFinite(envValue) && envValue > 1
    ? envValue
    : defaultTimingMaxRegressionRatio;
}

function resolveTimingAbsoluteBufferMs(
  options: RunEvalPerfCheckOptions
): number {
  if (options.timingAbsoluteBufferMs !== undefined) {
    return options.timingAbsoluteBufferMs;
  }

  const envValue = Number(process.env.NYA_EVAL_PERF_TIMING_ABSOLUTE_BUFFER_MS);
  return Number.isFinite(envValue) && envValue >= 0
    ? envValue
    : defaultTimingAbsoluteBufferMs;
}

function compareStableMetrics(
  baseline: EvalPerfResult,
  current: EvalPerfResult
): EvalPerfRegression[] {
  return stableMetricPaths.flatMap((metricPath) => {
    const baselineValue = readPathValue(baseline, metricPath);
    const currentValue = readPathValue(current, metricPath);

    if (valuesMatch(baselineValue, currentValue)) {
      return [];
    }

    return [
      {
        metricPath,
        rule: 'exact' as const,
        baseline: baselineValue,
        current: currentValue,
      },
    ];
  });
}

function compareTimings(args: {
  baseline: EvalPerfResult;
  current: EvalPerfResult;
  enabled: boolean;
  maxRegressionRatio: number;
  absoluteBufferMs: number;
}): EvalPerfRegression[] {
  if (!args.enabled) {
    return [];
  }

  const baselineTimings = args.baseline.telemetry.timingsMs;
  const currentTimings = args.current.telemetry.timingsMs;

  return Object.keys(baselineTimings).flatMap((key) => {
    const metricPath = `telemetry.timingsMs.${key}`;
    const baselineValue = baselineTimings[key as keyof typeof baselineTimings];
    const currentValue = currentTimings[key as keyof typeof currentTimings];

    const thresholdValue = Math.max(
      baselineValue * args.maxRegressionRatio,
      baselineValue + args.absoluteBufferMs
    );

    if (currentValue <= thresholdValue) {
      return [];
    }

    return [
      {
        metricPath,
        rule: 'max_timing_regression' as const,
        baseline: baselineValue,
        current: currentValue,
        threshold: {
          maxRegressionRatio: args.maxRegressionRatio,
          absoluteBufferMs: args.absoluteBufferMs,
        },
      },
    ];
  });
}

export function compareEvalPerfResults(args: {
  baseline: EvalPerfResult;
  current: EvalPerfResult;
  baselinePath: string;
  checkTimings?: boolean;
  timingMaxRegressionRatio?: number;
  timingAbsoluteBufferMs?: number;
}): EvalPerfCheckResult {
  const timingChecksEnabled = args.checkTimings ?? false;
  const timingMaxRegressionRatio =
    args.timingMaxRegressionRatio ?? defaultTimingMaxRegressionRatio;
  const timingAbsoluteBufferMs =
    args.timingAbsoluteBufferMs ?? defaultTimingAbsoluteBufferMs;

  const regressions = [
    ...compareStableMetrics(args.baseline, args.current),
    ...compareTimings({
      baseline: args.baseline,
      current: args.current,
      enabled: timingChecksEnabled,
      maxRegressionRatio: timingMaxRegressionRatio,
      absoluteBufferMs: timingAbsoluteBufferMs,
    }),
  ];

  return {
    schemaVersion: 1,
    status: regressions.length === 0 ? 'passed' : 'failed',
    baselinePath: args.baselinePath,
    checkedMetricCount: stableMetricPaths.length,
    timingChecks: {
      enabled: timingChecksEnabled,
      maxRegressionRatio: timingMaxRegressionRatio,
      absoluteBufferMs: timingAbsoluteBufferMs,
    },
    regressions,
  };
}

async function readEvalPerfBaseline(
  baselinePath: string
): Promise<EvalPerfResult> {
  const raw = await readFile(baselinePath, 'utf8');
  return JSON.parse(raw) as EvalPerfResult;
}

export async function writeEvalPerfBaseline(
  baselinePath: string,
  result: EvalPerfResult
): Promise<void> {
  await mkdir(dirname(baselinePath), { recursive: true });
  await writeFile(`${baselinePath}`, `${JSON.stringify(result, null, 2)}\n`);
}

export async function runEvalPerf(
  options: RunEvalPerfOptions = {}
): Promise<EvalPerfResult> {
  const totalStart = performance.now();
  const workspaceDir =
    options.workspaceRoot ??
    (await mkdtemp(join(tmpdir(), 'nya-cli-eval-perf-workspace-')));
  const cleanupWorkspace = options.workspaceRoot === undefined;

  const setupStart = performance.now();
  const repoDir = await createEvalPerfRepository(workspaceDir);
  const fixtureSetupMs = roundDurationMs(setupStart);

  const dbPath = createEvalPerfDbPath(workspaceDir);
  const db = await openDatabase(dbPath);
  const embeddingProvider = new EvalPerfEmbeddingProvider();
  const llmProvider = new EvalPerfLlmProvider();

  try {
    initializeEmptyIndex(
      db,
      embeddingProvider.fingerprint(evalPerfConfig.index.chunking_version)
    );

    const learnStart = performance.now();
    const learnResult = await learnGitSource({
      source: repoDir,
      config: evalPerfConfig,
      db,
      scope: 'project',
      scopePaths: {
        scope: 'project',
        projectDirName: evalPerfConfig.app.project_dir_name,
        databasePath: dbPath,
        databaseDir: join(workspaceDir, '.nya-cli'),
        remoteCacheDir: join(workspaceDir, '.nya-cli', 'remote-cache'),
      },
      embeddingProvider,
      rebuildTriggered: false,
      rebuildReason: null,
    });
    const learnGitMs = roundDurationMs(learnStart);

    const searchStart = performance.now();
    const searchResult = await searchIndex({
      db,
      embeddingProvider,
      query: searchQuery,
      limit: 3,
      scope: 'project',
      databasePath: dbPath,
    });
    const searchMs = roundDurationMs(searchStart);

    const aiSearchStart = performance.now();
    const aiSearchResult = await aiSearchIndex({
      db,
      embeddingProvider,
      llmProvider,
      query: aiSearchQuery,
      limit: evalPerfConfig.ai_search.retrieval_limit,
      scope: 'project',
      databasePath: dbPath,
      maxSteps: evalPerfConfig.ai_search.max_steps,
      maxQueriesPerStep: evalPerfConfig.ai_search.max_queries_per_step,
      maxEvidenceChunks: evalPerfConfig.ai_search.max_evidence_chunks,
    });
    const aiSearchMs = roundDurationMs(aiSearchStart);

    return {
      schemaVersion: 1,
      fixture: {
        name: 'offline-eval-perf',
        sourceFiles: Object.keys(fixtureFiles).length,
        searchQuery,
        aiSearchQuery,
      },
      metrics: {
        dataset: {
          documentsIndexed: learnResult.documentsIndexed,
          chunksIndexed: learnResult.chunksIndexed,
          skippedSymlinks: learnResult.skippedSymlinks,
        },
        search: {
          limit: 3,
          results: searchResult.results.length,
          retrieversUsed: searchResult.retrieversUsed,
          vectorCandidates: searchResult.vectorCandidates,
          ftsCandidates: searchResult.ftsCandidates,
          lexicalCandidates: searchResult.lexicalCandidates,
          metadataCandidates: searchResult.metadataCandidates,
        },
        aiSearch: {
          limit: evalPerfConfig.ai_search.retrieval_limit,
          maxSteps: evalPerfConfig.ai_search.max_steps,
          maxQueriesPerStep: evalPerfConfig.ai_search.max_queries_per_step,
          maxEvidenceChunks: evalPerfConfig.ai_search.max_evidence_chunks,
          iterations: aiSearchResult.iterations,
          usedQueries: aiSearchResult.usedQueries.length,
          evidence: aiSearchResult.evidence.length,
          citations: aiSearchResult.citations.length,
          groundingStatus: aiSearchResult.groundingStatus,
          structuredOutputFallbackUsed:
            aiSearchResult.structuredOutputFallbackUsed,
        },
        llm: {
          plannerCalls: llmProvider.plannerCalls,
          answerCalls: llmProvider.answerCalls,
          totalCalls: llmProvider.plannerCalls + llmProvider.answerCalls,
        },
      },
      telemetry: {
        timingsMs: {
          fixtureSetup: fixtureSetupMs,
          learnGit: learnGitMs,
          search: searchMs,
          aiSearch: aiSearchMs,
          total: roundDurationMs(totalStart),
        },
      },
    };
  } finally {
    closeDatabase(db);
    if (cleanupWorkspace) {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }
}

export async function runEvalPerfCheck(
  options: RunEvalPerfCheckOptions = {}
): Promise<EvalPerfCheckResult> {
  const baselinePath = options.baselinePath ?? evalPerfBaselinePath;
  const [baseline, current] = await Promise.all([
    readEvalPerfBaseline(baselinePath),
    options.currentResult
      ? Promise.resolve(options.currentResult)
      : runEvalPerf(),
  ]);

  return compareEvalPerfResults({
    baseline,
    current,
    baselinePath,
    checkTimings: shouldCheckTimings(options),
    timingMaxRegressionRatio: resolveTimingMaxRegressionRatio(options),
    timingAbsoluteBufferMs: resolveTimingAbsoluteBufferMs(options),
  });
}
