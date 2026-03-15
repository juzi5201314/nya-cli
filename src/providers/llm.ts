import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, generateText } from 'ai';
import type { z } from 'zod';

import type { AppConfig } from '../types/config';
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
}): Promise<T> {
  try {
    const result = await generateObject({
      model: args.model,
      system: args.system,
      prompt: args.prompt,
      schema: args.schema,
      schemaName: args.schemaName,
      schemaDescription: args.schemaDescription,
    });
    return result.object;
  } catch {
    const textResult = await generateText({
      model: args.model,
      system: args.system,
      prompt: [
        args.prompt,
        '',
        'Return only valid JSON that matches the requested schema. Do not include markdown code fences.',
      ].join('\n'),
    });
    const json = JSON.parse(extractJsonCandidate(textResult.text));
    return args.schema.parse(json);
  }
}

export function createLlmProvider(config: AppConfig): LlmProvider {
  switch (config.llm.provider) {
    case 'google': {
      const google = createGoogleGenerativeAI({
        apiKey: readRequiredEnv(config.llm.providers.google.api_key_env),
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
          });
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
          });
        },
      };
    }
    case 'openai': {
      const openai = createOpenAI({
        apiKey: readRequiredEnv(config.llm.providers.openai.api_key_env),
        baseURL: config.llm.providers.openai.base_url,
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
          });
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
          });
        },
      };
    }
  }
}
