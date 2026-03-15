export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

const SEARCH_TERM_PATTERN = /[\p{L}\p{N}_./-]+/gu;

export function extractSearchTerms(value: string): string[] {
  const rawTokens = value.match(SEARCH_TERM_PATTERN) ?? [];
  const terms: string[] = [];

  for (const token of rawTokens.slice(0, 8)) {
    const compact = compactSearchText(token);
    if (compact.length >= 2) {
      terms.push(compact);
    }

    const segmented = token
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[^\p{L}\p{N}]+/u)
      .map((part) => part.toLowerCase())
      .filter((part) => part.length >= 2);
    terms.push(...segmented);
  }

  return [...new Set(terms)].slice(0, 12);
}

export function compactSearchText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function findSnippetAnchor(content: string, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length >= 2) {
    const phraseIndex = content.toLowerCase().indexOf(normalizedQuery);
    if (phraseIndex >= 0) {
      return phraseIndex;
    }
  }

  for (const term of extractSearchTerms(query).sort(
    (left, right) => right.length - left.length
  )) {
    const termIndex = compactSearchText(content).indexOf(term);
    if (termIndex >= 0) {
      const originalIndex = content
        .toLowerCase()
        .indexOf(term.length >= 2 ? term : query.trim().toLowerCase());
      if (originalIndex >= 0) {
        return originalIndex;
      }
    }
  }

  return -1;
}

export function makeSnippet(
  value: string,
  query?: string,
  maxLength = 220
): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  if (!query?.trim()) {
    return `${normalized.slice(0, maxLength - 1)}…`;
  }

  const anchor = findSnippetAnchor(normalized, query);
  if (anchor < 0) {
    return `${normalized.slice(0, maxLength - 1)}…`;
  }

  const leadingContext = Math.max(24, Math.floor(maxLength * 0.35));
  let start = Math.max(0, anchor - leadingContext);
  const end = Math.min(normalized.length, start + maxLength);

  if (end === normalized.length) {
    start = Math.max(0, end - maxLength);
  }

  const snippet = normalized.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${snippet}${end < normalized.length ? '…' : ''}`;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}
