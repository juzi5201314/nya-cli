import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const distPath = fileURLToPath(new URL('../dist/nya', import.meta.url));
const chunkModuleUrl = new URL(
  '../src/core/chunking/chunk-text.ts',
  import.meta.url
).href;
const tempRoot = '/tmp/nya-cli-build-artifact-tests';
const sqliteVecPackageName = `sqlite-vec-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const sqliteVecFilename =
  process.platform === 'win32'
    ? 'vec0.dll'
    : process.platform === 'darwin'
      ? 'vec0.dylib'
      : 'vec0.so';

let buildPromise: Promise<void> | null = null;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runCommand(
  args: string[],
  cwd: string,
  env?: Record<string, string>
): Promise<CommandResult> {
  const proc = Bun.spawn(args, {
    cwd,
    ...(env ? { env: { ...process.env, ...env } } : {}),
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

function expectSuccess(result: CommandResult, context: string) {
  if (result.exitCode !== 0) {
    throw new Error(
      `${context} failed with exit ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
}

async function ensureBuild(): Promise<void> {
  if (!buildPromise) {
    buildPromise = (async () => {
      const build = await runCommand(['bun', 'run', 'build'], repoRoot);
      expectSuccess(build, 'bun run build');
    })();
  }

  await buildPromise;
}

async function createFixtureRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });

  expectSuccess(await runCommand(['git', 'init'], path), 'git init');
  expectSuccess(
    await runCommand(['git', 'config', 'user.email', 'test@example.com'], path),
    'git config user.email'
  );
  expectSuccess(
    await runCommand(['git', 'config', 'user.name', 'Test User'], path),
    'git config user.name'
  );
  await writeFile(
    join(path, 'README.md'),
    '# Fixture\n\nHello sqlite vec build artifact test.\n'
  );
  expectSuccess(await runCommand(['git', 'add', '.'], path), 'git add');
  expectSuccess(
    await runCommand(['git', 'commit', '-m', 'init'], path),
    'git commit'
  );
}

