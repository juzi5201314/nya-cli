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

type RetrieverName = 'vector' | 'fts' | 'lexical' | 'metadata';

export type SearchResponse = {
  query: string;
  scope: ScopeMode;
  databasePath: string;
  extensions: string[];
  retrieversUsed: RetrieverName[];
  vectorCandidates: number;
  ftsCandidates: number;
  lexicalCandidates: number;
  metadataCandidates: number;
  rrfUsed: boolean;
  results: SearchResult[];
};

const RRF_K = 60;
const RETRIEVER_ORDER: RetrieverName[] = [
  'vector',
  'fts',
  'lexical',
  'metadata',
];

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

function compareSearchResults(left: SearchResult, right: SearchResult): number {
  const scoreDelta = right.score - left.score;
  if (Math.abs(scoreDelta) > 1e-12) {
    return scoreDelta;
  }

  if (left.documentId !== right.documentId) {
    return left.documentId - right.documentId;
  }

  return left.chunkId - right.chunkId;
}

function buildSearchResponse(args: {
  db: Database;
  query: string;
  extensions: string[];
  fetchLimit: number;
  resultLimit: number;
  scope: ScopeMode;
  databasePath: string;
  queryEmbedding: number[];
}): SearchResponse {
  const vectorHits = searchVector(
    args.db,
    args.queryEmbedding,
    args.fetchLimit,
    args.extensions
  );
  const ftsHits = searchFts(
    args.db,
    args.query,
    args.fetchLimit,
    args.extensions
  );
  const lexicalHits =
    ftsHits.length > 0
      ? []
      : searchLike(args.db, args.query, args.fetchLimit, args.extensions);
  const metadataHits = searchMetadataLike(
    args.db,
    args.query,
    args.fetchLimit,
    args.extensions
  );

  const scores = new Map<number, number>();
  const usedRetrievers = new Set<RetrieverName>();

  for (const hit of vectorHits) {
    scores.set(
      hit.chunkId,
      (scores.get(hit.chunkId) ?? 0) + reciprocalRank(hit.rank)
    );
    usedRetrievers.add('vector');
  }

  for (const hit of ftsHits) {
    scores.set(
      hit.chunkId,
      (scores.get(hit.chunkId) ?? 0) + reciprocalRank(hit.rank)
    );
    usedRetrievers.add('fts');
  }

  for (const hit of lexicalHits) {
    scores.set(
      hit.chunkId,
      (scores.get(hit.chunkId) ?? 0) + reciprocalRank(hit.rank)
    );
    usedRetrievers.add('lexical');
  }

  for (const chunkId of metadataHits) {
    if (!scores.has(chunkId)) {
      scores.set(chunkId, 0);
    }
    usedRetrievers.add('metadata');
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
    .sort(compareSearchResults)
    .slice(0, args.resultLimit);

  return {
    query: args.query,
    scope: args.scope,
    databasePath: args.databasePath,
    extensions: args.extensions,
    retrieversUsed: RETRIEVER_ORDER.filter((retriever) =>
      usedRetrievers.has(retriever)
    ),
    vectorCandidates: vectorHits.length,
    ftsCandidates: ftsHits.length,
    lexicalCandidates: lexicalHits.length,
    metadataCandidates: metadataHits.length,
    rrfUsed:
      vectorHits.length > 0 || ftsHits.length > 0 || lexicalHits.length > 0,
    results,
  };
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
  const queryEmbedding = await args.embeddingProvider.embedQuery(args.query);
  const requireLexicalMatch = shouldRequireLexicalMatch(args.query);
  const baseCandidateLimit = Math.max(args.limit * 3, args.limit + 8);
  const maxCandidateLimit = Math.max(
    baseCandidateLimit,
    args.limit * 16,
    args.limit + 64,
    64
  );

  let candidateLimit = baseCandidateLimit;
  let response = buildSearchResponse({
    db: args.db,
    query: args.query,
    extensions,
    fetchLimit: candidateLimit,
    resultLimit: args.limit,
    scope: args.scope,
    databasePath: args.databasePath,
    queryEmbedding,
  });

  if (
    requireLexicalMatch &&
    response.ftsCandidates === 0 &&
    response.lexicalCandidates === 0 &&
    response.metadataCandidates === 0
  ) {
    return {
      ...response,
      results: [],
    };
  }

  while (
    response.results.length < args.limit &&
    candidateLimit < maxCandidateLimit
  ) {
    const nextLimit = Math.min(candidateLimit * 2, maxCandidateLimit);
    if (nextLimit === candidateLimit) {
      break;
    }

    candidateLimit = nextLimit;
    response = buildSearchResponse({
      db: args.db,
      query: args.query,
      extensions,
      fetchLimit: candidateLimit,
      resultLimit: args.limit,
      scope: args.scope,
      databasePath: args.databasePath,
      queryEmbedding,
    });

    if (
      requireLexicalMatch &&
      response.ftsCandidates === 0 &&
      response.lexicalCandidates === 0 &&
      response.metadataCandidates === 0
    ) {
      return {
        ...response,
        results: [],
      };
    }
  }

  return response;
}
