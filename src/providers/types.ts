import type { z } from 'zod';

import type { AppConfig, WebFetchMode } from '../types/config';

export type EmbeddingFingerprint = {
  provider: string;
  model: string;
  dimensions: number;
  taskType: string;
  chunkingVersion: string;
  chunker: 'tree-sitter';
};

export type EmbeddingProvider = {
  readonly id: AppConfig['embedding']['provider'];
  readonly model: string;
  readonly dimensions: number;
  embedDocuments(values: string[]): Promise<number[][]>;
  embedQuery(value: string): Promise<number[]>;
  fingerprint(chunkingVersion: string): EmbeddingFingerprint;
};

export type LlmProvider = {
  readonly id: AppConfig['llm']['provider'];
  readonly model: string;
  generateText(args: {
    system: string;
    prompt: string;
  }): Promise<{ text: string }>;
  generateObject<T>(args: {
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    schemaName?: string;
    schemaDescription?: string;
  }): Promise<T>;
  generateObjectWithFallback<T>(args: {
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    schemaName?: string;
    schemaDescription?: string;
  }): Promise<GeneratedObjectWithFallback<T>>;
};

export type GeneratedObjectWithFallback<T> = {
  object: T;
  structuredOutputFallbackUsed: boolean;
};

export type WebSearchResult = {
  title: string;
  url: string;
  content: string;
  score: number | undefined;
};

export type WebSearchProvider = {
  readonly id: AppConfig['web']['search']['provider'];
  search(query: string): Promise<WebSearchResult[]>;
};

export type WebFetchedPage = {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  canonicalUrl: string | null;
  markdown: string;
  html: string;
  links: string[];
  fetchModeUsed: Exclude<WebFetchMode, 'auto'>;
};

export type WebIngestProvider = {
  readonly id: AppConfig['web']['ingest']['provider'];
  assertAvailable(): Promise<void>;
  fetchPage(
    url: string,
    options: {
      fetchMode: WebFetchMode;
      runTempDir?: string;
    }
  ): Promise<WebFetchedPage>;
  crawl?(
    url: string,
    options: {
      maxPages: number;
      maxDepth: number;
      fetchMode: WebFetchMode;
    }
  ): Promise<WebFetchedPage[]>;
};
