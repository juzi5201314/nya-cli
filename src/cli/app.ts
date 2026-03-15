import { cac } from 'cac';

import { runAiSearch } from '../commands/ai-search';
import {
  runDbClear,
  runDbDoctor,
  runDbRebuild,
  runDbScope,
  runDbStats,
} from '../commands/db';
import { runLearnGit, runLearnWeb } from '../commands/learn';
import { runSearch } from '../commands/search';
import { requireDbScope } from '../commands/shared';
import { runWebSearch } from '../commands/web';
import type { WebFetchMode } from '../types/config';

type GlobalOptions = {
  config?: string;
  json?: boolean;
  project?: boolean;
  global?: boolean;
};

export function createCli() {
  const cli = cac('nya');

  cli
    .command('learn <kind> <source>', '学习本地或远程数据源')
    .option('--config <path>', '指定 nya.toml 路径')
    .option('--json', '以 JSON 输出结果')
    .option('--project', '使用当前项目作用域数据库')
    .option('--crawl', '启用多页 crawl')
    .option('--max-pages <number>', '最多抓取页数')
    .option('--max-depth <number>', '最大抓取深度')
    .option('--fetch-mode <mode>', '抓取模式: auto|get|fetch')
    .action(
      async (
        kind: string,
        source: string,
        options: GlobalOptions & {
          crawl?: boolean;
          maxPages?: string;
          maxDepth?: string;
          fetchMode?: string;
        }
      ) => {
        if (kind === 'git') {
          await runLearnGit({
            source,
            configPath: options.config,
            project: Boolean(options.project),
            asJson: Boolean(options.json),
          });
          return;
        }

        if (kind === 'web') {
          await runLearnWeb({
            source,
            configPath: options.config,
            project: Boolean(options.project),
            asJson: Boolean(options.json),
            crawl: Boolean(options.crawl),
            maxPages: options.maxPages
              ? Number.parseInt(options.maxPages, 10)
              : undefined,
            maxDepth: options.maxDepth
              ? Number.parseInt(options.maxDepth, 10)
              : undefined,
            fetchMode: options.fetchMode as WebFetchMode | undefined,
          });
          return;
        }

        throw new Error(`不支持的 learn 子命令: ${kind}`);
      }
    );

  cli
    .command('search <query>', '搜索本地知识库')
    .option('--config <path>', '指定 nya.toml 路径')
    .option('--json', '以 JSON 输出结果')
    .option('--project', '使用当前项目作用域数据库')
    .option('--limit <number>', '结果数量', {
      default: '8',
    })
    .action(
      async (query: string, options: GlobalOptions & { limit?: string }) => {
        await runSearch({
          query,
          configPath: options.config,
          project: Boolean(options.project),
          asJson: Boolean(options.json),
          limit: Number.parseInt(options.limit ?? '8', 10),
        });
      }
    );

  cli
    .command('ai-search <query>', '使用 LLM 驱动的自然语言搜索本地知识库')
    .option('--config <path>', '指定 nya.toml 路径')
    .option('--json', '以 JSON 输出结果')
    .option('--project', '使用当前项目作用域数据库')
    .option('--limit <number>', '每个检索 query 的结果数量', {
      default: '8',
    })
    .option('--max-steps <number>', '最多检索轮次')
    .option('--max-queries <number>', '每轮最多生成的 query 数量')
    .option('--max-evidence <number>', '最终保留的最大证据 chunk 数')
    .action(
      async (
        query: string,
        options: GlobalOptions & {
          limit?: string;
          maxSteps?: string;
          maxQueries?: string;
          maxEvidence?: string;
        }
      ) => {
        await runAiSearch({
          query,
          configPath: options.config,
          project: Boolean(options.project),
          asJson: Boolean(options.json),
          limit: Number.parseInt(options.limit ?? '8', 10),
          maxSteps: options.maxSteps
            ? Number.parseInt(options.maxSteps, 10)
            : undefined,
          maxQueries: options.maxQueries
            ? Number.parseInt(options.maxQueries, 10)
            : undefined,
          maxEvidence: options.maxEvidence
            ? Number.parseInt(options.maxEvidence, 10)
            : undefined,
        });
      }
    );

  cli
    .command('db <subcommand>', '数据库命令')
    .option('--config <path>', '指定 nya.toml 路径')
    .option('--json', '以 JSON 输出结果')
    .option('--project', '使用当前项目作用域数据库')
    .option('--global', '使用全局作用域数据库')
    .option('--yes', '确认危险操作')
    .option('--source <sourceKey>', '仅操作指定 source key')
    .option('--retry <number>', '每个 source 的额外重试次数', {
      default: '2',
    })
    .option('--fail-fast', '遇到失败 source 时立即停止重建')
    .option('--failed-only', '仅重试上次 rebuild 失败的 source')
    .action(
      async (
        subcommand: string,
        options: GlobalOptions & {
          source?: string;
          retry?: string;
          failFast?: boolean;
          failedOnly?: boolean;
          yes?: boolean;
        }
      ) => {
        const scope = requireDbScope(options.global, options.project);

        if (subcommand === 'stats') {
          await runDbStats({
            configPath: options.config,
            scope,
            asJson: Boolean(options.json),
          });
          return;
        }

        if (subcommand === 'doctor') {
          await runDbDoctor({
            configPath: options.config,
            scope,
            asJson: Boolean(options.json),
          });
          return;
        }

        if (subcommand === 'scope') {
          await runDbScope({
            configPath: options.config,
            scope,
            asJson: Boolean(options.json),
          });
          return;
        }

        if (subcommand === 'clear') {
          await runDbClear({
            configPath: options.config,
            scope,
            asJson: Boolean(options.json),
            yes: Boolean(options.yes),
          });
          return;
        }

        if (subcommand === 'rebuild') {
          await runDbRebuild({
            configPath: options.config,
            scope,
            asJson: Boolean(options.json),
            sourceKey: options.source,
            retryCount: Number.parseInt(options.retry ?? '2', 10),
            failFast: Boolean(options.failFast),
            failedOnly: Boolean(options.failedOnly),
          });
          return;
        }

        throw new Error(`不支持的 db 子命令: ${subcommand}`);
      }
    );

  cli
    .command('web <subcommand> <query>', '公网搜索命令')
    .option('--config <path>', '指定 nya.toml 路径')
    .option('--json', '以 JSON 输出结果')
    .action(
      async (subcommand: string, query: string, options: GlobalOptions) => {
        if (subcommand !== 'search') {
          throw new Error(`不支持的 web 子命令: ${subcommand}`);
        }

        await runWebSearch({
          query,
          configPath: options.config,
          asJson: Boolean(options.json),
        });
      }
    );

  cli.help();
  return cli;
}
