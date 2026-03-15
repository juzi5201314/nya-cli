import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

import type { AppConfig, WebFetchMode } from '../types/config';
import { createFetchWithPolicies } from '../utils/fetch';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.toString();
}

class TavilyWebSearchProvider implements WebSearchProvider {
  readonly id = 'tavily' as const;
  private readonly fetch;

  constructor(private readonly config: AppConfig) {
    const tavilyConfig = config.web.search.providers.tavily;
    this.fetch = createFetchWithPolicies({
      rateLimit: {
        rpm: tavilyConfig.rpm,
        tpm: tavilyConfig.tpm,
      },
      retry: {
        maxRetries: tavilyConfig.retry_max_retries,
        delayMs: tavilyConfig.retry_delay_seconds * 1000,
      },
    });
  }

  async search(query: string): Promise<WebSearchResult[]> {
    const response = await this.fetch('https://api.tavily.com/search', {
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
      fetchMode: WebFetchMode;
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

type CloudflareCrawlJobId = string;

type CloudflareCrawlStatus =
  | 'running'
  | 'cancelled_due_to_timeout'
  | 'cancelled_due_to_limits'
  | 'cancelled_by_user'
  | 'errored'
  | 'completed';

type CloudflareCrawlRecordStatus =
  | 'queued'
  | 'completed'
  | 'disallowed'
  | 'skipped'
  | 'errored'
  | 'cancelled';

type CloudflareCrawlRecord = {
  url?: string;
  status?: CloudflareCrawlRecordStatus;
  markdown?: string;
  metadata?: {
    status?: number;
    title?: string;
    url?: string;
  };
};

type CloudflareCrawlJobStatusResponse = {
  success?: boolean;
  result?: {
    id?: string;
    status?: CloudflareCrawlStatus;
  };
  errors?: unknown[];
};

type CloudflareCrawlJobRecordsResponse = {
  success?: boolean;
  result?: {
    id?: string;
    status?: CloudflareCrawlStatus;
    records?: CloudflareCrawlRecord[];
    cursor?: number | string;
    total?: number;
    finished?: number;
  };
  errors?: unknown[];
};

class CloudflareWebIngestProvider implements WebIngestProvider {
  readonly id = 'cloudflare' as const;
  private readonly fetch;

  constructor(private readonly config: AppConfig) {
    const cloudflareConfig = config.web.ingest.providers.cloudflare;
    this.fetch = createFetchWithPolicies({
      rateLimit: {
        rpm: cloudflareConfig.rpm,
        tpm: cloudflareConfig.tpm,
      },
      retry: {
        maxRetries: cloudflareConfig.retry_max_retries,
        delayMs: cloudflareConfig.retry_delay_seconds * 1000,
      },
    });
  }

  async assertAvailable(): Promise<void> {
    const cloudflareConfig = this.config.web.ingest.providers.cloudflare;
    if (!cloudflareConfig.account_id.trim()) {
      throw new Error(
        '缺少 Cloudflare account_id。请在 nya.toml 中配置 [web.ingest.providers.cloudflare].account_id'
      );
    }

    readRequiredEnv(cloudflareConfig.api_token_env);
  }

  private headers(): Record<string, string> {
    const cloudflareConfig = this.config.web.ingest.providers.cloudflare;
    return {
      Authorization: `Bearer ${readRequiredEnv(cloudflareConfig.api_token_env)}`,
      'Content-Type': 'application/json',
    };
  }

  private endpoint(path: string): string {
    const cloudflareConfig = this.config.web.ingest.providers.cloudflare;
    return `${cloudflareConfig.base_url.replace(/\/+$/, '')}${path}`;
  }

  private async startCrawlJob(args: {
    url: string;
    maxPages: number;
    maxDepth: number;
    render: boolean;
  }): Promise<CloudflareCrawlJobId> {
    const cloudflareConfig = this.config.web.ingest.providers.cloudflare;
    const accountId = cloudflareConfig.account_id.trim();

    const response = await this.fetch(
      this.endpoint(`/accounts/${accountId}/browser-rendering/crawl`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          url: args.url,
          limit: args.maxPages,
          depth: args.maxDepth,
          formats: ['markdown'],
          render: args.render,
          source: cloudflareConfig.source,
          options: {
            includeExternalLinks: cloudflareConfig.include_external_links,
            includeSubdomains: cloudflareConfig.include_subdomains,
            includePatterns: cloudflareConfig.include_patterns,
            excludePatterns: cloudflareConfig.exclude_patterns,
          },
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Cloudflare /crawl 请求失败 (${response.status}): ${body}`
      );
    }

    const json = (await response.json()) as {
      success?: boolean;
      result?: string;
      errors?: unknown[];
    };

    const jobId = json.result;
    if (!json.success || !jobId || typeof jobId !== 'string') {
      throw new Error(
        `Cloudflare /crawl 返回异常: ${JSON.stringify(
          { success: json.success, result: json.result, errors: json.errors },
          null,
          2
        )}`
      );
    }

    return jobId;
  }

  private async waitForCrawlJob(jobId: CloudflareCrawlJobId): Promise<void> {
    const cloudflareConfig = this.config.web.ingest.providers.cloudflare;
    const accountId = cloudflareConfig.account_id.trim();

    for (
      let attempt = 0;
      attempt < cloudflareConfig.max_poll_attempts;
      attempt += 1
    ) {
      const response = await this.fetch(
        this.endpoint(
          `/accounts/${accountId}/browser-rendering/crawl/${jobId}?limit=1`
        ),
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${readRequiredEnv(cloudflareConfig.api_token_env)}`,
          },
        }
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Cloudflare /crawl status 请求失败 (${response.status}): ${body}`
        );
      }

      const json = (await response.json()) as CloudflareCrawlJobStatusResponse;
      const status = json.result?.status;

      if (!json.success || !status) {
        throw new Error(
          `Cloudflare /crawl status 返回异常: ${JSON.stringify(json, null, 2)}`
        );
      }

      if (status === 'running') {
        await sleep(cloudflareConfig.poll_interval_ms);
        continue;
      }

      if (status !== 'completed') {
        throw new Error(`Cloudflare crawl job 未完成: status=${status}`);
      }

      return;
    }

    throw new Error('Cloudflare crawl job 轮询超时未完成');
  }

  private async fetchCompletedRecords(
    jobId: CloudflareCrawlJobId,
    limit: number
  ): Promise<CloudflareCrawlRecord[]> {
    const cloudflareConfig = this.config.web.ingest.providers.cloudflare;
    const accountId = cloudflareConfig.account_id.trim();

    const records: CloudflareCrawlRecord[] = [];
    let cursor: string | number | null = null;

    while (records.length < limit) {
      const params = new URLSearchParams();
      params.set('status', 'completed');
      params.set('limit', String(Math.min(1000, limit - records.length)));
      if (cursor !== null) {
        params.set('cursor', String(cursor));
      }

      const response = await this.fetch(
        this.endpoint(
          `/accounts/${accountId}/browser-rendering/crawl/${jobId}?${params.toString()}`
        ),
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${readRequiredEnv(cloudflareConfig.api_token_env)}`,
          },
        }
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Cloudflare /crawl records 请求失败 (${response.status}): ${body}`
        );
      }

      const json = (await response.json()) as CloudflareCrawlJobRecordsResponse;
      const batch = json.result?.records ?? [];

      if (!json.success) {
        throw new Error(
          `Cloudflare /crawl records 返回异常: ${JSON.stringify(json, null, 2)}`
        );
      }

      records.push(...batch);

      if (json.result?.cursor === undefined || json.result?.cursor === null) {
        break;
      }

      cursor = json.result.cursor;
    }

    return records.slice(0, limit);
  }

  private async runCrawlOnce(args: {
    url: string;
    maxPages: number;
    maxDepth: number;
    render: boolean;
  }): Promise<WebFetchedPage[]> {
    const jobId = await this.startCrawlJob(args);
    await this.waitForCrawlJob(jobId);

    const rawRecords = await this.fetchCompletedRecords(jobId, args.maxPages);
    const seen = new Set<string>();

    const pages: WebFetchedPage[] = [];
    for (const record of rawRecords) {
      if (record.status !== 'completed') {
        continue;
      }
      const recordUrl = record.url ?? record.metadata?.url;
      if (!recordUrl) {
        continue;
      }

      const normalized = normalizeUrl(recordUrl);
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);

      const markdown = (record.markdown ?? '').trim();
      if (!markdown) {
        continue;
      }

      pages.push({
        requestedUrl: args.url,
        finalUrl: normalized,
        title: record.metadata?.title?.trim() || normalized,
        canonicalUrl: null,
        markdown,
        html: '',
        links: [],
        fetchModeUsed: args.render ? 'fetch' : 'get',
      });
    }

    return pages.slice(0, args.maxPages);
  }

  async fetchPage(
    url: string,
    options: {
      fetchMode: AppConfig['web']['ingest']['providers']['scrapling']['default_fetch_mode'];
    }
  ): Promise<WebFetchedPage> {
    await this.assertAvailable();

    const cloudflareConfig = this.config.web.ingest.providers.cloudflare;
    const maxPages = 1;
    const maxDepth = 0;

    const tryRender = async (render: boolean, minMarkdownChars: number) => {
      const pages = await this.runCrawlOnce({
        url,
        maxPages,
        maxDepth,
        render,
      });

      const page = pages[0];
      if (!page) {
        throw new Error('Cloudflare crawl 未返回任何可用页面记录');
      }

      if (page.markdown.length < minMarkdownChars) {
        throw new Error(
          `正文提取内容过短 (${page.markdown.length} chars), render=${String(render)}`
        );
      }

      return page;
    };

    if (options.fetchMode === 'get') {
      return tryRender(false, 1);
    }
    if (options.fetchMode === 'fetch') {
      return tryRender(true, 1);
    }

    try {
      return await tryRender(false, cloudflareConfig.min_markdown_chars);
    } catch {
      try {
        return await tryRender(true, 1);
      } catch {
        // 最后兜底：如果页面确实很短，仍然返回一次 render=false 的结果（与 scrapling auto 的“尽力而为”行为一致）
        return await tryRender(false, 1);
      }
    }
  }

  async crawl(
    url: string,
    options: {
      maxPages: number;
      maxDepth: number;
      fetchMode: WebFetchMode;
    }
  ): Promise<WebFetchedPage[]> {
    await this.assertAvailable();

    const cloudflareConfig = this.config.web.ingest.providers.cloudflare;
    const maxPages = options.maxPages;
    const maxDepth = options.maxDepth;

    const tryRender = async (render: boolean, minGoodPages: number) => {
      const pages = await this.runCrawlOnce({
        url,
        maxPages,
        maxDepth,
        render,
      });

      const goodPages = pages.filter(
        (page) => page.markdown.length >= cloudflareConfig.min_markdown_chars
      );

      if (pages.length === 0) {
        throw new Error('Cloudflare crawl 未返回任何可用页面记录');
      }

      if (goodPages.length < minGoodPages) {
        throw new Error(
          `Cloudflare crawl 返回内容过短页面过多 (good=${goodPages.length}/${pages.length}), render=${String(render)}`
        );
      }

      return pages;
    };

    if (options.fetchMode === 'get') {
      return this.runCrawlOnce({ url, maxPages, maxDepth, render: false });
    }
    if (options.fetchMode === 'fetch') {
      return this.runCrawlOnce({ url, maxPages, maxDepth, render: true });
    }

    try {
      return await tryRender(false, 1);
    } catch {
      try {
        return await tryRender(true, 1);
      } catch {
        return await this.runCrawlOnce({
          url,
          maxPages,
          maxDepth,
          render: false,
        });
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
    case 'cloudflare':
      return new CloudflareWebIngestProvider(config);
  }
}
