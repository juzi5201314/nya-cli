import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type SmokeEnv = Record<string, string>;

type SpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type SmokeRunner = (args: {
  cwd: string;
  command: string[];
  env: SmokeEnv;
}) => Promise<SpawnResult>;

export type SmokeGoogleResult =
  | {
      status: 'skipped';
      reason: string;
    }
  | {
      status: 'passed';
      limits: {
        searchLimit: number;
        aiSearch: {
          maxSteps: number;
          maxQueries: number;
          maxEvidence: number;
        };
      };
      counts: {
        commands: {
          learn: number;
          search: number;
          aiSearch: number;
          total: number;
        };
        learn: {
          documentsIndexed: number;
          chunksIndexed: number;
          skippedSymlinks: number;
        };
        search: {
          results: number;
        };
        aiSearch: {
          iterations: number;
          usedQueries: number;
          evidence: number;
          citations: number;
          llmRequests: number;
          structuredOutputFallbackUsed: boolean;
        };
      };
    };

export type RunSmokeGoogleOptions = {
  runner?: SmokeRunner;
  env?: SmokeEnv;
  cliEntryPath?: string;
  configPath?: string;
  tempDirPrefix?: string;
};

type LearnJson = {
  documentsIndexed: number;
  chunksIndexed: number;
  skippedSymlinks: number;
};

type SearchJson = {
  results: Array<unknown>;
};

type AiSearchJson = {
  iterations: number;
  usedQueries: string[];
  evidence: Array<unknown>;
  citations: Array<unknown>;
  structuredOutputFallbackUsed: boolean;
};

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultCliEntryPath = join(repoRoot, 'src/index.ts');
const defaultConfigPath = join(repoRoot, 'nya.toml');
const smokeQuery = 'What flow does the smoke repository validate?';

function snapshotProcessEnv(): SmokeEnv {
  const env: SmokeEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return env;
}

async function defaultRunner(args: {
  cwd: string;
  command: string[];
  env: SmokeEnv;
}): Promise<SpawnResult> {
  const proc = Bun.spawn(args.command, {
    cwd: args.cwd,
    env: args.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    exitCode,
    stdout,
    stderr,
  };
}

function createEnv(env: SmokeEnv | undefined): SmokeEnv {
  return env ?? snapshotProcessEnv();
}

function parseJson<T>(label: string, output: string): T {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error(`Smoke ${label} did not return JSON output.`);
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(`Smoke ${label} returned invalid JSON output.`);
  }
}

function assertNoSecretLeak(
  label: string,
  output: string,
  secret: string
): void {
  if (secret.length > 0 && output.includes(secret)) {
    throw new Error(
      `Smoke output leaked the Google API key value in ${label}.`
    );
  }
}

function buildCliCommand(cliEntryPath: string, args: string[]): string[] {
  return ['bun', 'run', cliEntryPath, ...args];
}

async function runCliCommand(args: {
  runner: SmokeRunner;
  cwd: string;
  env: SmokeEnv;
  cliEntryPath: string;
  secret: string;
  label: string;
  commandArgs: string[];
}): Promise<SpawnResult> {
  const result = await args.runner({
    cwd: args.cwd,
    command: buildCliCommand(args.cliEntryPath, args.commandArgs),
    env: args.env,
  });

  assertNoSecretLeak(`${args.label} stdout`, result.stdout, args.secret);
  assertNoSecretLeak(`${args.label} stderr`, result.stderr, args.secret);

  if (result.exitCode !== 0) {
    throw new Error(
      `Smoke ${args.label} failed with exit code ${result.exitCode}.`
    );
  }

  return result;
}

async function runGitCommand(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  }
}

async function createSmokeRepository(workspaceDir: string): Promise<string> {
  const repoDir = join(workspaceDir, 'source-repo');
  await mkdir(repoDir, { recursive: true });

  await writeFile(
    join(repoDir, 'README.md'),
    [
      '# Smoke Google Runner',
      '',
      'This repository validates the smoke google end to end flow.',
      'It should be discoverable by local search and answer the validation question.',
      '',
    ].join('\n')
  );

  await runGitCommand(repoDir, ['init', '-q']);
  await runGitCommand(repoDir, ['add', '.']);

  return repoDir;
}

