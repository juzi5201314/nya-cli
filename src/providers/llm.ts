import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, generateObject, generateText } from 'ai';
import type { z } from 'zod';
import type { ProgressReporter, TokenUsage } from '../tui/types';
import type { AppConfig } from '../types/config';
import { createFetchWithPolicies } from '../utils/fetch';
import { estimateTokens } from '../utils/text';
import type { LlmProvider } from './types';

type LanguageModelArg = Parameters<typeof generateText>[0]['model'];

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

async function generateObjectWithFallback<T>(args: {
  model: LanguageModelArg;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName?: string;
  schemaDescription?: string;
  progress?: ProgressReporter;
}): Promise<T> {
  try {
    const result = await generateObject({
      model: args.model,
      system: args.system,
      prompt: args.prompt,
      schema: args.schema,
      schemaName: args.schemaName,
      schemaDescription: args.schemaDescription,
      maxRetries: 0,
    });
    const usage = result.usage as TokenUsage;
    if (Number.isFinite(usage.totalTokens ?? NaN)) {
      args.progress?.addLlmUsage(usage, false);
    } else {
      const input = estimateTokens([args.system, args.prompt].join('\n'));
      args.progress?.addLlmUsage(
        { inputTokens: input, outputTokens: 0, totalTokens: input },
        true
      );
    }
    return result.object;
  } catch (error) {
    // generateObject 失败如果来自 HTTP/API 错误（含 429），fallback 只会额外消耗一次请求
    // 这类错误应当直接抛出，让上层决定如何处理
    if (APICallError.isInstance(error)) {
      throw error;
    }

    const textResult = await generateText({
      model: args.model,
      system: args.system,
      prompt: [
        args.prompt,
        '',
        'Return only valid JSON that matches the requested schema. Do not include markdown code fences.',
      ].join('\n'),
      maxRetries: 0,
    });
    const usage = textResult.usage as TokenUsage;
    if (Number.isFinite(usage.totalTokens ?? NaN)) {
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
    return args.schema.parse(json);
  }
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
