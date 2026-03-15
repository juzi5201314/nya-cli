import type {
  ProgressReporter,
  ProgressTask,
  TokenTotals,
  TokenUsage,
} from './types';

type TaskModel = {
  id: number;
  label: string;
  total: number;
  value: number;
  done: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatBar(args: {
  width: number;
  value: number;
  total: number;
}): string {
  const width = Math.max(10, args.width);
  const total = Math.max(1, args.total);
  const ratio = clamp(args.value / total, 0, 1);
  const filled = Math.round(ratio * width);
  return `${'='.repeat(filled)}${'-'.repeat(Math.max(0, width - filled))}`;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

export async function createInkProgressReporter(args: {
  enabled: boolean;
}): Promise<ProgressReporter> {
  if (!args.enabled) {
    const { noopProgressReporter } = await import('./types');
    return noopProgressReporter;
  }

  // 动态 import：确保在 --json / --no-tui 时完全不加载 TUI 依赖。
  const React = await import('react');
  const Ink = await import('ink');

  const tasks: TaskModel[] = [];
  let nextId = 1;
  const tokens: TokenTotals = {
    embeddingTokens: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
    llmTotalTokens: 0,
    estimated: false,
  };

  const ProgressView = (props: { tasks: TaskModel[] }) => {
    const { Box, Text } = Ink;

    const total = tokens.embeddingTokens + tokens.llmTotalTokens;
    const prefix = tokens.estimated ? 'tokens~' : 'tokens';
    const tokenLine = `${prefix} total=${total} | embed=${tokens.embeddingTokens} | llm=${tokens.llmTotalTokens} (in=${tokens.llmInputTokens}, out=${tokens.llmOutputTokens})`;
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      ...props.tasks.map((task) => {
        const total = Math.max(1, task.total);
        const value = clamp(task.value, 0, total);
        const percentage = Math.floor((value / total) * 100);
        const bar = formatBar({ width: 28, value, total });
        const status = task.done ? 'done' : 'run';

        return React.createElement(
          Box,
          { key: task.id, flexDirection: 'row' },
          React.createElement(
            Text,
            { color: task.done ? 'green' : 'cyan' },
            `[${status}] `
          ),
          React.createElement(Text, null, `${bar} `),
          React.createElement(Text, null, `${percentage}% `),
          React.createElement(Text, null, `${value}/${total} `),
          React.createElement(Text, null, truncate(task.label, 48))
        );
      }),
      React.createElement(Text, { color: 'gray' }, tokenLine)
    );
  };

  const app = Ink.render(React.createElement(ProgressView, { tasks }), {
    stdout: process.stderr,
    stderr: process.stderr,
    exitOnCtrlC: true,
  });

  function rerender() {
    app.rerender(React.createElement(ProgressView, { tasks: [...tasks] }));
  }

  const reporter: ProgressReporter = {
    enabled: true,
    task(label: string, total: number): ProgressTask {
      const model: TaskModel = {
        id: nextId++,
        label,
        total: Math.max(1, Math.floor(total)),
        value: 0,
        done: false,
      };
      tasks.push(model);
      rerender();

      return {
        update(value: number) {
          model.value = clamp(Math.floor(value), 0, model.total);
          rerender();
        },
        increment(delta = 1) {
          model.value = clamp(model.value + Math.floor(delta), 0, model.total);
          rerender();
        },
        stop() {
          model.value = model.total;
          model.done = true;
          rerender();
        },
      };
    },
    addEmbeddingTokens(value: number, estimated: boolean) {
      const next = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      tokens.embeddingTokens += next;
      tokens.estimated = tokens.estimated || estimated;
      rerender();
    },
    addLlmUsage(usage: TokenUsage, estimated: boolean) {
      const input = usage.inputTokens ?? 0;
      const output = usage.outputTokens ?? 0;
      const total = usage.totalTokens ?? input + output;
      if (Number.isFinite(input)) {
        tokens.llmInputTokens += Math.max(0, Math.floor(input));
      }
      if (Number.isFinite(output)) {
        tokens.llmOutputTokens += Math.max(0, Math.floor(output));
      }
      if (Number.isFinite(total)) {
        tokens.llmTotalTokens += Math.max(0, Math.floor(total));
      }
      tokens.estimated = tokens.estimated || estimated;
      rerender();
    },
    getTokenTotals() {
      return { ...tokens };
    },
    stopAll() {
      try {
        app.unmount();
      } catch {
        // ignore
      }
    },
  };

  return reporter;
}
