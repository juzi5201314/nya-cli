const REDACTED = '[REDACTED]';

const SENSITIVE_PARAM_NAMES = new Set([
  'token',
  'access_token',
  'api_key',
  'key',
  'signature',
  'sig',
  'auth',
  'authorization',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
]);

const URL_TOKEN_PATTERN = /(?:[a-z][a-z0-9+.-]*:\/\/)[^\s<>'"`]+/gi;

function redactParams(raw: string): string {
  const params = new URLSearchParams(raw);
  const entries = [...params.entries()];
  if (entries.length === 0) {
    return raw;
  }

  return entries
    .map(([key, value]) => {
      const normalizedKey = key.toLowerCase();
      const renderedValue = SENSITIVE_PARAM_NAMES.has(normalizedKey)
        ? REDACTED
        : encodeURIComponent(value);
      return `${encodeURIComponent(key)}=${renderedValue}`;
    })
    .join('&');
}

function redactUrlString(
  raw: string,
  options?: { stripFragment?: boolean }
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    const schemeMatch = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i.exec(raw);
    if (!schemeMatch) {
      return null;
    }

    const prefix = schemeMatch[1];
    const remainder = schemeMatch[2] ?? '';
    const firstSeparator = [
      remainder.indexOf('/'),
      remainder.indexOf('?'),
      remainder.indexOf('#'),
    ]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];

    const authEnd = remainder.indexOf('@');
    const hasUserInfo =
      authEnd >= 0 &&
      (firstSeparator === undefined || authEnd < firstSeparator);
    const afterAuth = hasUserInfo ? remainder.slice(authEnd + 1) : remainder;

    const hashIndex = afterAuth.indexOf('#');
    const queryIndex = afterAuth.indexOf('?');
    const pathEnd =
      queryIndex >= 0
        ? queryIndex
        : hashIndex >= 0
          ? hashIndex
          : afterAuth.length;
    const path = afterAuth.slice(0, pathEnd);
    const queryRaw =
      queryIndex >= 0
        ? afterAuth.slice(
            queryIndex + 1,
            hashIndex >= 0 ? hashIndex : undefined
          )
        : '';
    const fragmentRaw = hashIndex >= 0 ? afterAuth.slice(hashIndex + 1) : '';

    const query = queryRaw ? redactParams(queryRaw) : '';
    const fragment =
      (options?.stripFragment ?? true)
        ? ''
        : fragmentRaw
          ? redactParams(fragmentRaw)
          : '';

    return [
      prefix,
      hasUserInfo ? `${REDACTED}@` : '',
      path,
      query ? `?${query}` : '',
      fragment ? `#${fragment}` : '',
    ].join('');
  }

  const stripFragment = options?.stripFragment ?? true;
  const hasUserInfo = Boolean(url.username || url.password);
  const query = url.search ? redactParams(url.search.slice(1)) : '';
  const fragment = stripFragment
    ? ''
    : url.hash
      ? redactParams(url.hash.slice(1))
      : '';

  return [
    url.protocol,
    '//',
    hasUserInfo ? `${REDACTED}@` : '',
    url.host,
    url.pathname,
    query ? `?${query}` : '',
    fragment ? `#${fragment}` : '',
  ].join('');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function normalizeLocatorForStorage(
  value: string,
  options?: { stripFragment?: boolean }
): string {
  const redacted = redactUrlString(value, options);
  return redacted ?? value;
}

export function redactText(value: string): string {
  return value.replace(URL_TOKEN_PATTERN, (match) => {
    return normalizeLocatorForStorage(match);
  });
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return redactText(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item)) as T;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactDeep(entry);
  }

  return redacted as T;
}
