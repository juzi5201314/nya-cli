import { runEvalPerfCheck } from '../src/commands/eval-perf';
import { printOutput } from '../src/commands/shared';

function parseArgs(argv: string[]) {
  let baselinePath: string | undefined;
  let checkTimings = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--baseline') {
      baselinePath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--check-timings') {
      checkTimings = true;
    }
  }

  return {
    baselinePath,
    checkTimings,
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runEvalPerfCheck(options);
    printOutput(result, true);

    if (result.status === 'failed') {
      process.exitCode = 1;
    }
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
