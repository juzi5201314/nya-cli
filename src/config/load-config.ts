import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AppConfig } from '../types/config';
import { appConfigSchema } from './schema';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export async function resolveConfigPath(inputPath?: string): Promise<string> {
  if (inputPath) {
    const resolved = resolve(inputPath);
    if (!existsSync(resolved)) {
      throw new ConfigError(`配置文件不存在: ${resolved}`);
    }
    return resolved;
  }

  const fallback = resolve(process.cwd(), 'nya.toml');
  if (!existsSync(fallback)) {
    throw new ConfigError(
      '未找到 nya.toml。请在当前目录提供配置文件，或使用 --config 指定路径。'
    );
  }
  return fallback;
}

export async function loadConfig(inputPath?: string): Promise<{
  config: AppConfig;
  path: string;
}> {
  const path = await resolveConfigPath(inputPath);
  const raw = await readFile(path, 'utf8');
  const parsed = Bun.TOML.parse(raw);
  const result = appConfigSchema.safeParse(parsed);

  if (!result.success) {
    throw new ConfigError(
      `配置文件校验失败:\n${result.error.issues
        .map((issue) => `- ${issue.path.join('.')} ${issue.message}`)
        .join('\n')}`
    );
  }

  return {
    config: result.data,
    path,
  };
}