function buildLearnArgs(configPath: string, repoDir: string): string[] {
  return [
    'learn',
    'git',
    repoDir,
    '--config',
    configPath,
    '--project',
    '--json',
    '--no-tui',
  ];
}

function buildSearchArgs(configPath: string): string[] {
  return [
    'search',
    smokeQuery,
    '--config',
    configPath,
    '--project',
    '--json',
    '--no-tui',
    '--limit',
    '1',
  ];
}

function buildAiSearchArgs(configPath: string): string[] {
  return [
    'ai-search',
    smokeQuery,
    '--config',
    configPath,
    '--project',
    '--json',
    '--no-tui',
    '--limit',
    '1',
    '--max-steps',
    '1',
    '--max-queries',
    '1',
    '--max-evidence',
    '1',
  ];
}

export async function runSmokeGoogle(
  options: RunSmokeGoogleOptions = {}
): Promise<SmokeGoogleResult> {
  const env = createEnv(options.env);
  const secret = env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ?? '';

  if (!secret) {
    return {
      status: 'skipped',
      reason: 'GOOGLE_GENERATIVE_AI_API_KEY missing',
    };
  }

  const runner = options.runner ?? defaultRunner;
  const cliEntryPath = options.cliEntryPath ?? defaultCliEntryPath;
  const configPath = options.configPath ?? defaultConfigPath;
  const tempDirPrefix = options.tempDirPrefix ?? 'nya-cli-smoke-google-';
  const workspaceDir = await mkdtemp(join(tmpdir(), tempDirPrefix));

  try {
    const repoDir = await createSmokeRepository(workspaceDir);

    const learnResult = parseJson<LearnJson>(
      'learn',
      (
        await runCliCommand({
          runner,
          cwd: workspaceDir,
          env,
          cliEntryPath,
          secret,
          label: 'learn',
          commandArgs: buildLearnArgs(configPath, repoDir),
        })
      ).stdout
    );

    const searchResult = parseJson<SearchJson>(
      'search',
      (
        await runCliCommand({
          runner,
          cwd: workspaceDir,
          env,
          cliEntryPath,
          secret,
          label: 'search',
          commandArgs: buildSearchArgs(configPath),
        })
      ).stdout
    );

    const aiSearchResult = parseJson<AiSearchJson>(
      'ai-search',
      (
        await runCliCommand({
          runner,
          cwd: workspaceDir,
          env,
          cliEntryPath,
          secret,
          label: 'ai-search',
          commandArgs: buildAiSearchArgs(configPath),
        })
      ).stdout
    );

    if (searchResult.results.length === 0) {
      throw new Error('Smoke search returned no results.');
    }

    if (aiSearchResult.citations.length === 0) {
      throw new Error('Smoke ai-search returned no citations.');
    }

    return {
      status: 'passed',
      limits: {
        searchLimit: 1,
        aiSearch: {
          maxSteps: 1,
          maxQueries: 1,
          maxEvidence: 1,
        },
      },
      counts: {
        commands: {
          learn: 1,
          search: 1,
          aiSearch: 1,
          total: 3,
        },
        learn: {
          documentsIndexed: learnResult.documentsIndexed,
          chunksIndexed: learnResult.chunksIndexed,
          skippedSymlinks: learnResult.skippedSymlinks,
        },
        search: {
          results: searchResult.results.length,
        },
        aiSearch: {
          iterations: aiSearchResult.iterations,
          usedQueries: aiSearchResult.usedQueries.length,
          evidence: aiSearchResult.evidence.length,
          citations: aiSearchResult.citations.length,
          llmRequests: Math.max(1, aiSearchResult.iterations) + 1,
          structuredOutputFallbackUsed:
            aiSearchResult.structuredOutputFallbackUsed,
        },
      },
    };
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}
