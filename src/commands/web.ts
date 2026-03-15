import { loadConfig } from '../config/load-config';
import { createWebSearchProvider } from '../providers/web';
import { printOutput } from './shared';

export async function runWebSearch(args: {
  query: string;
  configPath: string | undefined;
  asJson: boolean;
}): Promise<void> {
  const { config } = await loadConfig(args.configPath);
  const provider = createWebSearchProvider(config);
  const results = await provider.search(args.query);

  if (args.asJson) {
    printOutput(
      {
        query: args.query,
        provider: provider.id,
        results,
      },
      true
    );
    return;
  }

  if (results.length === 0) {
    printOutput(
      `query: ${args.query}\nprovider: ${provider.id}\nresults: 0`,
      false
    );
    return;
  }

  const lines = [
    `query: ${args.query}`,
    `provider: ${provider.id}`,
    `results: ${results.length}`,
    '',
  ];
  for (const [index, item] of results.entries()) {
    lines.push(`[${index + 1}] ${item.title || item.url}`);
    lines.push(`url: ${item.url}`);
    lines.push(`score: ${item.score ?? 0}`);
    lines.push(`content: ${item.content}`);
    lines.push('');
  }
  printOutput(lines.join('\n'), false);
}
