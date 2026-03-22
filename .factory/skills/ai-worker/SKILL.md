---
name: ai-worker
description: Improve ai-search groundedness, citation integrity, and LLM compatibility/fallbacks.
---

# ai-worker

## When to Use This Skill
- Features touching: `ai-search` prompts, evidence formatting, citation repair, config defaults/overrides, structured output fallback.

## Required Skills
- None

## Work Procedure
1. Read relevant `VAL-AI-*` + `VAL-CROSS-*` assertions.
2. Write tests first with fake LLM providers capturing prompts and returning controlled outputs.
3. Ensure prompts treat evidence as untrusted and delimit evidence blocks; ensure delimiter-injection escaping.
4. Implement excerpt fetching from DB and expose excerpt/quote fields in JSON output.
5. Run `bun run check` + `bun test`.
6. If touching real-provider smoke behavior, do not run real Google calls except in the dedicated smoke script.

## Example Handoff
```json
{
  "salientSummary": "Updated ai-search to use full chunk excerpts in prompts and JSON output; added prompt injection hardening and citation repair; ensured structured-output fallback is observable.",
  "whatWasImplemented": "Ai-search now fetches chunk content excerpts by chunkId, wraps evidence with delimiters, escapes delimiter-like strings in evidence, validates citations and repairs once, and returns evidence/citations with excerpt/quote fields plus structuredOutputFallbackUsed flag.",
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
      {"file": "tests/ai-search-grounding.test.ts", "cases": [{"name": "prompts include excerpt beyond snippet", "verifies": "VAL-AI-001"}]}
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator
- If the required behavior depends on a specific external model capability that cannot be reliably tested.
