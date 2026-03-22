import type { Database } from 'bun:sqlite';
import {
  getSearchHits,
  searchFts,
  searchLike,
  searchMetadataLike,
  searchVector,
} from '../../db/database';
import type { EmbeddingProvider } from '../../providers/types';
import type { ScopeMode } from '../../types/config';
import {
  compactSearchText,
  extractSearchTerms,
  makeSnippet,
} from '../../utils/text';

export type SearchResult = {
  chunkId: number;
  documentId: number;
  sourceKey: string;
  path: string;
  section: string;
  snippet: string;
  score: number;
  sourceKind: string;
};

export type SearchResponse = {
  query: string;
  scope: ScopeMode;
  databasePath: string;
  extensions: string[];
  results: SearchResult[];
};

const RRF_K = 60;

export function normalizeSearchExtensions(
  values: readonly unknown[] | undefined
): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  const normalized = values.flatMap((value) => {
    if (typeof value !== 'string') {
      return [];
    }

    const trimmed = value.trim().toLowerCase();
    if (
      trimmed.length === 0 ||
      trimmed === '.' ||
      trimmed === 'undefined' ||
      trimmed === '.undefined' ||
      /\s/.test(trimmed) ||
      trimmed.includes('/') ||
      trimmed.includes('\\')
    ) {
      return [];
    }

    return [trimmed.startsWith('.') ? trimmed : `.${trimmed}`];
  });

  return [...new Set(normalized)];
}

function reciprocalRank(rank: number): number {
  return 1 / (RRF_K + rank);
}

function computeCoverage(text: string, terms: string[]): number {
  if (terms.length === 0) {
    return 0;
  }

  const compact = compactSearchText(text);
  const matched = terms.filter((term) => compact.includes(term)).length;
  return matched / terms.length;
}

function computeQueryAwareBoost(
  row: { path: string; section: string; content: string },
  query: string
): number {
  const compactQuery = compactSearchText(query);
  const terms = extractSearchTerms(query);
  const metadataText = `${row.path} ${row.section}`;
  const compactMetadata = compactSearchText(metadataText);
  const compactContent = compactSearchText(row.content);

  let boost = 0;

  if (compactQuery.length >= 2) {
    if (compactMetadata.includes(compactQuery)) {
      boost += 0.03;
    } else if (compactContent.includes(compactQuery)) {
      boost += 0.012;
    }
  }

  boost += computeCoverage(metadataText, terms) * 0.02;
  boost += computeCoverage(row.content, terms) * 0.008;

  return boost;
}

function shouldRequireLexicalMatch(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    return false;
  }

  if (compactSearchText(trimmed).length < 8) {
    return false;
  }

  return (
    /[0-9]/.test(trimmed) ||
    /[_./-]/.test(trimmed) ||
    (/[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed))
  );
}

export async function searchIndex(args: {
  db: Database;
  embeddingProvider: EmbeddingProvider;
  query: string;
  extensions?: string[];
  limit: number;
  scope: ScopeMode;
  databasePath: string;
}): Promise<SearchResponse> {
  const extensions = normalizeSearchExtensions(args.extensions);
  const candidateLimit = Math.max(args.limit * 3, args.limit + 8);
  const requireLexicalMatch = shouldRequireLexicalMatch(args.query);
  const queryEmbedding = await args.embeddingProvider.embedQuery(args.query);
  const vectorHits = searchVector(
    args.db,
    queryEmbedding,
    candidateLimit,
    extensions
  );
  const ftsHits = searchFts(args.db, args.query, candidateLimit, extensions);
  const lexicalHits =
    ftsHits.length > 0
      ? []
      : searchLike(args.db, args.query, candidateLimit, extensions);
  const metadataHits = searchMetadataLike(
    args.db,
    args.query,
    candidateLimit,
    extensions
  );

  if (
    requireLexicalMatch &&
    ftsHits.length === 0 &&
    lexicalHits.length === 0 &&
    metadataHits.length === 0
  ) {
    return {
      query: args.query,
      scope: args.scope,
      databasePath: args.databasePath,
      extensions,
      results: [],
    };
  }

  const scores = new Map<number, number>();
  for (const hit of vectorHits) {
    scores.set(
      hit.chunkId,
      (scores.get(hit.chunkId) ?? 0) + reciprocalRank(hit.rank)
    );
  }
  for (const hit of ftsHits) {
    scores.set(
      hit.chunkId,
      (scores.get(hit.chunkId) ?? 0) + reciprocalRank(hit.rank)
    );
  }
  for (const hit of lexicalHits) {
    scores.set(
      hit.chunkId,
      (scores.get(hit.chunkId) ?? 0) + reciprocalRank(hit.rank)
    );
  }

  const candidateIds = [...new Set([...scores.keys(), ...metadataHits])];

  const rows = getSearchHits(args.db, candidateIds);
  const rowMap = new Map(rows.map((row) => [row.id, row]));

  const results = candidateIds
    .flatMap((chunkId) => {
      const row = rowMap.get(chunkId);
      if (!row) {
        return [];
      }
      return [
        {
          chunkId,
          documentId: row.documentId,
          sourceKey: row.sourceKey,
          path: row.path,
          section: row.section,
          snippet: makeSnippet(row.content, args.query),
          score:
            (scores.get(chunkId) ?? 0) +
            computeQueryAwareBoost(row, args.query),
          sourceKind: row.sourceKind,
        },
      ];
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, args.limit);

  return {
    query: args.query,
    scope: args.scope,
    databasePath: args.databasePath,
    extensions,
    results,
  };
}
