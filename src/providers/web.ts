import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';

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

type Crawl4AIMode = Exclude<WebFetchMode, 'auto'>;

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

function parseJsonFromCrwlOutput(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('crwl 输出为空');
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // 有些版本会把日志混到 stdout，尽量从中截取 JSON
    const firstBrace = trimmed.indexOf('{');
    const firstBracket = trimmed.indexOf('[');
    const startCandidates = [firstBrace, firstBracket].filter((n) => n >= 0);
    const start = startCandidates.length ? Math.min(...startCandidates) : -1;
    if (start < 0) {
      throw new Error(`crwl 输出不是合法 JSON: ${trimmed.slice(0, 2000)}`);
    }

    const lastBrace = trimmed.lastIndexOf('}');
    const lastBracket = trimmed.lastIndexOf(']');
    const end = Math.max(lastBrace, lastBracket);
    if (end <= start) {
      throw new Error(`crwl 输出不是合法 JSON: ${trimmed.slice(0, 2000)}`);
    }

    const candidate = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      throw new Error(`crwl 输出不是合法 JSON: ${trimmed.slice(0, 2000)}`);
    }
  }
}

function asCrwlResultArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function extractCrwlMarkdown(item: unknown): string {
  if (!item || typeof item !== 'object') {
    return '';
  }

  const record = item as Record<string, unknown>;
  const markdown = record.markdown;
  if (typeof markdown === 'string') {
    return markdown;
  }

  if (markdown && typeof markdown === 'object') {
    const markdownObj = markdown as Record<string, unknown>;
    const raw = markdownObj.raw_markdown;
    if (typeof raw === 'string') {
      return raw;
    }
    const fit = markdownObj.fit_markdown;
    if (typeof fit === 'string') {
      return fit;
    }
  }

  const raw = record.raw_markdown;
  if (typeof raw === 'string') {
    return raw;
  }

  return '';
}

function extractCrwlFinalUrl(item: unknown, fallback: string): string {
  if (!item || typeof item !== 'object') {
    return fallback;
  }

  const record = item as Record<string, unknown>;
  const url = record.url;
  if (typeof url === 'string' && url.trim()) {
    return url;
  }

  const metadata = record.metadata;
  if (metadata && typeof metadata === 'object') {
    const metadataObj = metadata as Record<string, unknown>;
    const metaUrl = metadataObj.url;
    if (typeof metaUrl === 'string' && metaUrl.trim()) {
      return metaUrl;
    }
  }

  return fallback;
}

function extractCrwlTitle(item: unknown, fallback: string): string {
  if (!item || typeof item !== 'object') {
    return fallback;
  }

  const record = item as Record<string, unknown>;
  const metadata = record.metadata;
  if (metadata && typeof metadata === 'object') {
    const metadataObj = metadata as Record<string, unknown>;
    const title = metadataObj.title;
    if (typeof title === 'string' && title.trim()) {
      return title.trim();
    }
  }

  const title = record.title;
  if (typeof title === 'string' && title.trim()) {
    return title.trim();
  }

  return fallback;
}

function extractCrwlLinks(item: unknown, baseUrl: string): string[] {
  if (!item || typeof item !== 'object') {
    return [];
  }

  const record = item as Record<string, unknown>;
  const links = record.links;
  if (!links || typeof links !== 'object') {
    return [];
  }

  const linksObj = links as Record<string, unknown>;
  const internal = linksObj.internal;
  const external = linksObj.external;

  const candidates: unknown[] = [];
  if (Array.isArray(internal)) {
    candidates.push(...internal);
  }
  if (Array.isArray(external)) {
    candidates.push(...external);
  }

  const urls: string[] = [];
  for (const value of candidates) {
    if (typeof value === 'string') {
      const absolute = toAbsoluteUrl(value, baseUrl);
      if (absolute) {
        urls.push(absolute);
      }
      continue;
    }

    if (value && typeof value === 'object') {
      const href = (value as Record<string, unknown>).href;
      if (typeof href === 'string') {
        const absolute = toAbsoluteUrl(href, baseUrl);
        if (absolute) {
          urls.push(absolute);
        }
      }
    }
  }

  return urls;
}

