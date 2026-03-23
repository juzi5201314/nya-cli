import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compareEvalPerfResults,
  type EvalPerfResult,
  runEvalPerf,
  runEvalPerfCheck,
  writeEvalPerfBaseline,
} from '../src/commands/eval-perf';

function cloneResult(result: EvalPerfResult): EvalPerfResult {
  return JSON.parse(JSON.stringify(result)) as EvalPerfResult;
}

describe('eval:perf', () => {
  test('emits schema-stable offline metrics with timing telemetry', async () => {
    const result = await runEvalPerf();

    expect(result.schemaVersion).toBe(1);
    expect(result.fixture).toEqual({
      name: 'offline-eval-perf',
      sourceFiles: 4,
      searchQuery: 'hybrid retrieval evidence',
      aiSearchQuery: 'What keeps the offline eval fixture grounded?',
    });
    expect(result.metrics.dataset.documentsIndexed).toBe(4);
    expect(result.metrics.dataset.chunksIndexed).toBeGreaterThanOrEqual(4);
    expect(result.metrics.search.results).toBeGreaterThan(0);
    expect(result.metrics.search.retrieversUsed).toContain('vector');
    expect(result.metrics.search.retrieversUsed).toContain('fts');
    expect(result.metrics.aiSearch.groundingStatus).toBe('grounded');
    expect(result.metrics.aiSearch.usedQueries).toBe(1);
    expect(result.metrics.aiSearch.citations).toBe(1);
    expect(result.metrics.llm.totalCalls).toBe(
      result.metrics.llm.plannerCalls + result.metrics.llm.answerCalls
    );
    expect(result.telemetry.timingsMs.fixtureSetup).toBeGreaterThanOrEqual(0);
    expect(result.telemetry.timingsMs.total).toBeGreaterThanOrEqual(
      result.telemetry.timingsMs.aiSearch
    );
  });

  test('check mode compares against a committed-style baseline and ignores timings by default', async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), 'nya-cli-eval-perf-baseline-')
    );
    const baselinePath = join(tempDir, 'baseline.json');

    try {
      const baseline = await runEvalPerf();
      await writeEvalPerfBaseline(baselinePath, baseline);

      const result = await runEvalPerfCheck({
        baselinePath,
      });

      expect(result.status).toBe('passed');
      expect(result.regressions).toEqual([]);
      expect(result.timingChecks.enabled).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('check mode fails when deterministic metrics regress', async () => {
    const baseline = await runEvalPerf();
    const current = cloneResult(baseline);
    current.metrics.search.results -= 1;

    const result = compareEvalPerfResults({
      baseline,
      current,
      baselinePath: '/tmp/eval-perf-baseline.json',
    });

    expect(result.status).toBe('failed');
    expect(result.regressions).toContainEqual({
      metricPath: 'metrics.search.results',
      rule: 'exact',
      baseline: baseline.metrics.search.results,
      current: current.metrics.search.results,
    });
  });

  test('timing regressions are telemetry-only unless explicitly enabled', async () => {
    const baseline = await runEvalPerf();
    const current = cloneResult(baseline);
    current.telemetry.timingsMs.total =
      baseline.telemetry.timingsMs.total + 250;

    const skipped = compareEvalPerfResults({
      baseline,
      current,
      baselinePath: '/tmp/eval-perf-baseline.json',
    });

    expect(skipped.status).toBe('passed');

    const enforced = compareEvalPerfResults({
      baseline,
      current,
      baselinePath: '/tmp/eval-perf-baseline.json',
      checkTimings: true,
      timingMaxRegressionRatio: 1.1,
      timingAbsoluteBufferMs: 0,
    });

    expect(enforced.status).toBe('failed');
    expect(
      enforced.regressions.some(
        (regression) => regression.metricPath === 'telemetry.timingsMs.total'
      )
    ).toBe(true);
  });
});
