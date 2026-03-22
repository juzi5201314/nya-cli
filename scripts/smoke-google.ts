import { printOutput } from '../src/commands/shared';
import { runSmokeGoogle } from '../src/commands/smoke-google';

async function main() {
  try {
    const result = await runSmokeGoogle();
    printOutput(result, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify(
        {
          status: 'failed',
          error: message,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}

void main();
