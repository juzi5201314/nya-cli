import { createCli } from './cli/app';

const cli = createCli();

cli.parse(process.argv, {
  run: false,
});
await cli.runMatchedCommand();