function createOfflineConfig(baseUrl: string): string {
  return `
[app]
default_output = "text"
project_dir_name = ".nya-cli"

[web.search]
provider = "tavily"

[web.search.providers.tavily]
api_key_env = "TAVILY_API_KEY"
default_topic = "general"
default_search_depth = "basic"
rpm = 0
tpm = 0
retry_max_retries = 0
retry_delay_seconds = 1

[web.ingest]
provider = "crawl4ai"

[web.ingest.providers.crawl4ai]
command = "crwl"
default_fetch_mode = "auto"
default_crawl = false
default_max_pages = 25
default_max_depth = 2
min_markdown_chars = 200
get_page_timeout_ms = 30000
fetch_page_timeout_ms = 60000
rpm = 0
tpm = 0
retry_max_retries = 0
retry_delay_seconds = 1

[web.ingest.providers.cloudflare]
account_id = ""
api_token_env = "CLOUDFLARE_API_TOKEN"
base_url = "https://api.cloudflare.com/client/v4"
default_fetch_mode = "get"
default_crawl = false
default_max_pages = 25
default_max_depth = 2
min_markdown_chars = 200
poll_interval_ms = 10000
max_poll_attempts = 60
source = "all"
include_external_links = false
include_subdomains = false
include_patterns = []
exclude_patterns = []
rpm = 0
tpm = 0
retry_max_retries = 0
retry_delay_seconds = 1

[embedding]
provider = "openai"
model = "fake-openai-embedding"
task_type = "RETRIEVAL_DOCUMENT"

[embedding.providers.google]
api_key_env = "GOOGLE_GENERATIVE_AI_API_KEY"
output_dimensionality = 1536
rpm = 0
tpm = 0
retry_max_retries = 0
retry_delay_seconds = 1

[embedding.providers.openai]
api_key_env = "OPENAI_API_KEY"
base_url = "${baseUrl}"
dimensions = 4
rpm = 0
tpm = 0
retry_max_retries = 0
retry_delay_seconds = 1

[rerank]
provider = "none"

[llm]
provider = "openai"
model = "fake-openai-llm"

[llm.providers.google]
api_key_env = "GOOGLE_GENERATIVE_AI_API_KEY"
rpm = 0
tpm = 0
retry_max_retries = 0
retry_delay_seconds = 1

[llm.providers.openai]
api_key_env = "OPENAI_API_KEY"
base_url = "${baseUrl}"
rpm = 0
tpm = 0
retry_max_retries = 0
retry_delay_seconds = 1

[ai_search]
max_steps = 1
max_queries_per_step = 1
retrieval_limit = 4
max_evidence_chunks = 4

[index]
chunk_size = 400
chunk_overlap = 50
chunking_version = "v1"
fts = true
vector = true
max_file_bytes = 262144
`.trimStart();
}

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('build artifact verification', () => {
  test('build produces a runnable dist artifact with required tree-sitter assets', async () => {
    await mkdir(tempRoot, { recursive: true });

    await ensureBuild();

    const builtArtifact = await stat(distPath);
    expect(builtArtifact.mode & 0o111).toBeGreaterThan(0);

    const help = await runCommand([distPath, '--help'], tempRoot);
    expectSuccess(help, 'dist/nya --help');
    expect(help.stdout).toContain('nya');

    const doctor = await runCommand(
      [distPath, 'db', 'doctor', '--project', '--json', '--no-tui'],
      tempRoot
    );
    expectSuccess(doctor, 'dist/nya db doctor --project --json --no-tui');

    const doctorJson = JSON.parse(doctor.stdout) as {
      dbExists: boolean;
      needsRebuild: boolean;
    };
    expect(doctorJson.dbExists).toBe(false);
    expect(doctorJson.needsRebuild).toBe(true);

    const assets = await readdir(join(repoRoot, 'dist', 'tree-sitter'));
    expect(assets).toContain('web-tree-sitter.wasm');
    expect(assets).toContain('tree-sitter-typescript.wasm');
    const sqliteVecAsset = await stat(
      join(
        repoRoot,
        'dist',
        'sqlite-vec',
        sqliteVecPackageName,
        sqliteVecFilename
      )
    );
    expect(sqliteVecAsset.isFile()).toBe(true);

    const isolatedCwd = join(tempRoot, 'isolated-cwd');
    const runnerPath = join(tempRoot, 'verify-dist-tree-sitter.ts');
    await mkdir(isolatedCwd, { recursive: true });
    await writeFile(
      runnerPath,
      `
import { chunkTextDocument } from ${JSON.stringify(chunkModuleUrl)};

process.chdir(${JSON.stringify(isolatedCwd)});
process.argv[1] = ${JSON.stringify(distPath)};

const chunks = await chunkTextDocument({
  filePath: 'fixture.ts',
  content: 'export function buildArtifactChunkingMarker() {\\n  return "tree sitter asset check";\\n}\\n',
  config: {
    index: {
      chunk_size: 120,
      chunk_overlap: 20,
    },
  } as any,
});

console.log(JSON.stringify(chunks));
`
    );

    const chunking = await runCommand(['bun', runnerPath], tempRoot);
    expectSuccess(chunking, 'dist tree-sitter runtime chunking check');

    const chunks = JSON.parse(chunking.stdout) as Array<{
      content: string;
      section: string;
    }>;
    expect(chunks.length).toBeGreaterThan(0);
    expect(
      chunks.some((chunk) =>
        chunk.content.includes('buildArtifactChunkingMarker')
      )
    ).toBe(true);
  });

  test('dist artifact can learn git from an isolated temp cwd with bundled sqlite-vec', async () => {
    await mkdir(tempRoot, { recursive: true });
    await ensureBuild();

    const fixtureRepo = join(tempRoot, 'fixture-repo');
    const isolatedCwd = join(tempRoot, 'isolated-cwd');
    const configPath = join(tempRoot, 'offline-openai.toml');

    await createFixtureRepo(fixtureRepo);
    await mkdir(isolatedCwd, { recursive: true });

    let embeddingRequests = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
          embeddingRequests += 1;
          const payload = (await request.json()) as {
            input: string | string[];
          };
          const inputs = Array.isArray(payload.input)
            ? payload.input
            : [payload.input];

          return Response.json({
            object: 'list',
            model: 'fake-openai-embedding',
            data: inputs.map((value, index) => {
              const seed = value.length % 10;
              return {
                object: 'embedding',
                index,
                embedding: [seed, seed + 1, seed + 2, seed + 3],
              };
            }),
            usage: {
              prompt_tokens: inputs.length,
              total_tokens: inputs.length,
            },
          });
        }

        return new Response('not found', { status: 404 });
      },
    });

    try {
      await writeFile(
        configPath,
        createOfflineConfig(`http://127.0.0.1:${server.port}/v1`)
      );

      const learn = await runCommand(
        [
          distPath,
          'learn',
          'git',
          fixtureRepo,
          '--config',
          configPath,
          '--project',
          '--json',
          '--no-tui',
        ],
        isolatedCwd,
        {
          OPENAI_API_KEY: 'test-openai-key',
        }
      );
      expectSuccess(
        learn,
        'dist/nya learn git <repo> --config <offline-config> --project --json --no-tui'
      );

      const result = JSON.parse(learn.stdout) as {
        documentsIndexed: number;
        chunksIndexed: number;
      };
      expect(result.documentsIndexed).toBe(1);
      expect(result.chunksIndexed).toBeGreaterThan(0);
      expect(embeddingRequests).toBeGreaterThan(0);
      expect(learn.stderr).not.toContain(
        'Loadble extension for sqlite-vec not found'
      );

      const projectDb = await stat(
        join(isolatedCwd, '.nya-cli', 'index.sqlite')
      );
      expect(projectDb.isFile()).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
