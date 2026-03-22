import { lstat, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import type { ScopePaths } from '../../config/paths';
import type { AppConfig } from '../../types/config';
import { sha256 } from '../../utils/hash';
import { normalizeLocatorForNetwork } from '../../utils/redaction';

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.mp3',
  '.mp4',
  '.mov',
  '.wav',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.so',
  '.dll',
  '.dylib',
  '.exe',
  '.bin',
  '.class',
  '.jar',
  '.wasm',
  '.sqlite',
  '.db',
  '.lock',
]);

const SKIP_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  '.next',
  '.nuxt',
  '.parcel-cache',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'vendor',
  'target',
  'out',
  'tmp',
  'temp',
]);

const SKIP_FILE_NAMES = new Set([
  '.ds_store',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

export type ResolvedGitSource =
  | {
      sourceKind: 'local_git';
      sourceKey: string;
      sourceLocator: string;
      repoRoot: string;
      repoUrl: null;
      workingPath: string;
    }
  | {
      sourceKind: 'remote_git';
      sourceKey: string;
      sourceLocator: string;
      repoRoot: string;
      repoUrl: string;
      workingPath: string;
    };

export type RepoFile = {
  relativePath: string;
  absolutePath: string;
  language: string;
  title: string;
  content: string;
};

export type ReadRepositoryFilesResult = {
  files: RepoFile[];
  skippedSymlinks: number;
};

function isRemoteSource(source: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@|file:\/\/|git:\/\/)/.test(source);
}

async function runGit(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    ...(cwd ? { cwd } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} 失败 (${exitCode}): ${stderr.trim() || stdout.trim()}`
    );
  }

  return stdout.trim();
}

async function ensureRemoteCache(
  url: string,
  paths: ScopePaths
): Promise<string> {
  const sourceUrl = url.trim();
  const networkSafeUrl = normalizeLocatorForNetwork(sourceUrl);
  const cachePath = resolve(paths.remoteCacheDir, sha256(networkSafeUrl));

  try {
    await stat(cachePath);
    await runGit([
      '-C',
      cachePath,
      'fetch',
      '--depth=1',
      networkSafeUrl,
      'HEAD',
    ]);
    await runGit(['-C', cachePath, 'reset', '--hard', 'FETCH_HEAD']);
    await runGit([
      '-C',
      cachePath,
      'remote',
      'set-url',
      'origin',
      networkSafeUrl,
    ]);
    return cachePath;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code &&
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      throw error;
    }
    await runGit(['clone', '--depth=1', networkSafeUrl, cachePath]);
    await runGit([
      '-C',
      cachePath,
      'remote',
      'set-url',
      'origin',
      networkSafeUrl,
    ]);
    return cachePath;
  }
}

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mapping: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.json': 'json',
    '.rs': 'rust',
    '.py': 'python',
    '.go': 'go',
    '.md': 'markdown',
    '.mdx': 'markdown',
    '.toml': 'toml',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.sh': 'shell',
    '.bash': 'shell',
    '.zsh': 'shell',
    '.txt': 'text',
  };
  return mapping[ext] ?? (ext ? ext.slice(1) : 'text');
}

function shouldSkipFile(relativePath: string, ext: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  const segments = normalized
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const fileName = segments.at(-1)?.toLowerCase() ?? '';

  if (SKIP_FILE_NAMES.has(fileName)) {
    return true;
  }

  return segments.some((segment) =>
    SKIP_DIRECTORY_NAMES.has(segment.toLowerCase())
  );
}

function isBinaryContent(bytes: Uint8Array): boolean {
  if (bytes.length === 0) {
    return false;
  }

  const sample = bytes.slice(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) {
    return true;
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
  } catch {
    return true;
  }

  let suspiciousBytes = 0;
  for (const byte of sample) {
    const isAllowedControl =
      byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 27;
    const isControl = (byte >= 0 && byte < 32) || byte === 127;
    if (isControl && !isAllowedControl) {
      suspiciousBytes += 1;
    }
  }

  return suspiciousBytes / sample.length > 0.1;
}

export async function resolveGitSource(args: {
  source: string;
  paths: ScopePaths;
}): Promise<ResolvedGitSource> {
  if (isRemoteSource(args.source)) {
    const redactedSource = normalizeLocatorForNetwork(args.source);
    const repoRoot = await ensureRemoteCache(args.source, args.paths);
    return {
      sourceKind: 'remote_git',
      sourceKey: redactedSource,
      sourceLocator: redactedSource,
      repoRoot,
      repoUrl: redactedSource,
      workingPath: repoRoot,
    };
  }

  const absolutePath = isAbsolute(args.source)
    ? args.source
    : resolve(process.cwd(), args.source);
  const repoRoot = await runGit([
    '-C',
    absolutePath,
    'rev-parse',
    '--show-toplevel',
  ]);

  return {
    sourceKind: 'local_git',
    sourceKey: repoRoot,
    sourceLocator: absolutePath,
    repoRoot,
    repoUrl: null,
    workingPath: absolutePath,
  };
}

export async function readRepositoryFiles(args: {
  source: ResolvedGitSource;
  config: AppConfig;
}): Promise<ReadRepositoryFilesResult> {
  const raw = await runGit(['-C', args.source.repoRoot, 'ls-files', '-z']);
  const files = raw.split('\0').filter(Boolean);
  const result: RepoFile[] = [];
  let skippedSymlinks = 0;

  for (const relativePath of files) {
    const absolutePath = resolve(args.source.repoRoot, relativePath);
    const fileStat = await lstat(absolutePath);
    if (fileStat.isSymbolicLink()) {
      skippedSymlinks += 1;
      continue;
    }

    const ext = extname(relativePath).toLowerCase();
    if (shouldSkipFile(relativePath, ext)) {
      continue;
    }

    if (fileStat.size > args.config.index.max_file_bytes) {
      continue;
    }

    const file = Bun.file(absolutePath);
    const bytes = await file.bytes();
    if (isBinaryContent(bytes)) {
      continue;
    }

    const content = await file.text();
    if (!content.trim()) {
      continue;
    }

    result.push({
      relativePath,
      absolutePath,
      language: detectLanguage(relativePath),
      title: basename(relativePath),
      content,
    });
  }

  return {
    files: result,
    skippedSymlinks,
  };
}

export function getDisplayedPath(
  source: ResolvedGitSource,
  relativePath: string
): string {
  if (source.sourceKind === 'remote_git') {
    return relativePath;
  }

  return relative(source.repoRoot, resolve(source.repoRoot, relativePath));
}

export function getGitSourceProviderId(source: ResolvedGitSource): string {
  return source.sourceKind === 'remote_git' ? 'git-remote' : 'git-local';
}
