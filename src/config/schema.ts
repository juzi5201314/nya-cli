import { z } from 'zod';

const outputFormatSchema = z.enum(['text', 'json']);
const webSearchProviderSchema = z.enum(['tavily']);
const webIngestProviderSchema = z.enum(['scrapling', 'cloudflare']);
const embeddingProviderSchema = z.enum(['google', 'openai']);
const llmProviderSchema = z.enum(['google', 'openai']);
const rerankProviderSchema = z.enum(['none']);
const webFetchModeSchema = z.enum(['auto', 'get', 'fetch']);

const rateLimitFields = {
  // requests per minute, 0 = unlimited
  rpm: z.number().int().min(0).default(0),
  // tokens per minute, 0 = unlimited
  tpm: z.number().int().min(0).default(0),
};

const retryFields = {
  // 额外重试次数（不含首次请求）
  retry_max_retries: z.number().int().min(0).max(20).default(3),
  // 每次重试的基础等待时间（秒）
  retry_delay_seconds: z.number().int().min(0).max(600).default(10),
};

export const appConfigSchema = z.object({
  app: z.object({
    default_output: outputFormatSchema.default('text'),
    project_dir_name: z.string().min(1).default('.nya-cli'),
  }),
  web: z.object({
    search: z.object({
      provider: webSearchProviderSchema.default('tavily'),
      providers: z.object({
        tavily: z.object({
          api_key_env: z.string().min(1).default('TAVILY_API_KEY'),
          default_topic: z
            .enum(['general', 'news', 'finance'])
            .default('general'),
          default_search_depth: z
            .enum(['advanced', 'basic', 'fast', 'ultra-fast'])
            .default('basic'),
          ...rateLimitFields,
          ...retryFields,
        }),
      }),
    }),
    ingest: z.object({
      provider: webIngestProviderSchema.default('scrapling'),
      providers: z.object({
        scrapling: z
          .object({
            command: z.string().min(1).default('scrapling'),
            default_fetch_mode: webFetchModeSchema.default('auto'),
            default_crawl: z.boolean().default(false),
            default_max_pages: z.number().int().min(1).max(500).default(25),
            default_max_depth: z.number().int().min(0).max(10).default(2),
            same_origin_only: z.boolean().default(true),
            min_markdown_chars: z.number().int().min(1).default(200),
            get_timeout_seconds: z.number().int().min(1).max(300).default(30),
            fetch_timeout_ms: z
              .number()
              .int()
              .min(1000)
              .max(300000)
              .default(30000),
            fetch_wait_ms: z.number().int().min(0).max(120000).default(0),
            ...rateLimitFields,
            ...retryFields,
          })
          .default({
            command: 'scrapling',
            default_fetch_mode: 'auto',
            default_crawl: false,
            default_max_pages: 25,
            default_max_depth: 2,
            same_origin_only: true,
            min_markdown_chars: 200,
            get_timeout_seconds: 30,
            fetch_timeout_ms: 30000,
            fetch_wait_ms: 0,
            rpm: 0,
            tpm: 0,
            retry_max_retries: 3,
            retry_delay_seconds: 10,
          }),
        cloudflare: z
          .object({
            account_id: z.string().default(''),
            api_token_env: z.string().min(1).default('CLOUDFLARE_API_TOKEN'),
            base_url: z
              .string()
              .url()
              .default('https://api.cloudflare.com/client/v4'),
            default_fetch_mode: webFetchModeSchema.default('get'),
            default_crawl: z.boolean().default(false),
            default_max_pages: z.number().int().min(1).max(100000).default(25),
            default_max_depth: z.number().int().min(0).max(100000).default(2),
            min_markdown_chars: z.number().int().min(1).default(200),
            poll_interval_ms: z
              .number()
              .int()
              .min(250)
              .max(30000)
              .default(10000),
            max_poll_attempts: z.number().int().min(1).max(1000).default(60),
            source: z.enum(['all', 'sitemaps', 'links']).default('all'),
            include_external_links: z.boolean().default(false),
            include_subdomains: z.boolean().default(false),
            include_patterns: z.array(z.string().min(1)).default([]),
            exclude_patterns: z.array(z.string().min(1)).default([]),
            ...rateLimitFields,
            ...retryFields,
          })
          .default({
            account_id: '',
            api_token_env: 'CLOUDFLARE_API_TOKEN',
            base_url: 'https://api.cloudflare.com/client/v4',
            default_fetch_mode: 'get',
            default_crawl: false,
            default_max_pages: 25,
            default_max_depth: 2,
            min_markdown_chars: 200,
            poll_interval_ms: 10000,
            max_poll_attempts: 60,
            source: 'all',
            include_external_links: false,
            include_subdomains: false,
            include_patterns: [],
            exclude_patterns: [],
            rpm: 0,
            tpm: 0,
            retry_max_retries: 3,
            retry_delay_seconds: 10,
          }),
      }),
    }),
  }),
  embedding: z.object({
    provider: embeddingProviderSchema.default('google'),
    model: z.string().min(1),
    task_type: z
      .enum([
        'RETRIEVAL_DOCUMENT',
        'SEMANTIC_SIMILARITY',
        'CLASSIFICATION',
        'CLUSTERING',
        'QUESTION_ANSWERING',
        'FACT_VERIFICATION',
      ])
      .default('RETRIEVAL_DOCUMENT'),
    providers: z.object({
      google: z.object({
        api_key_env: z.string().min(1).default('GOOGLE_GENERATIVE_AI_API_KEY'),
        output_dimensionality: z.number().int().min(128).max(3072),
        ...rateLimitFields,
        ...retryFields,
      }),
      openai: z.object({
        api_key_env: z.string().min(1).default('OPENAI_API_KEY'),
        base_url: z.string().url().default('https://api.openai.com/v1'),
        dimensions: z.number().int().min(1),
        ...rateLimitFields,
        ...retryFields,
      }),
    }),
  }),
  rerank: z.object({
    provider: rerankProviderSchema.default('none'),
  }),
  llm: z.object({
    provider: llmProviderSchema.default('google'),
    model: z.string().min(1),
    providers: z.object({
      google: z.object({
        api_key_env: z.string().min(1).default('GOOGLE_GENERATIVE_AI_API_KEY'),
        ...rateLimitFields,
        ...retryFields,
      }),
      openai: z.object({
        api_key_env: z.string().min(1).default('OPENAI_API_KEY'),
        base_url: z.string().url().default('https://api.openai.com/v1'),
        ...rateLimitFields,
        ...retryFields,
      }),
    }),
  }),
  ai_search: z.object({
    max_steps: z.number().int().min(1).max(10).default(3),
    max_queries_per_step: z.number().int().min(1).max(10).default(3),
    retrieval_limit: z.number().int().min(1).max(50).default(8),
    max_evidence_chunks: z.number().int().min(1).max(50).default(12),
  }),
  index: z.object({
    chunk_size: z.number().int().min(200).max(16000).default(1200),
    chunk_overlap: z.number().int().min(0).max(4000).default(150),
    chunking_version: z.string().min(1).default('v1'),
    fts: z.boolean().default(true),
    vector: z.boolean().default(true),
    max_file_bytes: z.number().int().min(1024).default(262144),
  }),
});
