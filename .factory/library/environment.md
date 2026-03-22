# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** required env vars, external API keys/services, dependency quirks.
**What does NOT belong here:** service ports/commands (use `.factory/services.yaml`).

---

## Required tools
- `bun`
- `git`
- (Optional for real web ingest) `crwl` (Crawl4AI CLI)

## Environment variables
- `GOOGLE_GENERATIVE_AI_API_KEY` (only required for real Google smoke)
- `OPENAI_API_KEY` (only if OpenAI provider is selected)
- `TAVILY_API_KEY` (only for `nya web search`)
- `CLOUDFLARE_API_TOKEN` (only for Cloudflare ingest)

## Secret handling
- Never print secret values.
- Treat URL userinfo and sensitive query/fragment params as secrets; always redact.
