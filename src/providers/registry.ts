import type { AppConfig } from '../types/config';
import { createEmbeddingProvider } from './embedding';
import { createLlmProvider } from './llm';
import { createWebIngestProvider, createWebSearchProvider } from './web';

export function createProviderRegistry(config: AppConfig) {
  return {
    embedding: createEmbeddingProvider(config),
    llm: createLlmProvider(config),
    webSearch: createWebSearchProvider(config),
    webIngest: createWebIngestProvider(config),
  };
}
