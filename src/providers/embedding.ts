import {
  createGoogleGenerativeAI,
  type GoogleEmbeddingModelOptions,
} from '@ai-sdk/google';
import { createOpenAI, type OpenAIEmbeddingModelOptions } from '@ai-sdk/openai';
import { embed, embedMany } from 'ai';
import type { ProgressReporter } from '../tui/types';
import type { AppConfig } from '../types/config';
import { createFetchWithPolicies } from '../utils/fetch';
import { estimateTokens } from '../utils/text';
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
  private readonly progress: ProgressReporter | undefined;

  constructor(config: AppConfig, progress?: ProgressReporter) {
    const providerConfig = config.embedding.providers.google;
    this.model = config.embedding.model;
    this.dimensions = providerConfig.output_dimensionality;
    this.documentTaskType = resolveDocumentTask(config.embedding.task_type);
    this.queryTaskType = resolveQueryTask(config.embedding.task_type);
    this.progress = progress;
    this.provider = createGoogleGenerativeAI({
      apiKey: readRequiredEnv(providerConfig.api_key_env),
      fetch: createFetchWithPolicies({
        rateLimit: {
          rpm: providerConfig.rpm,
          tpm: providerConfig.tpm,
        },
        retry: {
          maxRetries: providerConfig.retry_max_retries,
          delayMs: providerConfig.retry_delay_seconds * 1000,
        },
      }),
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
      maxRetries: 0,
      providerOptions: {
        google: {
          outputDimensionality: this.dimensions,
          taskType: this
            .documentTaskType as GoogleEmbeddingModelOptions['taskType'],
        } satisfies GoogleEmbeddingModelOptions,
      },
    });

    const usageTokens = result.usage.tokens;
    if (Number.isFinite(usageTokens) && usageTokens > 0) {
      this.progress?.addEmbeddingTokens(usageTokens, false);
    } else {
      const estimated = values.reduce(
        (sum, value) => sum + estimateTokens(value),
        0
      );
      this.progress?.addEmbeddingTokens(estimated, true);
    }
    return result.embeddings;
  }

  async embedQuery(value: string): Promise<number[]> {
    const result = await embed({
      model: this.provider.embedding(this.model),
      value,
      maxRetries: 0,
      providerOptions: {
        google: {
          outputDimensionality: this.dimensions,
          taskType: this
            .queryTaskType as GoogleEmbeddingModelOptions['taskType'],
        } satisfies GoogleEmbeddingModelOptions,
      },
    });
    const usageTokens = result.usage.tokens;
    if (Number.isFinite(usageTokens) && usageTokens > 0) {
      this.progress?.addEmbeddingTokens(usageTokens, false);
    } else {
      this.progress?.addEmbeddingTokens(estimateTokens(value), true);
    }
    return result.embedding;
  }

  fingerprint(chunkingVersion: string): EmbeddingFingerprint {
    return {
      provider: this.id,
      model: this.model,
      dimensions: this.dimensions,
      taskType: this.documentTaskType,
      chunkingVersion,
      chunker: 'tree-sitter',
    };
  }
}

class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai' as const;
  readonly model: string;
  readonly dimensions: number;

  private readonly provider;
  private readonly progress: ProgressReporter | undefined;

  constructor(
    private readonly config: AppConfig,
    progress?: ProgressReporter
  ) {
    const providerConfig = config.embedding.providers.openai;
    this.model = config.embedding.model;
    this.dimensions = providerConfig.dimensions;
    this.progress = progress;
    this.provider = createOpenAI({
      apiKey: readRequiredEnv(providerConfig.api_key_env),
      baseURL: providerConfig.base_url,
      fetch: createFetchWithPolicies({
        rateLimit: {
          rpm: providerConfig.rpm,
          tpm: providerConfig.tpm,
        },
        retry: {
          maxRetries: providerConfig.retry_max_retries,
          delayMs: providerConfig.retry_delay_seconds * 1000,
        },
      }),
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
      maxRetries: 0,
      providerOptions: {
        openai: {
          dimensions: this.dimensions,
        } satisfies OpenAIEmbeddingModelOptions,
      },
    });
    const usageTokens = result.usage.tokens;
    if (Number.isFinite(usageTokens) && usageTokens > 0) {
      this.progress?.addEmbeddingTokens(usageTokens, false);
    } else {
      const estimated = values.reduce(
        (sum, value) => sum + estimateTokens(value),
        0
      );
      this.progress?.addEmbeddingTokens(estimated, true);
    }
    return result.embeddings;
  }

  async embedQuery(value: string): Promise<number[]> {
    const result = await embed({
      model: this.provider.embedding(this.model),
      value,
      maxRetries: 0,
      providerOptions: {
        openai: {
          dimensions: this.dimensions,
        } satisfies OpenAIEmbeddingModelOptions,
      },
    });
    const usageTokens = result.usage.tokens;
    if (Number.isFinite(usageTokens) && usageTokens > 0) {
      this.progress?.addEmbeddingTokens(usageTokens, false);
    } else {
      this.progress?.addEmbeddingTokens(estimateTokens(value), true);
    }
    return result.embedding;
  }

  fingerprint(chunkingVersion: string): EmbeddingFingerprint {
    return {
      provider: this.id,
      model: this.model,
      dimensions: this.dimensions,
      taskType: this.config.embedding.task_type,
      chunkingVersion,
      chunker: 'tree-sitter',
    };
  }
}

export function createEmbeddingProvider(
  config: AppConfig,
  progress?: ProgressReporter
): EmbeddingProvider {
  switch (config.embedding.provider) {
    case 'google':
      return new GoogleEmbeddingProvider(config, progress);
    case 'openai':
      return new OpenAiEmbeddingProvider(config, progress);
  }
}

export function buildEmbeddingFingerprint(
  config: AppConfig
): EmbeddingFingerprint {
  switch (config.embedding.provider) {
    case 'google':
      return {
        provider: 'google',
        model: config.embedding.model,
        dimensions: config.embedding.providers.google.output_dimensionality,
        taskType: config.embedding.task_type,
        chunkingVersion: config.index.chunking_version,
        chunker: 'tree-sitter',
      };
    case 'openai':
      return {
        provider: 'openai',
        model: config.embedding.model,
        dimensions: config.embedding.providers.openai.dimensions,
        taskType: config.embedding.task_type,
        chunkingVersion: config.index.chunking_version,
        chunker: 'tree-sitter',
      };
  }
}
