import type { Database } from 'bun:sqlite';
import {
  getSearchHits,
  searchFts,
  searchLike,
  searchVector,
} from '../../db/database';
import type { EmbeddingProvider } from '../../providers/types';
import type { ScopeMode } from '../../types/config';
import { makeSnippet } from '../../utils/text';

export type SearchResult = {
  chunkId: number;
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
  results: SearchResult[];
};

const RRF_K = 60;

function reciprocalRank(rank: number): number {
  return 1 / (RRF_K + rank);
}

export async function searchIndex(args: {
  db: Database;
  embeddingProvider: EmbeddingProvider;
  query: string;
  limit: number;
  scope: ScopeMode;
  databasePath: string;
}): Promise<SearchResponse> {
  const queryEmbedding = await args.embeddingProvider.embedQuery(args.query);
  const vectorHits = searchVector(args.db, queryEmbedding, args.limit);
  const ftsHits = searchFts(args.db, args.query, args.limit);
  const lexicalHits =
    ftsHits.length > 0 ? [] : searchLike(args.db, args.query, args.limit);

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

  const rankedIds = [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, args.limit);

  const rows = getSearchHits(
    args.db,
    rankedIds.map(([chunkId]) => chunkId)
  );
  const rowMap = new Map(rows.map((row) => [row.id, row]));

  const results = rankedIds.flatMap(([chunkId, score]) => {
    const row = rowMap.get(chunkId);
    if (!row) {
      return [];
    }
    return [
      {
        chunkId,
        path: row.path,
        section: row.section,
        snippet: makeSnippet(row.content),
        score,
        sourceKind: row.sourceKind,
      },
    ];
  });

  return {
    query: args.query,
    scope: args.scope,
    databasePath: args.databasePath,
    results,
  };
}
