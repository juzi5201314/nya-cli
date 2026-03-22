import { describe, expect, test } from 'bun:test';

import { runSmokeGoogle } from '../src/commands/smoke-google';

function commandText(command: string[]): string {
  return command.join(' ');
}

describe('smoke:google', () => {
  test('short-circuits with skipped when GOOGLE_GENERATIVE_AI_API_KEY is missing', async () => {
    let called = false;

    const result = await runSmokeGoogle({
      env: {},
      runner: async () => {
        called = true;
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
        };
      },
    });

    expect(called).toBe(false);
    expect(result).toEqual({
      status: 'skipped',
      reason: 'GOOGLE_GENERATIVE_AI_API_KEY missing',
    });
  });

  test('runs learn → search → ai-search with strict caps and reports counts', async () => {
    const commands: string[][] = [];

    const result = await runSmokeGoogle({
      env: {
        GOOGLE_GENERATIVE_AI_API_KEY: 'fake-google-api-key',
      },
      runner: async ({ command }) => {
        commands.push(command);
        const rendered = commandText(command);

        if (rendered.includes(' learn ')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              documentsIndexed: 1,
              chunksIndexed: 1,
              skippedSymlinks: 0,
            }),
            stderr: '',
          };
        }

        if (rendered.includes(' search ')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              results: [{ chunkId: 1 }],
            }),
            stderr: '',
          };
        }

        if (rendered.includes(' ai-search ')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              iterations: 1,
              usedQueries: ['What flow does the smoke repository validate?'],
              evidence: [{ evidenceId: 1 }],
              citations: [{ evidenceId: 1 }],
              structuredOutputFallbackUsed: false,
            }),
            stderr: '',
          };
        }

        throw new Error(`unexpected command: ${rendered}`);
      },
    });

    expect(result).toEqual({
      status: 'passed',
      limits: {
        searchLimit: 1,
        aiSearch: {
          maxSteps: 1,
          maxQueries: 1,
          maxEvidence: 1,
        },
      },
      counts: {
        commands: {
          learn: 1,
          search: 1,
          aiSearch: 1,
          total: 3,
        },
        learn: {
          documentsIndexed: 1,
          chunksIndexed: 1,
          skippedSymlinks: 0,
        },
        search: {
          results: 1,
        },
        aiSearch: {
          iterations: 1,
          usedQueries: 1,
          evidence: 1,
          citations: 1,
          llmRequests: 2,
          structuredOutputFallbackUsed: false,
        },
      },
    });

    expect(commands).toHaveLength(3);
    expect(commandText(commands[0] ?? [])).toContain('learn git');
    expect(commandText(commands[0] ?? [])).toContain('--project');
    expect(commandText(commands[0] ?? [])).toContain('--json');
    expect(commandText(commands[0] ?? [])).toContain('--no-tui');
    expect(commandText(commands[1] ?? [])).toContain('search');
    expect(commandText(commands[1] ?? [])).toContain('--limit 1');
    expect(commandText(commands[2] ?? [])).toContain('ai-search');
    expect(commandText(commands[2] ?? [])).toContain('--max-steps 1');
    expect(commandText(commands[2] ?? [])).toContain('--max-queries 1');
    expect(commandText(commands[2] ?? [])).toContain('--max-evidence 1');
  });

  test('fails when captured command output contains the literal api key', async () => {
    await expect(
      runSmokeGoogle({
        env: {
          GOOGLE_GENERATIVE_AI_API_KEY: 'leaky-google-key',
        },
        runner: async ({ command }) => {
          const rendered = commandText(command);

          if (rendered.includes(' learn ')) {
            return {
              exitCode: 0,
              stdout: 'leaky-google-key',
              stderr: '',
            };
          }

          return {
            exitCode: 0,
            stdout: JSON.stringify({
              results: [{ chunkId: 1 }],
              iterations: 1,
              usedQueries: ['x'],
              evidence: [{ evidenceId: 1 }],
              citations: [{ evidenceId: 1 }],
              structuredOutputFallbackUsed: false,
            }),
            stderr: '',
          };
        },
      })
    ).rejects.toThrow(
      'Smoke output leaked the Google API key value in learn stdout.'
    );
  });
});
