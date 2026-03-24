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
- Dist runtime note: Tree-sitter chunking resolves wasm assets relative to the executing entrypoint (`process.argv[1]`), so production artifacts must keep `dist/tree-sitter/*.wasm` alongside `dist/nya`.
- Dist runtime note: sqlite-vec verification must exercise the built artifact away from repo-adjacent `node_modules`; otherwise dist runtime tests can be masked by fallback resolution into the source checkout instead of proving `dist/` is self-sufficient.
- `db doctor` uses a temporary read-only snapshot copy of `index.sqlite` plus `-wal`/`-shm` sidecars when they exist, so the doctor path can inspect state without mutating the live project database.

## Provider boundaries
- `web.search` (Tavily) is separate from `web.ingest` (crawl4ai/cloudflare).
- Local retrieval is separate from web search/ingest.
