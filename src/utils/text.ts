export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function makeSnippet(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}
