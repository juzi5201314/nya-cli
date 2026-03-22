---
name: learn-worker
description: Improve learn git/web robustness, retries/timeouts, determinism, and JSON observability.
---

# learn-worker

## When to Use This Skill
- Features touching: `learn git`, `learn web`, Crawl4AI execution, crawl controller behavior, chunking determinism/fingerprint binding.

## Required Skills
- None

## Work Procedure
1. Read relevant contract assertions (feature `fulfills`).
2. Add **offline fixtures** for failures (fake `crwl`, fake `git` via `PATH` injection) and write tests first.
   - If the failure mode is unclear (e.g. provider/crawl interactions), a short implementation-first investigation is acceptable, but you MUST add a regression test before finishing.
   - For timeout-sensitive subprocess paths, avoid flaky wall-clock tests; prefer deterministic fakes (PATH-injected subprocess that logs argv + controlled sleep/exit) and keep the regression in the default `bun test` suite (do not leave `test.skip`).
3. Ensure failure/skip/retry information is **structured in `--json` output** (no log parsing in tests).
4. Implement changes; keep provider abstractions narrow and explicit.
5. Run `bun run check` + `bun test`.
6. Manual CLI sanity check on at least one `learn git` and one `learn web` run (offline fixture).

## Example Handoff
```json
{
  "salientSummary": "Made learn web crawl resilient to per-page failures and added structured pageFailures output; introduced run-scoped temp dir cleanup for Crawl4AI timeouts; added regression tests for crawl failure tolerance.",
  "whatWasImplemented": "Updated crawl BFS controller to continue on fetch errors and record failures; ensured Crawl4AI temp directories are run-scoped and always cleaned in finally; added retry attempt counters to JSON output.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {"command": "bun run check", "exitCode": 0, "observation": "passed"},
      {"command": "bun test", "exitCode": 0, "observation": "passed"}
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      {"file": "tests/learn-web-resilience.test.ts", "cases": [{"name": "crawl continues after page failures", "verifies": "VAL-LEARN-WEB-001"}]}
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator
- If evidence requires a new testing tool not currently in the repo.
