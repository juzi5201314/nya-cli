import { describe, expect, test } from 'bun:test';

import { appConfigSchema } from '../src/config/schema';

describe('config schema', () => {
  test('parses default sample config', () => {
    const parsed = Bun.TOML.parse(`
[app]
default_output = "text"
project_dir_name = ".nya-cli"

[web.search]
provider = "tavily"

[web.search.providers.tavily]
api_key_env = "TAVILY_API_KEY"
default_topic = "general"
default_search_depth = "basic"

[web.ingest]
provider = "scrapling"

[web.ingest.providers.scrapling]
command = "scrapling"
default_fetch_mode = "auto"
default_crawl = false
default_max_pages = 25
default_max_depth = 2
same_origin_only = true
min_markdown_chars = 200
get_timeout_seconds = 30
fetch_timeout_ms = 30000
fetch_wait_ms = 0

[embedding]
provider = "google"
model = "gemini-embedding-001"
task_type = "RETRIEVAL_DOCUMENT"

[embedding.providers.google]
api_key_env = "GOOGLE_GENERATIVE_AI_API_KEY"
output_dimensionality = 1536

[embedding.providers.openai]
api_key_env = "OPENAI_API_KEY"
base_url = "https://api.openai.com/v1"
dimensions = 1536

[rerank]
provider = "none"

[llm]
provider = "google"
model = "gemini-2.5-flash"

[llm.providers.google]
api_key_env = "GOOGLE_GENERATIVE_AI_API_KEY"

[llm.providers.openai]
api_key_env = "OPENAI_API_KEY"
base_url = "https://api.openai.com/v1"

[ai_search]
max_steps = 3
max_queries_per_step = 3
retrieval_limit = 8
max_evidence_chunks = 12

[index]
chunk_size = 1200
chunk_overlap = 150
chunking_version = "v1"
fts = true
vector = true
max_file_bytes = 262144
`);

    const result = appConfigSchema.parse(parsed);
    expect(result.embedding.provider).toBe('google');
    expect(result.web.search.provider).toBe('tavily');
    expect(result.web.ingest.provider).toBe('scrapling');
    expect(result.ai_search.max_steps).toBe(3);
    expect(result.index.chunking_version).toBe('v1');
  });
});
