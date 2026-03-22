# Architecture

Key factual notes about the current architecture and decision points.

---

## High-level
- Runtime: Bun (TypeScript ESM)
- CLI: `cac`
- Storage: SQLite
- Vector: `sqlite-vec`
- Keyword: FTS5
- Chunking: Tree-sitter first, with fallback sliding-window for non-code or failures

## Provider boundaries
- `web.search` (Tavily) is separate from `web.ingest` (crawl4ai/cloudflare).
- Local retrieval is separate from web search/ingest.
