import type { Database } from 'bun:sqlite';
import { z } from 'zod';

import { getSearchHits } from '../../db/database';
import type { EmbeddingProvider, LlmProvider } from '../../providers/types';
import type { ScopeMode } from '../../types/config';
import { redactText } from '../../utils/redaction';
import { type SearchResult, searchIndex } from './search-index';

type PlannerResult = {
  enough: boolean;
  rationale: string;
  queries: string[];
  structuredOutputFallbackUsed: boolean;
};

type AnswerResult = {
  answer: string;
  citationIds: number[];
  structuredOutputFallbackUsed: boolean;
};

type EvidenceRecord = SearchResult & {
  evidenceId: number;
  excerpt: string;
};

type EvidenceOutput = {
  evidenceId: number;
  chunkId: number;
  documentId: number;
  sourceKey: string;
  path: string;
  section: string;
  snippet: string;
  excerpt: string;
  score: number;
  sourceKind: string;
};

type CitationOutput = EvidenceOutput & {
  quote: string;
};

export type AiSearchResponse = {
  query: string;
  scope: ScopeMode;
  databasePath: string;
  answer: string;
  usedQueries: string[];
  iterations: number;
  citations: CitationOutput[];
  evidence: EvidenceOutput[];
  structuredOutputFallbackUsed: boolean;
};

const plannerSchema = z.object({
  enough: z.boolean(),
  rationale: z.string().default(''),
  queries: z.array(z.string()).default([]),
});

const answerSchema = z.object({
  answer: z.string(),
  citationIds: z.array(z.coerce.number().int().positive()).default([]),
});

function formatEvidence(evidence: EvidenceRecord[]): string {
  if (evidence.length === 0) {
    return 'No evidence retrieved yet.';
  }

  return evidence
    .map(
      (item) =>
        `[${item.evidenceId}] chunk=${item.chunkId} doc=${item.documentId} path=${redactText(item.path)} section=${redactText(item.section)} score=${item.score.toFixed(
          6
        )}\nexcerpt:\n${redactText(item.excerpt)}`
    )
    .join('\n\n');
}

function dedupeQueries(queries: string[], usedQueries: string[]): string[] {
  const seen = new Set(usedQueries.map((query) => query.trim().toLowerCase()));
  const result: string[] = [];

  for (const query of queries) {
    const trimmed = query.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function mergeEvidence(
  evidenceMap: Map<number, EvidenceRecord>,
  results: SearchResult[],
  excerptMap: Map<number, string>
): void {
  for (const item of results) {
    const excerpt = excerptMap.get(item.chunkId);
    if (excerpt === undefined) {
      continue;
    }

    const existing = evidenceMap.get(item.chunkId);
    if (!existing || item.score > existing.score) {
      evidenceMap.set(item.chunkId, {
        evidenceId: existing?.evidenceId ?? evidenceMap.size + 1,
        ...item,
        excerpt,
      });
    }
  }
}

function rankEvidence(
  evidenceMap: Map<number, EvidenceRecord>,
  maxEvidenceChunks: number
): EvidenceRecord[] {
  return [...evidenceMap.values()]
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (Math.abs(scoreDelta) > 1e-12) {
        return scoreDelta;
      }

      if (left.documentId !== right.documentId) {
        return left.documentId - right.documentId;
      }

      return left.chunkId - right.chunkId;
    })
    .slice(0, maxEvidenceChunks)
    .map((item, index) => ({
      ...item,
      evidenceId: index + 1,
    }));
}

async function planQueries(args: {
  llmProvider: LlmProvider;
  userQuery: string;
  usedQueries: string[];
  evidence: EvidenceRecord[];
  maxQueriesPerStep: number;
}): Promise<PlannerResult> {
  const prompt = [
    `User question: ${redactText(args.userQuery)}`,
    '',
    `Previously used queries: ${
      args.usedQueries.length > 0
        ? args.usedQueries.map((query) => redactText(query)).join(' | ')
        : 'none'
    }`,
    '',
    'Current evidence:',
    formatEvidence(args.evidence),
    '',
    `Return at most ${args.maxQueriesPerStep} focused retrieval queries.`,
    'If the current evidence is already sufficient to answer the question, set enough=true and return an empty queries array.',
    'Only search the local knowledge base. Do not suggest web searches.',
  ].join('\n');

  const result = await args.llmProvider.generateObjectWithFallback({
    system:
      'You are a retrieval planner. Produce concise search queries for a local knowledge base. Never answer the question directly here.',
    prompt,
    schema: plannerSchema,
    schemaName: 'ai_search_planner',
    schemaDescription:
      'Plans the next retrieval queries for a local knowledge base search loop.',
  });

  return {
    enough: result.object.enough,
    rationale: result.object.rationale,
    queries: result.object.queries.slice(0, args.maxQueriesPerStep),
    structuredOutputFallbackUsed: result.structuredOutputFallbackUsed,
  };
}

