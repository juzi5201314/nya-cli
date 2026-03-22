# User Testing

How validators should test the real user surface for this project.

---

## Validation Surface
- Surface: CLI commands (`learn`, `search`, `get`, `ai-search`, `db ...`).
- Preferred mode: `--project --json --no-tui`.

## Validation Concurrency
- CLI validation is CPU+IO bound and uses a local SQLite file.
- Max concurrent validators: **1** (avoid DB/file contention and noisy interleaving).

## Flow Validator Guidance: CLI
- Use the real CLI entrypoint (`bun run src/index.ts` or `dist/nya` when explicitly validating build output).
- Always isolate state with a temp working directory and `--project` when touching the DB.
- Prefer `--json --no-tui` so results are machine-checkable and stable.
- Do not share temp repos or `.nya-cli/` directories across validators.
- For safety validations, use fixture repos / files that contain unique markers and secret-like strings, then assert they are absent from output or persistence.
- Keep validation offline unless the milestone explicitly requires the Google smoke command.
- `db doctor` validation should start from a no-sidecar state and assert that both the main `index.sqlite` hash and any `index.sqlite-wal` / `index.sqlite-shm` sidecars remain unchanged after inspection.

## Per-milestone Smoke (Real Google)
Run after each milestone validation:

```bash
bun run smoke:google
```

Rules:
- If `GOOGLE_GENERATIVE_AI_API_KEY` is missing, smoke must return exit 0 with `{ "status": "skipped" }`.
- If present, smoke must run a cost-capped end-to-end flow (learn → search → ai-search) in a temp directory with `--project` isolation.
- Smoke must fail if its captured outputs contain the literal API key value.
