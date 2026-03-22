import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const separatorIndex = trimmed.indexOf('=');
  if (separatorIndex <= 0) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  let value = trimmed.slice(separatorIndex + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return {
    key,
    value,
  };
}

async function readEnvFileFromPath(
  envPath: string
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  if (!existsSync(envPath)) {
    return env;
  }

  const raw = await readFile(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      continue;
    }

    if (env[parsed.key] !== undefined) {
      continue;
    }

    env[parsed.key] = parsed.value;
  }

  return env;
}

export async function readEnvFile(
  envPath: string
): Promise<Record<string, string>> {
  return readEnvFileFromPath(envPath);
}

export async function loadProjectEnv(configPath?: string): Promise<void> {
  const candidates = new Set<string>();

  candidates.add(resolve(process.cwd(), '.env'));

  if (configPath) {
    candidates.add(resolve(dirname(configPath), '.env'));
  }

  for (const envPath of candidates) {
    const loaded = await readEnvFileFromPath(envPath);
    for (const [key, value] of Object.entries(loaded)) {
      if (process.env[key] !== undefined) {
        continue;
      }

      process.env[key] = value;
    }
  }
}