function computePathPrefix(rootUrl: string): {
  origin: string;
  rootPath: string;
  pathPrefix: string;
} {
  const root = new URL(rootUrl);
  const rootPath = root.pathname || '/';
  const pathPrefix = rootPath.endsWith('/')
    ? rootPath
    : extname(rootPath)
      ? `${dirname(rootPath).replace(/\/+$/, '')}/`
      : `${rootPath}/`;
  return {
    origin: root.origin,
    rootPath,
    pathPrefix,
  };
}

function hasNonHtmlExtension(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  const match = /\.([a-z0-9]{1,8})$/.exec(lower);
  if (!match) {
    return false;
  }
  const ext = match[1] ?? '';
  return new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'svg',
    'webp',
    'ico',
    'css',
    'js',
    'mjs',
    'cjs',
    'map',
    'json',
    'xml',
    'pdf',
    'zip',
    'gz',
    'tgz',
    'tar',
    'rar',
    '7z',
    'woff',
    'woff2',
    'ttf',
    'otf',
    'eot',
    'mp4',
    'webm',
    'mp3',
    'wav',
    'mov',
    'avi',
    'mkv',
  ]).has(ext);
}

function isDefaultNoisePath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  if (lower === '/robots.txt' || lower === '/sitemap.xml') {
    return true;
  }

  // 常见静态资源目录
  return (
    lower.startsWith('/assets/') ||
    lower.startsWith('/static/') ||
    lower.startsWith('/img/') ||
    lower.startsWith('/images/') ||
    lower.startsWith('/_next/') ||
    lower.startsWith('/favicon')
  );
}

function isUrlInScope(args: {
  rootUrl: string;
  candidateUrl: string;
}): boolean {
  const scope = computePathPrefix(args.rootUrl);
  const candidate = new URL(args.candidateUrl);
  if (candidate.origin !== scope.origin) {
    return false;
  }

  if (scope.pathPrefix === '/') {
    return true;
  }

  const pathname = candidate.pathname || '/';
  return pathname === scope.rootPath || pathname.startsWith(scope.pathPrefix);
}

function shouldExcludeUrlByDefault(candidateUrl: string): boolean {
  const url = new URL(candidateUrl);
  const pathname = url.pathname || '/';
  return hasNonHtmlExtension(pathname) || isDefaultNoisePath(pathname);
}

class Crawl4AIWebIngestProvider implements WebIngestProvider {
  readonly id = 'crawl4ai' as const;

  constructor(private readonly config: AppConfig) {}

