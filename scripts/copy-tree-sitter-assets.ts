import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const distDir = resolve(process.cwd(), 'dist', 'tree-sitter');
const sources = [
  resolve(
    process.cwd(),
    'node_modules',
    'web-tree-sitter',
    'web-tree-sitter.wasm'
  ),
];
const grammarDir = resolve(
  process.cwd(),
  'node_modules',
  '@repomix',
  'tree-sitter-wasms',
  'out'
);

async function main(): Promise<void> {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  for (const source of sources) {
    const target = resolve(distDir, source.split('/').at(-1) ?? 'asset.wasm');
    await copyFile(source, target);
  }

  const grammarFiles = await readdir(grammarDir);
  for (const file of grammarFiles) {
    if (!file.endsWith('.wasm')) {
      continue;
    }

    await copyFile(resolve(grammarDir, file), resolve(distDir, file));
  }
}

await main();
