---
name: safety-db-worker
description: Harden secret safety, DB rebuild/doctor correctness, and safety-critical ingest behaviors.
---

# safety-db-worker

## When to Use This Skill
- Features touching: URL redaction (stdout/stderr/JSON + DB at-rest), git symlink safety, DB doctor/rebuild health semantics, fingerprint mismatch handling.

## Required Skills
- None

## Work Procedure
1. **Re-read the relevant assertions** in the mission validation contract (IDs listed in the feature `fulfills`).
2. **Write tests first (red):**
   - Prefer `bun test` integration tests that spawn the CLI with `--project --json --no-tui`.
   - For DB-at-rest checks, programmatically query SQLite via `bun:sqlite` (don’t rely on external `sqlite3` CLI).
   - For secret-hygiene, capture stdout+stderr and assert the literal secret string does not appear.
3. **Implement (green):** keep changes minimal, preserve existing provider boundaries.
4. **Manual verification (quick):** run at least one CLI command path relevant to the change.
5. **Run validators:** `bun run check` and `bun test` (and any targeted tests you added).
6. **Cleanup:** ensure no temp files or background processes remain.

## Example Handoff
```json
{
  "salientSummary": "Hardened git ingest to skip symlinks and added structured skip counts; fixed db doctor to be non-creating and to expose healthStatus/needsRebuild. Added regression tests for symlink escape and doctor side effects.",
  "whatWasImplemented": "Implemented symlink-safe file ingestion using lstat/realpath guards; added URL redaction utility used by CLI outputs and persisted locators; updated db doctor to avoid creating missing DBs and to report degraded health when manifests failed or fingerprint mismatched.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {"command": "bun run check", "exitCode": 0, "observation": "typecheck + biome passed"},
      {"command": "bun test", "exitCode": 0, "observation": "all tests passed"}
    ],
    "interactiveChecks": [
      {"action": "bun run src/index.ts db doctor --project --json --no-tui (in temp dir)", "observed": "reports dbExists=false without creating .nya-cli"}
    ]
  },
  "tests": {
    "added": [
      {"file": "tests/safety-symlink.test.ts", "cases": [{"name": "skips tracked symlinks", "verifies": "VAL-SAF-001, VAL-SAF-002"}]}
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator
- If any assertion requires external services beyond the allowed Google smoke.
- If a fix would require changing the provider boundary policy (must be approved).