  async assertAvailable(): Promise<void> {
    const command = this.config.web.ingest.providers.crawl4ai.command;
    const hint =
      '未检测到可用的 Crawl4AI CLI（crwl）。\n\n' +
      '请先安装并完成初始化：\n' +
      '1) python -m pip install -U crawl4ai\n' +
      '2) crawl4ai-setup\n' +
      '3) crwl --help\n' +
      '4) crawl4ai-doctor\n\n' +
      '如果你使用 uv：\n' +
      'uv tool install crawl4ai\n' +
      'crawl4ai-setup\n' +
      'crwl --help\n' +
      'crawl4ai-doctor\n';

    try {
      const proc = Bun.spawn([command, '--help'], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        throw new Error(stderr.trim() || stdout.trim());
      }

      // 确保 `crwl crawl` 子命令可用（我们会显式使用它）
      const proc2 = Bun.spawn([command, 'crawl', '--help'], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env,
      });
      const [stdout2, stderr2, exitCode2] = await Promise.all([
        new Response(proc2.stdout).text(),
        new Response(proc2.stderr).text(),
        proc2.exited,
      ]);
      if (exitCode2 !== 0) {
        throw new Error(stderr2.trim() || stdout2.trim());
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${hint}\n原始输出: ${reason}`);
    }
  }

  private buildBrowserArgs(mode: Crawl4AIMode): string {
    // `get` 追求更快：禁用 JS，减少资源开销
    if (mode === 'get') {
      return 'headless=true,java_script_enabled=false,text_mode=true,light_mode=true';
    }

    // `fetch` 用于动态页面：启用 JS
    return 'headless=true,java_script_enabled=true,text_mode=true,light_mode=false';
  }

  private buildCrawlerRunConfig(args: {
    rootUrl: string;
    mode: Crawl4AIMode;
    deep?: {
      maxPages: number;
      maxDepth: number;
    };
  }): Record<string, unknown> {
    const crawl4aiConfig = this.config.web.ingest.providers.crawl4ai;

    const params: Record<string, unknown> = {
      cache_mode: 'bypass',
      // 让输出更稳定、更干净，避免 JSON 被 verbose 混入
      verbose: false,
      // 降噪：移除遮罩层/同意弹窗等
      remove_overlay_elements: true,
      remove_consent_popups: true,
      // 不强制 robots.txt，保持与现有实现一致（默认不检查）
      check_robots_txt: false,
      // 避免把外链当作正文的一部分
      exclude_external_links: true,
      exclude_social_media_links: true,
      excluded_tags: ['script', 'style', 'noscript', 'nav', 'footer', 'aside'],
      wait_until: args.mode === 'fetch' ? 'networkidle' : 'domcontentloaded',
      page_timeout:
        args.mode === 'fetch'
          ? crawl4aiConfig.fetch_page_timeout_ms
          : crawl4aiConfig.get_page_timeout_ms,
      // 默认尽量不要过滤正文块（避免误删文档短段落）
      word_count_threshold: 0,
    };

    if (args.deep) {
      const scope = computePathPrefix(normalizeUrl(args.rootUrl));
      const includePattern =
        scope.pathPrefix === '/'
          ? `${scope.origin}/*`
          : `${scope.origin}${scope.pathPrefix}*`;

      const excludePatterns = [
        // common noise routes
        '*/robots.txt',
        '*/sitemap.xml',
        '*/assets/*',
        '*/static/*',
        '*/img/*',
        '*/images/*',
        '*/_next/*',
        '*/favicon*',
        // common non-HTML assets
        '*.png',
        '*.jpg',
        '*.jpeg',
        '*.gif',
        '*.svg',
        '*.webp',
        '*.ico',
        '*.css',
        '*.js',
        '*.mjs',
        '*.cjs',
        '*.map',
        '*.json',
        '*.xml',
        '*.pdf',
        '*.zip',
        '*.gz',
        '*.tgz',
        '*.tar',
        '*.rar',
        '*.7z',
        '*.woff',
        '*.woff2',
        '*.ttf',
        '*.otf',
        '*.eot',
        '*.mp4',
        '*.webm',
        '*.mp3',
        '*.wav',
        '*.mov',
        '*.avi',
        '*.mkv',
      ];

      params.deep_crawl_strategy = {
        type: 'BFSDeepCrawlStrategy',
        params: {
          max_depth: args.deep.maxDepth,
          include_external: false,
          max_pages: args.deep.maxPages,
          filter_chain: {
            type: 'FilterChain',
            params: {
              filters: [
                {
                  type: 'URLPatternFilter',
                  params: {
                    patterns: [includePattern],
                    use_glob: true,
                  },
                },
                {
                  type: 'URLPatternFilter',
                  params: {
                    patterns: excludePatterns,
                    use_glob: true,
                    reverse: true,
                  },
                },
                {
                  type: 'ContentTypeFilter',
                  params: {
                    allowed_types: ['text/html'],
                  },
                },
              ],
            },
          },
        },
      };
    }

