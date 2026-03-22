---
name: search-worker
description: Improve local hybrid search quality, determinism, and explainability.
---

# search-worker

## When to Use This Skill
- Features touching: `search` result schema, retriever fusion (vector/FTS/LIKE), dedupe/underfill, snippet generation, section labels.

## Required Skills
- None

## Work Procedure
1. Read the relevant `VAL-SEARCH-*` assertions.
2. Write tests first using small fixture repos in `/tmp` and CLI runs with `--project --json --no-tui`.
3. Ensure changes are deterministic (explicit tie-breakers, stable ordering).
4. Implement; keep scoring/boost logic explainable.
5. Run `bun run check` + `bun test`.

## Example Handoff
```json
{
  "salientSummary": "Fixed default extensions output to be empty and added retrieversUsed/candidate counts; improved snippet anchoring for punctuated identifiers; added deterministic tie-break and dedupe.",
  "whatWasImplemented": "Search now reports retriever participation and candidate counts, dedupes by chunkId, oversamples vector candidates when extensions are used to avoid underfill, and anchors snippets for punctuated identifiers.",
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
      {"file": "tests/search-quality.test.ts", "cases": [{"name": "default extensions is empty", "verifies": "VAL-SEARCH-001"}]}
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator
- If a required change implies schema migration beyond the current migration strategy.
