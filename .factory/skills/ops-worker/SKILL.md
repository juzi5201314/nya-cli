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
2. For validation droid portability, keep repo-scoped validation droids (`.factory/droids/scrutiny-feature-reviewer.md` and `.factory/droids/user-testing-flow-validator.md`) on `model: inherit` by default. Do not commit environment-specific `custom:*` model IDs unless you are in a temporary unblock flow.
3. When scrutiny or user-testing Task launches fail on model selection, set the mission's `validationWorkerModel` in `{missionDir}/model-settings.json` first. Prefer (a) a built-in Task-portable model available in the current environment, then (b) a locally available BYOK custom model if built-in models are unavailable or return `402` / no-credits errors.
4. Probe both validation droids before rerunning validators:
   - `Task scrutiny-feature-reviewer` with a short prompt like “Reply with launch-ok. Do not review code.”
   - `Task user-testing-flow-validator` with a short prompt like “Reply with launch-ok. Do not run validation.”
5. If you are blocked and cannot switch `validationWorkerModel` quickly, temporarily pin the repo droid `model:` to a working built-in or BYOK model, rerun the trivial probes, finish the validation rerun, and then restore the droid back to `model: inherit` before handing off so the repo stays portable.
6. Implement scripts as non-interactive, deterministic by default.
7. For smoke:
   - Must short-circuit with `{status:"skipped"}` when key missing.
   - Must run in a temp dir using `--project --json --no-tui`.
   - Must cap steps/requests and report counts.
   - Must capture its own outputs and fail if the literal key value appears.
8. Add regression tests for script behaviors where feasible (especially skip behavior).
9. Run `bun run check`, `bun test`, and `bun run build`.

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
