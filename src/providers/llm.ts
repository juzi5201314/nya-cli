import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import {
  APICallError,
  generateObject,
  generateText,
  NoObjectGeneratedError,
} from 'ai';
import type { z } from 'zod';
import type { ProgressReporter, TokenUsage } from '../tui/types';
import type { AppConfig } from '../types/config';
import { createFetchWithPolicies } from '../utils/fetch';
import { estimateTokens } from '../utils/text';
import type { GeneratedObjectWithFallback, LlmProvider } from './types';

type LanguageModelArg = Parameters<typeof generateText>[0]['model'];

type GenerateObjectImpl = <T>(args: {
  model: LanguageModelArg;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName?: string;
  schemaDescription?: string;
  maxRetries?: number;
}) => Promise<{
  object: T;
  usage?: TokenUsage;
}>;

type GenerateTextImpl = (args: {
  model: LanguageModelArg;
  system: string;
  prompt: string;
  maxRetries?: number;
}) => Promise<{
  text: string;
  usage?: TokenUsage;
}>;

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量: ${name}`);
  }
  return value;
}

function extractJsonCandidate(text: string): string {
  const fenced = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    return text.slice(objectStart, objectEnd + 1);
  }

  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return text.slice(arrayStart, arrayEnd + 1);
  }

  return text.trim();
}

export async function generateObjectWithFallback<T>(args: {
  model?: LanguageModelArg;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName?: string;
  schemaDescription?: string;
  generateObjectImpl?: GenerateObjectImpl;
  generateTextImpl?: GenerateTextImpl;
  progress?: ProgressReporter;
}): Promise<GeneratedObjectWithFallback<T>> {
  try {
    const generateObjectFn: GenerateObjectImpl =
      args.generateObjectImpl ?? (generateObject as GenerateObjectImpl);
    const result = await generateObjectFn({
      model: args.model as LanguageModelArg,
      system: args.system,
      prompt: args.prompt,
      schema: args.schema,
      ...(args.schemaName ? { schemaName: args.schemaName } : {}),
      ...(args.schemaDescription
        ? { schemaDescription: args.schemaDescription }
        : {}),
      maxRetries: 0,
    });
    const usage = result.usage as TokenUsage | undefined;
    if (usage && Number.isFinite(usage.totalTokens ?? NaN)) {
      args.progress?.addLlmUsage(usage, false);
    } else {
      const input = estimateTokens([args.system, args.prompt].join('\n'));
      args.progress?.addLlmUsage(
        { inputTokens: input, outputTokens: 0, totalTokens: input },
        true
      );
    }
    return {
      object: result.object,
      structuredOutputFallbackUsed: false,
    };
  } catch (error) {
    if (!shouldFallbackToTextParse(error)) {
      throw error;
    }

    const generateTextFn: GenerateTextImpl =
      args.generateTextImpl ?? (generateText as GenerateTextImpl);
    const textResult = await generateTextFn({
      model: args.model as LanguageModelArg,
      system: args.system,
      prompt: [
        args.prompt,
        '',
        'Return only valid JSON that matches the requested schema. Do not include markdown code fences.',
      ].join('\n'),
      maxRetries: 0,
    });
    const usage = textResult.usage as TokenUsage | undefined;
    if (usage && Number.isFinite(usage.totalTokens ?? NaN)) {
      args.progress?.addLlmUsage(usage, false);
    } else {
      const input = estimateTokens([args.system, args.prompt].join('\n'));
      const output = estimateTokens(textResult.text);
      args.progress?.addLlmUsage(
        {
          inputTokens: input,
          outputTokens: output,
          totalTokens: input + output,
        },
        true
      );
    }
    const json = JSON.parse(extractJsonCandidate(textResult.text));
    return {
      object: args.schema.parse(json),
      structuredOutputFallbackUsed: true,
    };
  }
}

const structuredOutputCompatibilityHints = [
  'json mode',
  'response mime type',
  'response_mime_type',
  'structured output',
  'structured outputs',
  'response format',
  'response_format',
  'application/json',
  'json schema',
  'schema is not supported',
  'not supported',
  'unsupported',
  'content-filter',
  'content filter',
];

function collectErrorText(
  error: unknown,
  seen = new WeakSet<object>()
): string {
  if (error == null) {
    return '';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (typeof error !== 'object') {
    return String(error);
  }

  if (seen.has(error)) {
    return '';
  }
  seen.add(error);

  const parts: string[] = [];
  const record = error as Record<string, unknown>;

  for (const key of [
    'name',
    'message',
    'statusCode',
    'responseBody',
    'finishReason',
    'text',
  ]) {
    const value = record[key];
    if (value != null) {
      parts.push(String(value));
    }
  }

  if (record.data != null) {
    try {
      parts.push(JSON.stringify(record.data));
    } catch {
      parts.push(String(record.data));
    }
  }

  if (record.cause != null) {
    parts.push(collectErrorText(record.cause, seen));
  }

  return parts.join('\n');
}

function shouldFallbackToTextParse(error: unknown): boolean {
  const haystack = collectErrorText(error).toLowerCase();
  if (
    !structuredOutputCompatibilityHints.some((hint) => haystack.includes(hint))
  ) {
    return false;
  }

  if (APICallError.isInstance(error)) {
    return (
      error.statusCode === 400 ||
      error.statusCode === 406 ||
      error.statusCode === 415
    );
  }

  return NoObjectGeneratedError.isInstance(error);
}

export function createLlmProvider(
  config: AppConfig,
  progress?: ProgressReporter
): LlmProvider {
  switch (config.llm.provider) {
    case 'google': {
      const providerConfig = config.llm.providers.google;
      const google = createGoogleGenerativeAI({
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
      const model = google(config.llm.model);
      return {
        id: 'google',
        model: config.llm.model,
        async generateText(args) {
          const result = await generateText({
            model,
            system: args.system,
            prompt: args.prompt,
            maxRetries: 0,
          });
          const usage = result.usage as TokenUsage;
          if (Number.isFinite(usage.totalTokens ?? NaN)) {
            progress?.addLlmUsage(usage, false);
          } else {
            const input = estimateTokens([args.system, args.prompt].join('\n'));
            const output = estimateTokens(result.text);
            progress?.addLlmUsage(
              {
                inputTokens: input,
                outputTokens: output,
                totalTokens: input + output,
              },
              true
            );
          }
          return {
            text: result.text,
          };
        },
        async generateObject<T>(args: {
          system: string;
          prompt: string;
          schema: z.ZodType<T>;
          schemaName?: string;
          schemaDescription?: string;
        }): Promise<T> {
          return (
            await generateObjectWithFallback({
              model,
              system: args.system,
              prompt: args.prompt,
              schema: args.schema,
              ...(args.schemaName ? { schemaName: args.schemaName } : {}),
              ...(args.schemaDescription
                ? { schemaDescription: args.schemaDescription }
                : {}),
              ...(progress ? { progress } : {}),
            })
          ).object;
        },
        async generateObjectWithFallback<T>(args: {
          system: string;
          prompt: string;
          schema: z.ZodType<T>;
          schemaName?: string;
          schemaDescription?: string;
        }): Promise<GeneratedObjectWithFallback<T>> {
          return generateObjectWithFallback({
            model,
            system: args.system,
            prompt: args.prompt,
            schema: args.schema,
            ...(args.schemaName ? { schemaName: args.schemaName } : {}),
            ...(args.schemaDescription
              ? { schemaDescription: args.schemaDescription }
              : {}),
            ...(progress ? { progress } : {}),
          });
        },
      };
    }
    case 'openai': {
      const providerConfig = config.llm.providers.openai;
      const openai = createOpenAI({
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
      const model = openai(config.llm.model);
      return {
        id: 'openai',
        model: config.llm.model,
        async generateText(args) {
          const result = await generateText({
            model,
            system: args.system,
            prompt: args.prompt,
            maxRetries: 0,
          });
          const usage = result.usage as TokenUsage;
          if (Number.isFinite(usage.totalTokens ?? NaN)) {
            progress?.addLlmUsage(usage, false);
          } else {
            const input = estimateTokens([args.system, args.prompt].join('\n'));
            const output = estimateTokens(result.text);
            progress?.addLlmUsage(
              {
                inputTokens: input,
                outputTokens: output,
                totalTokens: input + output,
              },
              true
            );
          }
          return {
            text: result.text,
          };
        },
        async generateObject<T>(args: {
          system: string;
          prompt: string;
          schema: z.ZodType<T>;
          schemaName?: string;
          schemaDescription?: string;
        }): Promise<T> {
          return (
            await generateObjectWithFallback({
              model,
              system: args.system,
              prompt: args.prompt,
              schema: args.schema,
              ...(args.schemaName ? { schemaName: args.schemaName } : {}),
              ...(args.schemaDescription
                ? { schemaDescription: args.schemaDescription }
                : {}),
              ...(progress ? { progress } : {}),
            })
          ).object;
        },
        async generateObjectWithFallback<T>(args: {
          system: string;
          prompt: string;
          schema: z.ZodType<T>;
          schemaName?: string;
          schemaDescription?: string;
        }): Promise<GeneratedObjectWithFallback<T>> {
          return generateObjectWithFallback({
            model,
            system: args.system,
            prompt: args.prompt,
            schema: args.schema,
            ...(args.schemaName ? { schemaName: args.schemaName } : {}),
            ...(args.schemaDescription
              ? { schemaDescription: args.schemaDescription }
              : {}),
            ...(progress ? { progress } : {}),
          });
        },
      };
    }
  }
}