async function synthesizeAnswer(args: {
  llmProvider: LlmProvider;
  userQuery: string;
  evidence: EvidenceRecord[];
}): Promise<AnswerResult> {
  if (args.evidence.length === 0) {
    return {
      answer: '未在当前本地知识库中找到足够证据来回答这个问题。',
      citationIds: [],
      structuredOutputFallbackUsed: false,
    };
  }

  const prompt = [
    `User question: ${redactText(args.userQuery)}`,
    '',
    'Evidence:',
    formatEvidence(args.evidence),
    '',
    'Answer only using the evidence above.',
    'If evidence is incomplete, clearly say so.',
    'The citationIds array must only contain evidence ids that directly support the answer.',
  ].join('\n');

  const result = await args.llmProvider.generateObjectWithFallback({
    system:
      'You are a grounded answerer. Use only the provided local knowledge base evidence. Do not invent facts or citations.',
    prompt,
    schema: answerSchema,
    schemaName: 'ai_search_answer',
    schemaDescription:
      'Produces a grounded answer and the ids of evidence items that support it.',
  });

  return {
    answer: result.object.answer,
    citationIds: result.object.citationIds,
    structuredOutputFallbackUsed: result.structuredOutputFallbackUsed,
  };
}

export async function aiSearchIndex(args: {
  db: Database;
  embeddingProvider: EmbeddingProvider;
  llmProvider: LlmProvider;
  query: string;
  limit: number;
  scope: ScopeMode;
  databasePath: string;
  maxSteps: number;
  maxQueriesPerStep: number;
  maxEvidenceChunks: number;
}): Promise<AiSearchResponse> {
  const usedQueries: string[] = [];
  const evidenceMap = new Map<number, EvidenceRecord>();
  let iterations = 0;
  let structuredOutputFallbackUsed = false;

  for (let step = 0; step < args.maxSteps; step += 1) {
    const currentEvidence = rankEvidence(evidenceMap, args.maxEvidenceChunks);
    const planner = await planQueries({
      llmProvider: args.llmProvider,
      userQuery: args.query,
      usedQueries,
      evidence: currentEvidence,
      maxQueriesPerStep: args.maxQueriesPerStep,
    });
    structuredOutputFallbackUsed ||= planner.structuredOutputFallbackUsed;

    let queries = dedupeQueries(planner.queries, usedQueries).slice(
      0,
      args.maxQueriesPerStep
    );

    if (queries.length === 0 && usedQueries.length === 0) {
      queries = [args.query];
    }

    if (planner.enough && queries.length === 0) {
      iterations = step;
      break;
    }

    if (queries.length === 0) {
      iterations = step;
      break;
    }

    for (const query of queries) {
      usedQueries.push(query);
      const results = await searchIndex({
        db: args.db,
        embeddingProvider: args.embeddingProvider,
        query,
        limit: args.limit,
        scope: args.scope,
        databasePath: args.databasePath,
      });

      const searchHits = getSearchHits(
        args.db,
        results.results.map((result) => result.chunkId)
      );
      const excerptMap = new Map(
        searchHits.map((hit) => [hit.id, hit.content.trim()])
      );

      mergeEvidence(evidenceMap, results.results, excerptMap);
    }

    iterations = step + 1;

    if (planner.enough) {
      break;
    }
  }

  const rankedEvidence = rankEvidence(evidenceMap, args.maxEvidenceChunks);
  const answer = await synthesizeAnswer({
    llmProvider: args.llmProvider,
    userQuery: args.query,
    evidence: rankedEvidence,
  });
  structuredOutputFallbackUsed ||= answer.structuredOutputFallbackUsed;

  const citations = rankedEvidence.filter((item) =>
    answer.citationIds.includes(item.evidenceId)
  );

  return {
    query: args.query,
    scope: args.scope,
    databasePath: args.databasePath,
    answer: answer.answer,
    usedQueries,
    iterations,
    citations: citations.map((item) => ({
      evidenceId: item.evidenceId,
      chunkId: item.chunkId,
      documentId: item.documentId,
      sourceKey: item.sourceKey,
      path: item.path,
      section: item.section,
      snippet: item.snippet,
      excerpt: item.excerpt,
      quote: item.snippet,
      score: item.score,
      sourceKind: item.sourceKind,
    })),
    evidence: rankedEvidence.map((item) => ({
      evidenceId: item.evidenceId,
      chunkId: item.chunkId,
      documentId: item.documentId,
      sourceKey: item.sourceKey,
      path: item.path,
      section: item.section,
      snippet: item.snippet,
      excerpt: item.excerpt,
      score: item.score,
      sourceKind: item.sourceKind,
    })),
    structuredOutputFallbackUsed,
  };
}
