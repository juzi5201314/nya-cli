import { type NowFn, RateLimiter, type SleepFn } from './rate-limit';
import { estimateTokens } from './text';

export type FetchLike = typeof globalThis.fetch;

export type FetchRateLimitConfig = {
  rpm: number;
  tpm: number;
};

export type FetchRetryConfig = {
  // 额外重试次数（不含首次请求）
  maxRetries: number;
  // 每次重试的基础等待时间（ms）
  delayMs: number;
};

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function parseRetryAfterMs(value: string | null, now: NowFn): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - now());
  }

  return null;
}

function estimateBodyTokens(body: unknown): number {
  if (!body) {
    return 0;
  }
  if (typeof body === 'string') {
    return estimateTokens(body);
  }
  return 0;
}

function isRetryableFetchError(error: unknown): boolean {
  // fetch 抛出的网络错误在 Bun/Node 中通常是 TypeError 或 Error
  if (!(error instanceof Error)) {
    return false;
  }

  const anyError = error as unknown as {
    name?: unknown;
    code?: unknown;
    cause?: unknown;
  };

  if (anyError.name === 'AbortError') {
    return true;
  }

  // 常见网络错误（不同 runtime 的 message/code 不完全一致，这里只做保守判断）
  const message = (error.message ?? '').toLowerCase();
  if (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('socket') ||
    message.includes('dns') ||
    message.includes('fetch failed')
  ) {
    return true;
  }

  if (anyError.code && typeof anyError.code === 'string') {
    const code = anyError.code.toUpperCase();
    if (
      [
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'EAI_AGAIN',
        'ENOTFOUND',
      ].includes(code)
    ) {
      return true;
    }
  }

  return false;
}

function computeRetryDelayMs(args: {
  status: number | null;
  retryAfterMs: number | null;
  baseDelayMs: number;
}): number {
  const baseDelay = Math.max(0, args.baseDelayMs);
  const retryAfter = Math.max(0, args.retryAfterMs ?? 0);

  if (args.status === 429) {
    return Math.max(retryAfter, baseDelay * 2);
  }

  return Math.max(retryAfter, baseDelay);
}

export function createFetchWithPolicies(args: {
  rateLimit: FetchRateLimitConfig;
  retry: FetchRetryConfig;
  baseFetch?: FetchLike;
  now?: NowFn;
  sleep?: SleepFn;
}): FetchLike {
  const baseFetch = args.baseFetch ?? fetch;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? defaultSleep;

  const limiter = new RateLimiter(args.rateLimit, { now, sleep });
  const baseMaxRetries = Math.max(0, args.retry.maxRetries);
  const baseDelayMs = Math.max(0, args.retry.delayMs);

  // 429 时额外追加的重试次数（在开启重试时才生效）
  const extraRetriesOn429 = baseMaxRetries > 0 ? 2 : 0;

  type FetchArgs = Parameters<FetchLike>;
  const wrappedFetch = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    const requestTokens = estimateBodyTokens(init?.body as unknown);

    let maxRetries = baseMaxRetries;
    let appended429Retries = false;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await limiter.acquire({ requests: 1, tokens: requestTokens });

      try {
        const response = await baseFetch(input, init);

        if (response.status === 429 && !appended429Retries) {
          maxRetries = baseMaxRetries + extraRetriesOn429;
          appended429Retries = true;
        }

        if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
          return response;
        }

        const retryAfterMs = parseRetryAfterMs(
          response.headers.get('retry-after'),
          now
        );
        const delayMs = computeRetryDelayMs({
          status: response.status,
          retryAfterMs,
          baseDelayMs,
        });

        if (delayMs > 0) {
          await sleep(delayMs);
        }
      } catch (error) {
        lastError = error;

        // 如果 429 错误是通过异常抛出（例如上层包装），也做同样的扩展
        const status = (() => {
          if (error && typeof error === 'object') {
            const anyError = error as {
              status?: unknown;
              statusCode?: unknown;
            };
            const value =
              typeof anyError.statusCode === 'number'
                ? anyError.statusCode
                : typeof anyError.status === 'number'
                  ? anyError.status
                  : null;
            return Number.isFinite(value as number) ? (value as number) : null;
          }
          return null;
        })();

        if (status === 429 && !appended429Retries) {
          maxRetries = baseMaxRetries + extraRetriesOn429;
          appended429Retries = true;
        }

        if (!isRetryableFetchError(error) || attempt >= maxRetries) {
          if (attempt > 0) {
            throw new Error(`网络请求失败，已重试 ${attempt} 次`, {
              cause: error,
            });
          }
          throw error;
        }

        const delayMs = computeRetryDelayMs({
          status,
          retryAfterMs: null,
          baseDelayMs,
        });
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }
    }

    throw lastError ?? new Error('网络请求失败');
  }) as unknown as FetchLike;

  // Bun 的 fetch 带有 preconnect 属性（非标准）。这里做一次透传，保证类型兼容。
  if ('preconnect' in baseFetch) {
    (wrappedFetch as unknown as { preconnect: unknown }).preconnect = (
      baseFetch as unknown as { preconnect: unknown }
    ).preconnect;
  }

  return wrappedFetch;
}