    return {
      type: 'CrawlerRunConfig',
      params,
    };
  }

  private async runCrwl(args: {
    url: string;
    mode: Crawl4AIMode;
    deep?: {
      maxPages: number;
      maxDepth: number;
    };
  }): Promise<unknown[]> {
    const crawl4aiConfig = this.config.web.ingest.providers.crawl4ai;
    const command = crawl4aiConfig.command;

    const tempDir = await mkdtemp(join(tmpdir(), 'nya-cli-crawl4ai-'));
    const crawlerConfigPath = join(tempDir, 'crawler.json');
    await writeFile(
      crawlerConfigPath,
      JSON.stringify(
        this.buildCrawlerRunConfig({
          rootUrl: args.url,
          mode: args.mode,
          ...(args.deep ? { deep: args.deep } : {}),
        }),
        null,
        2
      ),
      'utf8'
    );

    const spawnOnce = async (cmd: string[]) => {
      const proc = Bun.spawn(cmd, {
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      return {
        stdout,
        stderr,
        exitCode,
      };
    };

    const cmd: string[] = [
      command,
      'crawl',
      args.url,
      '-o',
      'all',
      '-C',
      crawlerConfigPath,
      '-b',
      this.buildBrowserArgs(args.mode),
    ];

    if (args.deep) {
      cmd.push('--deep-crawl', 'bfs');
      cmd.push('--max-pages', String(args.deep.maxPages));
    }

    const result = await spawnOnce(cmd);

    await rm(tempDir, { recursive: true, force: true });

    if (result.exitCode !== 0) {
      throw new Error(
        `crwl crawl 失败 (${result.exitCode}): ${
          result.stderr.trim() || result.stdout.trim()
        }`
      );
    }

    const json = parseJsonFromCrwlOutput(result.stdout);
    return asCrwlResultArray(json);
  }

  private toWebFetchedPage(args: {
    requestedUrl: string;
    item: unknown;
    mode: Crawl4AIMode;
  }): WebFetchedPage {
    const finalUrl = normalizeUrl(
      extractCrwlFinalUrl(args.item, args.requestedUrl)
    );
    const markdown = extractCrwlMarkdown(args.item).trim();

    return {
      requestedUrl: args.requestedUrl,
      finalUrl,
      title: extractCrwlTitle(args.item, finalUrl),
      canonicalUrl: null,
      markdown,
      html: '',
      links: extractCrwlLinks(args.item, finalUrl)
        .map((url) => normalizeUrl(url))
        .filter((url) => !shouldExcludeUrlByDefault(url)),
      fetchModeUsed: args.mode,
    };
  }

  async fetchPage(
    url: string,
    options: {
      fetchMode: WebFetchMode;
    }
  ): Promise<WebFetchedPage> {
    await this.assertAvailable();

    const crawl4aiConfig = this.config.web.ingest.providers.crawl4ai;
    const tryMode = async (mode: Crawl4AIMode, minMarkdownChars: number) => {
      const results = await this.runCrwl({ url, mode });
      const first = results[0];
      if (!first) {
        throw new Error('crwl 未返回任何结果');
      }

      const page = this.toWebFetchedPage({
        requestedUrl: url,
        item: first,
        mode,
      });

      if (page.markdown.length < minMarkdownChars) {
        throw new Error(
          `正文提取内容过短 (${page.markdown.length} chars), fetch mode=${page.fetchModeUsed}`
        );
      }

      return page;
    };

    if (options.fetchMode === 'get') {
      return tryMode('get', 1);
    }

    if (options.fetchMode === 'fetch') {
      return tryMode('fetch', 1);
    }

    let getPage: WebFetchedPage | null = null;
    try {
      getPage = await tryMode('get', crawl4aiConfig.min_markdown_chars);
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

  async crawl(
    url: string,
    options: {
      maxPages: number;
      maxDepth: number;
      fetchMode: WebFetchMode;
    }
  ): Promise<WebFetchedPage[]> {
    await this.assertAvailable();

    const crawl4aiConfig = this.config.web.ingest.providers.crawl4ai;

    const toScoped = (pages: WebFetchedPage[]) => {
      const seen = new Set<string>();
      const filtered: WebFetchedPage[] = [];
      for (const page of pages) {
        if (!isUrlInScope({ rootUrl: url, candidateUrl: page.finalUrl })) {
          continue;
        }

        if (shouldExcludeUrlByDefault(page.finalUrl)) {
          continue;
        }

        const normalized = normalizeUrl(page.finalUrl);
        if (seen.has(normalized)) {
          continue;
        }
        seen.add(normalized);
        filtered.push({
          ...page,
          finalUrl: normalized,
        });
      }

      return filtered;
    };

    const crawlByQueue = async (): Promise<WebFetchedPage[]> => {
      const visited = new Set<string>();
      const queue: Array<{ url: string; depth: number }> = [
        {
          url: normalizeUrl(url),
          depth: 0,
        },
      ];
      const pages: WebFetchedPage[] = [];

      while (queue.length > 0 && pages.length < options.maxPages) {
        const next = queue.shift();
        if (!next) {
          break;
        }

        const normalized = normalizeUrl(next.url);
        if (visited.has(normalized)) {
          continue;
        }
        visited.add(normalized);

        if (!isUrlInScope({ rootUrl: url, candidateUrl: normalized })) {
          continue;
        }
        if (shouldExcludeUrlByDefault(normalized)) {
          continue;
        }

        const page = await this.fetchPage(normalized, {
          fetchMode: options.fetchMode,
        });

        pages.push({
          ...page,
          // deep crawl 语义下，requestedUrl 统一视为 root url
          requestedUrl: url,
        });

        if (next.depth >= options.maxDepth) {
          continue;
        }

        for (const link of page.links) {
          const normalizedLink = normalizeUrl(link);
          if (visited.has(normalizedLink)) {
            continue;
          }
          if (!isUrlInScope({ rootUrl: url, candidateUrl: normalizedLink })) {
            continue;
          }
          if (shouldExcludeUrlByDefault(normalizedLink)) {
            continue;
          }

          queue.push({
            url: normalizedLink,
            depth: next.depth + 1,
          });
        }
      }

      return toScoped(pages).slice(0, options.maxPages);
    };

    const crawlOnce = async (mode: Crawl4AIMode, minGoodPages: number) => {
      let results: unknown[];
      try {
        results = await this.runCrwl({
          url: normalizeUrl(url),
          mode,
          deep: {
            maxPages: options.maxPages,
            maxDepth: options.maxDepth,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const normalizedMessage = message.toLowerCase();
        const isOptionError =
          normalizedMessage.includes('no such option') ||
          normalizedMessage.includes('unknown option') ||
          normalizedMessage.includes('unrecognized option');
        const isDeepFlag =
          message.includes('--deep-crawl') ||
          message.includes('--max-pages') ||
          message.includes('--max-depth');

        if (isOptionError && isDeepFlag) {
          // 兼容不支持 deep crawl flags 的 CLI：回退到本地队列爬取
          return crawlByQueue();
        }

        throw error;
      }

      const pages = results
        .map((item) => this.toWebFetchedPage({ requestedUrl: url, item, mode }))
        .filter((page) => Boolean(page.markdown));

      if (pages.length === 0) {
        throw new Error('Crawl4AI crawl 未返回任何可用页面');
      }

      const scoped = toScoped(pages).slice(0, options.maxPages);
      const goodPages = scoped.filter(
        (page) => page.markdown.length >= crawl4aiConfig.min_markdown_chars
      );

      if (goodPages.length < minGoodPages) {
        throw new Error(
          `Crawl4AI crawl 返回内容过短页面过多 (good=${goodPages.length}/${scoped.length}), mode=${mode}`
        );
      }

      return scoped;
    };

    if (options.fetchMode === 'get') {
      return crawlOnce('get', 0);
    }
    if (options.fetchMode === 'fetch') {
      return crawlOnce('fetch', 0);
    }

    let getPages: WebFetchedPage[] | null = null;
    let firstError: unknown = null;
    try {
      getPages = await crawlOnce('get', 1);
      return getPages;
    } catch (error) {
      firstError = error;
      try {
        return await crawlOnce('fetch', 1);
      } catch {
        if (getPages && getPages.length > 0) {
          return getPages;
        }
        throw firstError;
      }
    }
  }
}

type CloudflareCrawlJobId = string;

type CloudflareSinglePageResponse = {
  success?: boolean;
  result?: {
    markdown?: string;
    metadata?: {
      title?: string;
      url?: string;
      status?: number;
    };
  };
  errors?: unknown[];
};

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

  private async fetchMarkdownPage(args: {
    url: string;
    mode: Exclude<WebFetchMode, 'auto'>;
  }): Promise<WebFetchedPage> {
    const cloudflareConfig = this.config.web.ingest.providers.cloudflare;
    const accountId = cloudflareConfig.account_id.trim();
    const response = await this.fetch(
      this.endpoint(`/accounts/${accountId}/browser-rendering/markdown`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          url: args.url,
          ...(args.mode === 'fetch'
            ? {
                gotoOptions: {
                  waitUntil: 'networkidle2',
                },
              }
            : {}),
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Cloudflare /markdown 请求失败 (${response.status}): ${body}`
      );
    }

    const json = (await response.json()) as CloudflareSinglePageResponse;
    const markdown = (json.result?.markdown ?? '').trim();
    if (!json.success || !markdown) {
      throw new Error(
        `Cloudflare /markdown 返回异常: ${JSON.stringify(
          { success: json.success, result: json.result, errors: json.errors },
          null,
          2
        )}`
      );
    }

    const finalUrl = normalizeUrl(json.result?.metadata?.url ?? args.url);
    return {
      requestedUrl: args.url,
      finalUrl,
      title: json.result?.metadata?.title?.trim() || finalUrl,
      canonicalUrl: null,
      markdown,
      html: '',
      links: [],
      fetchModeUsed: args.mode,
    };
  }

  async fetchPage(
    url: string,
    options: {
      fetchMode: WebFetchMode;
    }
  ): Promise<WebFetchedPage> {
    await this.assertAvailable();

    const cloudflareConfig = this.config.web.ingest.providers.cloudflare;

    const ensureMinMarkdown = (
      page: WebFetchedPage,
      minMarkdownChars: number
    ): WebFetchedPage => {
      if (page.markdown.length < minMarkdownChars) {
        throw new Error(
          `正文提取内容过短 (${page.markdown.length} chars), fetch mode=${page.fetchModeUsed}`
        );
      }
      return page;
    };

    if (options.fetchMode === 'get') {
      return ensureMinMarkdown(
        await this.fetchMarkdownPage({ url, mode: 'get' }),
        1
      );
    }
    if (options.fetchMode === 'fetch') {
      return ensureMinMarkdown(
        await this.fetchMarkdownPage({ url, mode: 'fetch' }),
        1
      );
    }

    let getPage: WebFetchedPage | null = null;
    let firstError: unknown = null;
    try {
      getPage = ensureMinMarkdown(
        await this.fetchMarkdownPage({ url, mode: 'get' }),
        cloudflareConfig.min_markdown_chars
      );
      return getPage;
    } catch (error) {
      firstError = error;
      try {
        return ensureMinMarkdown(
          await this.fetchMarkdownPage({ url, mode: 'fetch' }),
          1
        );
      } catch {
        if (getPage) {
          return getPage;
        }
        throw firstError;
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

    let getPages: WebFetchedPage[] | null = null;
    let firstError: unknown = null;
    try {
      getPages = await tryRender(false, 1);
      return getPages;
    } catch (error) {
      firstError = error;
      try {
        return await tryRender(true, 1);
      } catch {
        if (getPages && getPages.length > 0) {
          return getPages;
        }
        throw firstError;
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
    case 'crawl4ai':
      return new Crawl4AIWebIngestProvider(config);
    case 'cloudflare':
      return new CloudflareWebIngestProvider(config);
  }
}
