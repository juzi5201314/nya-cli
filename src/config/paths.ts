import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import envPaths from 'env-paths';

import type { ScopeMode } from '../types/config';

export type ScopePaths = {
  scope: ScopeMode;
  projectDirName: string;
  databasePath: string;
  databaseDir: string;
  remoteCacheDir: string;
};

const APP_NAME = 'nya-cli';

export async function resolveScopePaths(args: {
  scope: ScopeMode;
  cwd?: string;
  projectDirName: string;
  ensureDirectories?: boolean;
}): Promise<ScopePaths> {
  const cwd = args.cwd ?? process.cwd();
  const globalPaths = envPaths(APP_NAME);
  const remoteCacheDir = join(globalPaths.cache, 'repos');

  const scopeDir =
    args.scope === 'project'
      ? resolve(cwd, args.projectDirName)
      : globalPaths.data;

  if (args.ensureDirectories !== false) {
    await mkdir(scopeDir, { recursive: true });
    await mkdir(remoteCacheDir, { recursive: true });
  }

  return {
    scope: args.scope,
    projectDirName: args.projectDirName,
    databaseDir: scopeDir,
    databasePath: join(scopeDir, 'index.sqlite'),
    remoteCacheDir,
  };
}
