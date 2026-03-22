# User Testing

How validators should test the real user surface for this project.

---

## Validation Surface
- Surface: CLI commands (`learn`, `search`, `get`, `ai-search`, `db ...`).
- Preferred mode: `--project --json --no-tui`.

## Validation Concurrency
- CLI validation is CPU+IO bound and uses a local SQLite file.
- Max concurrent validators: **1** (avoid DB/file contention and noisy interleaving).

## Per-milestone Smoke (Real Google)
Run after each milestone validation:

```bash
bun run smoke:google
```

Rules:
- If `GOOGLE_GENERATIVE_AI_API_KEY` is missing, smoke must return exit 0 with `{ "status": "skipped" }`.
- If present, smoke must run a cost-capped end-to-end flow (learn → search → ai-search) in a temp directory with `--project` isolation.
- Smoke must fail if its captured outputs contain the literal API key value.
