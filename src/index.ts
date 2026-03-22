import { createCli } from './cli/app';
import { redactText } from './utils/redaction';

const cli = createCli();

try {
  cli.parse(process.argv, {
    run: false,
  });
  await cli.runMatchedCommand();
} catch (error) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error);
  console.error(redactText(message));
  process.exitCode = 1;
}
