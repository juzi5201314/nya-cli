import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';

const executablePath = resolve(process.cwd(), 'dist', 'nya');
const treeSitterDistDir = resolve(process.cwd(), 'dist', 'tree-sitter');
const bunShebang = '#!/usr/bin/env bun\n';
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

function getSqliteVecPackageName(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return `sqlite-vec-${os}-${process.arch}`;
}

function getSqliteVecFilename(): string {
  if (process.platform === 'win32') {
    return 'vec0.dll';
  }
  if (process.platform === 'darwin') {
    return 'vec0.dylib';
  }

  return 'vec0.so';
}

async function main(): Promise<void> {
  const executableContents = await readFile(executablePath, 'utf8');
  if (!executableContents.startsWith(bunShebang)) {
    await writeFile(executablePath, `${bunShebang}${executableContents}`);
  }

  await chmod(executablePath, 0o755);
  await rm(treeSitterDistDir, { recursive: true, force: true });
  await mkdir(treeSitterDistDir, { recursive: true });

  for (const source of sources) {
    const target = resolve(
      treeSitterDistDir,
      source.split('/').at(-1) ?? 'asset.wasm'
    );
    await copyFile(source, target);
  }

  const grammarFiles = await readdir(grammarDir);
  for (const file of grammarFiles) {
    if (!file.endsWith('.wasm')) {
      continue;
    }

    await copyFile(resolve(grammarDir, file), resolve(treeSitterDistDir, file));
  }

  const sqliteVecPackageName = getSqliteVecPackageName();
  const sqliteVecFilename = getSqliteVecFilename();
  const sqliteVecDistDir = resolve(
    process.cwd(),
    'dist',
    'sqlite-vec',
    sqliteVecPackageName
  );
  const sqliteVecSource = resolve(
    process.cwd(),
    'node_modules',
    sqliteVecPackageName,
    sqliteVecFilename
  );

  await rm(resolve(process.cwd(), 'dist', 'sqlite-vec'), {
    recursive: true,
    force: true,
  });
  await mkdir(sqliteVecDistDir, { recursive: true });
  await copyFile(sqliteVecSource, resolve(sqliteVecDistDir, sqliteVecFilename));
}

await main();
