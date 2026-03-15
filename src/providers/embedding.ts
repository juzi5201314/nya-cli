import {
  createGoogleGenerativeAI,
  type GoogleEmbeddingModelOptions,
} from '@ai-sdk/google';
import { createOpenAI, type OpenAIEmbeddingModelOptions } from '@ai-sdk/openai';
import { embed, embedMany } from 'ai';

import type { AppConfig } from '../types/config';
import type { EmbeddingFingerprint, EmbeddingProvider } from './types';

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量: ${name}`);
  }
  return value;
}

function resolveDocumentTask(
  taskType: AppConfig['embedding']['task_type']
): string {
  return taskType;
}

function resolveQueryTask(
  taskType: AppConfig['embedding']['task_type']
): string {
  if (taskType === 'RETRIEVAL_DOCUMENT') {
    return 'RETRIEVAL_QUERY';
  }
  return taskType;
}

class GoogleEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'google' as const;
  readonly model: string;
  readonly dimensions: number;

  private readonly provider;
  private readonly documentTaskType: string;
  private readonly queryTaskType: string;

  constructor(config: AppConfig) {
    this.model = config.embedding.model;
    this.dimensions = config.embedding.providers.google.output_dimensionality;
    this.documentTaskType = resolveDocumentTask(config.embedding.task_type);
    this.queryTaskType = resolveQueryTask(config.embedding.task_type);
    this.provider = createGoogleGenerativeAI({
      apiKey: readRequiredEnv(config.embedding.providers.google.api_key_env),
    });
  }

  async embedDocuments(values: string[]): Promise<number[][]> {
    if (values.length === 0) {
      return [];
    }

    const result = await embedMany({
      model: this.provider.embedding(this.model),
      values,
      maxParallelCalls: 4,
      providerOptions: {
        google: {
          outputDimensionality: this.dimensions,
          taskType: this
            .documentTaskType as GoogleEmbeddingModelOptions['taskType'],
        } satisfies GoogleEmbeddingModelOptions,
      },
    });
    return result.embeddings;
  }

  async embedQuery(value: string): Promise<number[]> {
    const result = await embed({
      model: this.provider.embedding(this.model),
      value,
      providerOptions: {
        google: {
          outputDimensionality: this.dimensions,
          taskType: this
            .queryTaskType as GoogleEmbeddingModelOptions['taskType'],
        } satisfies GoogleEmbeddingModelOptions,
      },
    });
    return result.embedding;
  }

  fingerprint(chunkingVersion: string): EmbeddingFingerprint {
    return {
      provider: this.id,
      model: this.model,
      dimensions: this.dimensions,
      taskType: this.documentTaskType,
      chunkingVersion,
    };
  }
}

class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai' as const;
  readonly model: string;
  readonly dimensions: number;

  private readonly provider;

  constructor(private readonly config: AppConfig) {
    this.model = config.embedding.model;
    this.dimensions = config.embedding.providers.openai.dimensions;
    this.provider = createOpenAI({
      apiKey: readRequiredEnv(config.embedding.providers.openai.api_key_env),
      baseURL: config.embedding.providers.openai.base_url,
    });
  }

  async embedDocuments(values: string[]): Promise<number[][]> {
    if (values.length === 0) {
      return [];
    }

    const result = await embedMany({
      model: this.provider.embedding(this.model),
      values,
      maxParallelCalls: 4,
      providerOptions: {
        openai: {
          dimensions: this.dimensions,
        } satisfies OpenAIEmbeddingModelOptions,
      },
    });
    return result.embeddings;
  }

  async embedQuery(value: string): Promise<number[]> {
    const result = await embed({
      model: this.provider.embedding(this.model),
      value,
      providerOptions: {
        openai: {
          dimensions: this.dimensions,
        } satisfies OpenAIEmbeddingModelOptions,
      },
    });
    return result.embedding;
  }

  fingerprint(chunkingVersion: string): EmbeddingFingerprint {
    return {
      provider: this.id,
      model: this.model,
      dimensions: this.dimensions,
      taskType: this.config.embedding.task_type,
      chunkingVersion,
    };
  }
}

export function createEmbeddingProvider(config: AppConfig): EmbeddingProvider {
  switch (config.embedding.provider) {
    case 'google':
      return new GoogleEmbeddingProvider(config);
    case 'openai':
      return new OpenAiEmbeddingProvider(config);
  }
}
