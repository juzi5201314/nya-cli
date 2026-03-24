import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

type PackageJson = {
  scripts?: Record<string, string>;
};

describe('ci script', () => {
  test('runs the offline local gate without smoke or eval steps', async () => {
    const packageJsonText = await readFile(
      new URL('../package.json', import.meta.url),
      'utf8'
    );
    const packageJson = JSON.parse(packageJsonText) as PackageJson;

    expect(packageJson.scripts?.check).toBe(
      'bun run typecheck && biome check .'
    );
    expect(packageJson.scripts?.test).toBe('bun test');
    expect(packageJson.scripts?.ci).toBe('bun run check && bun test');
    expect(packageJson.scripts?.ci?.includes('smoke')).toBe(false);
    expect(packageJson.scripts?.ci?.includes('eval:perf')).toBe(false);
  });
});
