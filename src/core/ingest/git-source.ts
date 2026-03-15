import { stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import type { ScopePaths } from '../../config/paths';
import type { AppConfig } from '../../types/config';
import { sha256 } from '../../utils/hash';

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
  '.lock',
]);

const SKIP_PATH_PATTERNS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/coverage/',
  '/.git/',
  '/vendor/',
  '/target/',
];

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
  const normalized = url.trim();
  const cachePath = resolve(paths.remoteCacheDir, sha256(normalized));

  try {
    await stat(cachePath);
    await runGit(['-C', cachePath, 'remote', 'set-url', 'origin', normalized]);
    await runGit(['-C', cachePath, 'fetch', '--depth=1', 'origin', 'HEAD']);
    await runGit(['-C', cachePath, 'reset', '--hard', 'FETCH_HEAD']);
    return cachePath;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code &&
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      throw error;
    }
    await runGit(['clone', '--depth=1', normalized, cachePath]);
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
  const normalized = `/${relativePath.replaceAll('\\', '/')}`;
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  return SKIP_PATH_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export async function resolveGitSource(args: {
  source: string;
  paths: ScopePaths;
}): Promise<ResolvedGitSource> {
  if (isRemoteSource(args.source)) {
    const repoRoot = await ensureRemoteCache(args.source, args.paths);
    return {
      sourceKind: 'remote_git',
      sourceKey: args.source,
      sourceLocator: args.source,
      repoRoot,
      repoUrl: args.source,
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
}): Promise<RepoFile[]> {
  const raw = await runGit(['-C', args.source.repoRoot, 'ls-files', '-z']);
  const files = raw.split('\0').filter(Boolean);
  const result: RepoFile[] = [];

  for (const relativePath of files) {
    const ext = extname(relativePath).toLowerCase();
    if (shouldSkipFile(relativePath, ext)) {
      continue;
    }

    const absolutePath = resolve(args.source.repoRoot, relativePath);
    const fileStat = await stat(absolutePath);
    if (fileStat.size > args.config.index.max_file_bytes) {
      continue;
    }

    const file = Bun.file(absolutePath);
    const bytes = await file.bytes();
    if (bytes.includes(0)) {
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

  return result;
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
