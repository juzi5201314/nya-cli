import { runEvalPerf } from '../src/commands/eval-perf';
import { printOutput } from '../src/commands/shared';

async function main() {
  try {
    const result = await runEvalPerf();
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
