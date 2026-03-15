import { describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveScopePaths } from '../src/config/paths';

describe('scope paths', () => {
  test('uses project database under cwd when --project is set', async () => {
    const cwd = '/tmp/nya-cli-scope-test';
    process.env.XDG_DATA_HOME = '/tmp/nya-cli-xdg-data';
    process.env.XDG_CACHE_HOME = '/tmp/nya-cli-xdg-cache';
    await mkdir(process.env.XDG_DATA_HOME, { recursive: true });
    await mkdir(process.env.XDG_CACHE_HOME, { recursive: true });

    const result = await resolveScopePaths({
      scope: 'project',
      cwd,
      projectDirName: '.nya-cli',
    });

    expect(result.databasePath).toBe(join(cwd, '.nya-cli', 'index.sqlite'));
    expect(result.remoteCacheDir).toContain('nya-cli');
  });
});
