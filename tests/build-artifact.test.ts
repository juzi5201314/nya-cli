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

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runCommand(args: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn(args, {
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

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('build artifact verification', () => {
  test('build produces a runnable dist artifact with required tree-sitter assets', async () => {
    await mkdir(tempRoot, { recursive: true });

    const build = await runCommand(['bun', 'run', 'build'], repoRoot);
    expectSuccess(build, 'bun run build');

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
});
