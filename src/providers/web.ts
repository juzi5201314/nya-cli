import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

import type { AppConfig } from '../types/config';
import type {
  WebFetchedPage,
  WebIngestProvider,
  WebSearchProvider,
  WebSearchResult,
} from './types';

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量: ${name}`);
  }
  return value;
}

class TavilyWebSearchProvider implements WebSearchProvider {
  readonly id = 'tavily' as const;

  constructor(private readonly config: AppConfig) {}

  async search(query: string): Promise<WebSearchResult[]> {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readRequiredEnv(
          this.config.web.search.providers.tavily.api_key_env
        )}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        topic: this.config.web.search.providers.tavily.default_topic,
        search_depth:
          this.config.web.search.providers.tavily.default_search_depth,
        include_answer: false,
        include_raw_content: false,
        include_usage: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Tavily 请求失败 (${response.status}): ${body}`);
    }

    const json = (await response.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        score?: number;
      }>;
    };

    return (json.results ?? []).map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      content: item.content ?? '',
      score: item.score,
    }));
  }
}

type ScraplingMode = 'get' | 'fetch';

function toAbsoluteUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function extractPageFromHtml(args: {
  requestedUrl: string;
  html: string;
  minMarkdownChars: number;
  mode: ScraplingMode;
}): WebFetchedPage {
  const { document } = parseHTML(args.html);
  const readability = new Readability(document).parse();
  const html = readability?.content ?? document.body?.innerHTML ?? '';
  const turndown = new TurndownService();
  const markdown = turndown.turndown(html).trim();

  if (markdown.length < args.minMarkdownChars) {
    throw new Error(
      `正文提取内容过短 (${markdown.length} chars), fetch mode=${args.mode}`
    );
  }

  const title =
    readability?.title?.trim() ||
    document.title?.trim() ||
    new URL(args.requestedUrl).toString();
  const canonicalHref = document
    .querySelector('link[rel="canonical"]')
    ?.getAttribute('href');
  const canonicalUrl = canonicalHref
    ? toAbsoluteUrl(canonicalHref, args.requestedUrl)
    : null;
  const links = [...document.querySelectorAll('a[href]')]
    .map((element) => element.getAttribute('href'))
    .filter((value): value is string => Boolean(value))
    .map((value) => toAbsoluteUrl(value, args.requestedUrl))
    .filter((value): value is string => Boolean(value));

  return {
    requestedUrl: args.requestedUrl,
    finalUrl: canonicalUrl ?? args.requestedUrl,
    title,
    canonicalUrl,
    markdown,
    html: args.html,
    links,
    fetchModeUsed: args.mode,
  };
}

async function runScraplingCommand(args: {
  command: string;
  mode: ScraplingMode;
  url: string;
  config: AppConfig['web']['ingest']['providers']['scrapling'];
}): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'nya-cli-scrapling-'));
  const outputPath = join(tempDir, `${basename(args.url) || 'page'}.html`);
  const cmd =
    args.mode === 'get'
      ? [
          args.command,
          'extract',
          'get',
          args.url,
          outputPath,
          '--timeout',
          String(args.config.get_timeout_seconds),
        ]
      : [
          args.command,
          'extract',
          'fetch',
          args.url,
          outputPath,
          '--timeout',
          String(args.config.fetch_timeout_ms),
          '--wait',
          String(args.config.fetch_wait_ms),
          '--headless',
          '--disable-resources',
        ];

  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    await rm(tempDir, { recursive: true, force: true });
    throw new Error(
      `scrapling ${args.mode} 失败 (${exitCode}): ${stderr.trim() || stdout.trim()}`
    );
  }

  const html = await readFile(outputPath, 'utf8');
  await rm(tempDir, { recursive: true, force: true });
  return html;
}

class ScraplingWebIngestProvider implements WebIngestProvider {
  readonly id = 'scrapling' as const;

  constructor(private readonly config: AppConfig) {}

  async assertAvailable(): Promise<void> {
    const command = this.config.web.ingest.providers.scrapling.command;
    const proc = Bun.spawn([command, '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `未检测到可用的 scrapling CLI。请先安装 Scrapling CLI。输出: ${stderr.trim() || stdout.trim()}`
      );
    }
  }

  async fetchPage(
    url: string,
    options: {
      fetchMode: AppConfig['web']['ingest']['providers']['scrapling']['default_fetch_mode'];
    }
  ): Promise<WebFetchedPage> {
    await this.assertAvailable();

    const scraplingConfig = this.config.web.ingest.providers.scrapling;
    const tryMode = async (mode: ScraplingMode, minMarkdownChars: number) => {
      const html = await runScraplingCommand({
        command: scraplingConfig.command,
        mode,
        url,
        config: scraplingConfig,
      });

      return extractPageFromHtml({
        requestedUrl: url,
        html,
        minMarkdownChars,
        mode,
      });
    };

    if (options.fetchMode === 'get') {
      return tryMode('get', 1);
    }

    if (options.fetchMode === 'fetch') {
      return tryMode('fetch', 1);
    }

    let getPage: WebFetchedPage | null = null;
    try {
      getPage = await tryMode('get', scraplingConfig.min_markdown_chars);
      return getPage;
    } catch (error) {
      try {
        return await tryMode('fetch', 1);
      } catch {
        if (getPage) {
          return getPage;
        }

        try {
          return await tryMode('get', 1);
        } catch {
          throw error;
        }
      }
    }
  }
}

export function createWebSearchProvider(config: AppConfig): WebSearchProvider {
  switch (config.web.search.provider) {
    case 'tavily':
      return new TavilyWebSearchProvider(config);
  }
}

export function createWebIngestProvider(config: AppConfig): WebIngestProvider {
  switch (config.web.ingest.provider) {
    case 'scrapling':
      return new ScraplingWebIngestProvider(config);
  }
}
