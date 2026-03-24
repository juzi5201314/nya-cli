import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SQLITE_VEC_BASE_PACKAGE_NAME = 'sqlite-vec';
const SQLITE_VEC_ENTRYPOINT_BASE_NAME = 'vec0';

const SUPPORTED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
]);

function getRuntimeDirectory(): string | null {
  const entry = process.argv[1];
  if (!entry) {
    return null;
  }

  return dirname(resolve(entry));
}

function isDistRuntime(runtimeDir: string | null): boolean {
  return runtimeDir !== null && basename(runtimeDir) === 'dist';
}

function getPlatformPackageName(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return `${SQLITE_VEC_BASE_PACKAGE_NAME}-${os}-${process.arch}`;
}

function getLoadableFilename(): string {
  if (process.platform === 'win32') {
    return `${SQLITE_VEC_ENTRYPOINT_BASE_NAME}.dll`;
  }
  if (process.platform === 'darwin') {
    return `${SQLITE_VEC_ENTRYPOINT_BASE_NAME}.dylib`;
  }

  return `${SQLITE_VEC_ENTRYPOINT_BASE_NAME}.so`;
}

function assertSupportedPlatform(): void {
  const platformKey = `${process.platform}-${process.arch}`;
  if (SUPPORTED_PLATFORMS.has(platformKey)) {
    return;
  }

  throw new Error(
    `Unsupported platform for ${SQLITE_VEC_BASE_PACKAGE_NAME}, on a ${process.platform}-${process.arch} machine.`
  );
}

export function resolveSqliteVecLoadablePath(): string {
  assertSupportedPlatform();

  const runtimeDir = getRuntimeDirectory();
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const packageName = getPlatformPackageName();
  const filename = getLoadableFilename();
  let candidates: string[];
  if (runtimeDir !== null && isDistRuntime(runtimeDir)) {
    candidates = [resolve(runtimeDir, 'sqlite-vec', packageName, filename)];
  } else {
    candidates = [
      ...(runtimeDir
        ? [
            resolve(
              runtimeDir,
              '..',
              'dist',
              'sqlite-vec',
              packageName,
              filename
            ),
          ]
        : []),
      resolve(
        moduleDir,
        '..',
        '..',
        'dist',
        'sqlite-vec',
        packageName,
        filename
      ),
      resolve(moduleDir, '..', '..', 'node_modules', packageName, filename),
      resolve(process.cwd(), 'dist', 'sqlite-vec', packageName, filename),
      resolve(process.cwd(), 'node_modules', packageName, filename),
    ];
  }

  const matchedPath = candidates.find((candidate) => existsSync(candidate));
  if (!matchedPath) {
    throw new Error(
      `Loadble extension for ${SQLITE_VEC_BASE_PACKAGE_NAME} not found. Was the ${packageName} package installed?`
    );
  }

  return matchedPath;
}

export function loadSqliteVec(db: Database): void {
  // dist 单文件运行时不能依赖 sqlite-vec 包内的 import.meta.url 解析，
  // 这里显式优先查找 dist/ 下复制出的原生扩展。
  db.loadExtension(resolveSqliteVecLoadablePath());
}
