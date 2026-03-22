---
name: ops-worker
description: Add CI-like local gates, smoke runners, perf baselines, and build/runtime verification.
---

# ops-worker

## When to Use This Skill
- Features touching: `package.json` scripts (`ci`, `smoke:google`, `eval:perf*`), build artifact verification, dist runtime assets, offline-by-default guarantees.

## Required Skills
- None

## Work Procedure
1. Read the relevant `VAL-OPS-*` assertions.
2. Implement scripts as non-interactive, deterministic by default.
3. For smoke:
   - Must short-circuit with `{status:"skipped"}` when key missing.
   - Must run in a temp dir using `--project --json --no-tui`.
   - Must cap steps/requests and report counts.
   - Must capture its own outputs and fail if the literal key value appears.
4. Add regression tests for script behaviors where feasible (especially skip behavior).
5. Run `bun run check`, `bun test`, and `bun run build`.

## Example Handoff
```json
{
  "salientSummary": "Added bun run ci, bun run smoke:google, and eval:perf scripts; smoke short-circuits when key missing and is secret-safe; build verification assertions covered by tests.",
  "whatWasImplemented": "Introduced a local ci gate script that runs check+tests offline; added a Google smoke runner with strict caps and secret-leak checks; added an offline perf baseline + check mode and ensured build outputs runnable dist artifact with required assets.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {"command": "bun run ci", "exitCode": 0, "observation": "passed"},
      {"command": "bun run build", "exitCode": 0, "observation": "dist/nya runnable"}
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      {"file": "tests/smoke-google-skip.test.ts", "cases": [{"name": "smoke skips without key", "verifies": "VAL-OPS-010"}]}
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator
- If perf baseline gating cannot be made stable across environments without reducing scope.
