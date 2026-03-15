import type { Database } from 'bun:sqlite';
import { z } from 'zod';

import type { EmbeddingProvider, LlmProvider } from '../../providers/types';
import type { ScopeMode } from '../../types/config';
import { type SearchResult, searchIndex } from './search-index';

type PlannerResult = {
  enough: boolean;
  rationale: string;
  queries: string[];
};

type AnswerResult = {
  answer: string;
  citationIds: number[];
};

type EvidenceRecord = SearchResult & {
  evidenceId: number;
};

export type AiSearchResponse = {
  query: string;
  scope: ScopeMode;
  databasePath: string;
  answer: string;
  usedQueries: string[];
  iterations: number;
  citations: Array<{
    evidenceId: number;
    documentId: number;
    sourceKey: string;
    path: string;
    section: string;
    snippet: string;
    score: number;
    sourceKind: string;
  }>;
  evidence: Array<{
    evidenceId: number;
    documentId: number;
    sourceKey: string;
    path: string;
    section: string;
    snippet: string;
    score: number;
    sourceKind: string;
  }>;
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
        `[${item.evidenceId}] path=${item.path} section=${item.section} score=${item.score.toFixed(
          6
        )}\n${item.snippet}`
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
  results: SearchResult[]
): void {
  for (const item of results) {
    const existing = evidenceMap.get(item.chunkId);
    if (!existing || item.score > existing.score) {
      evidenceMap.set(item.chunkId, {
        evidenceId: existing?.evidenceId ?? evidenceMap.size + 1,
        ...item,
      });
    }
  }
}

function rankEvidence(
  evidenceMap: Map<number, EvidenceRecord>,
  maxEvidenceChunks: number
): EvidenceRecord[] {
  return [...evidenceMap.values()]
    .sort((left, right) => right.score - left.score)
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
    `User question: ${args.userQuery}`,
    '',
    `Previously used queries: ${
      args.usedQueries.length > 0 ? args.usedQueries.join(' | ') : 'none'
    }`,
    '',
    'Current evidence:',
    formatEvidence(args.evidence),
    '',
    `Return at most ${args.maxQueriesPerStep} focused retrieval queries.`,
    'If the current evidence is already sufficient to answer the question, set enough=true and return an empty queries array.',
    'Only search the local knowledge base. Do not suggest web searches.',
  ].join('\n');

  const result = await args.llmProvider.generateObject({
    system:
      'You are a retrieval planner. Produce concise search queries for a local knowledge base. Never answer the question directly here.',
    prompt,
    schema: plannerSchema,
    schemaName: 'ai_search_planner',
    schemaDescription:
      'Plans the next retrieval queries for a local knowledge base search loop.',
  });

  return {
    enough: result.enough,
    rationale: result.rationale,
    queries: result.queries.slice(0, args.maxQueriesPerStep),
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
    };
  }

  const prompt = [
    `User question: ${args.userQuery}`,
    '',
    'Evidence:',
    formatEvidence(args.evidence),
    '',
    'Answer only using the evidence above.',
    'If evidence is incomplete, clearly say so.',
    'The citationIds array must only contain evidence ids that directly support the answer.',
  ].join('\n');

  return args.llmProvider.generateObject({
    system:
      'You are a grounded answerer. Use only the provided local knowledge base evidence. Do not invent facts or citations.',
    prompt,
    schema: answerSchema,
    schemaName: 'ai_search_answer',
    schemaDescription:
      'Produces a grounded answer and the ids of evidence items that support it.',
  });
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

  for (let step = 0; step < args.maxSteps; step += 1) {
    const currentEvidence = rankEvidence(evidenceMap, args.maxEvidenceChunks);
    const planner = await planQueries({
      llmProvider: args.llmProvider,
      userQuery: args.query,
      usedQueries,
      evidence: currentEvidence,
      maxQueriesPerStep: args.maxQueriesPerStep,
    });

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
      mergeEvidence(evidenceMap, results.results);
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
      documentId: item.documentId,
      sourceKey: item.sourceKey,
      path: item.path,
      section: item.section,
      snippet: item.snippet,
      score: item.score,
      sourceKind: item.sourceKind,
    })),
    evidence: rankedEvidence.map((item) => ({
      evidenceId: item.evidenceId,
      documentId: item.documentId,
      sourceKey: item.sourceKey,
      path: item.path,
      section: item.section,
      snippet: item.snippet,
      score: item.score,
      sourceKind: item.sourceKind,
    })),
  };
}
