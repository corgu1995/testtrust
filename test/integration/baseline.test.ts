// ============================================================================
// test/integration/baseline.test.ts
//
// FULL-PIPELINE integration tests for the BASELINE / suppression-store wiring in
// the public `analyze()` entry point. The baseline store (src/core/baseline.ts)
// is unit-tested in isolation; these tests exercise how the ORCHESTRATOR uses it
// end to end: real files on disk, the real detectors, a real baseline written to
// and read back from a temp directory, and the score/verdict recomputed on the
// surviving (un-grandfathered) findings.
//
// The behaviour under test (src/core/analyze.ts): when `options.baselinePath`
// points at a baseline, any finding whose key is present is dropped BEFORE
// scoring — so it neither shows in the report nor counts against the gate.
//
// The baseline key is intentionally LINE-INDEPENDENT (ruleId + file + testName),
// so a pre-existing finding stays suppressed even after unrelated edits shift it
// to a new line — the property a baseline must have to be useful on a moving
// codebase. Each test runs on its own throwaway temp dir; all are cleaned up in
// afterAll.
// ============================================================================

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { analyze } from "../../src/index.js";
import { writeBaseline, loadBaseline } from "../../src/core/baseline.js";
import type { CliOptions, Report, RuleId } from "../../src/types.js";

/** Fully-defaulted options; tests override only the knobs they care about. */
function makeOptions(overrides: Partial<CliOptions> & Pick<CliOptions, "cwd">): CliOptions {
  return {
    mode: "files",
    files: ["**/*.test.ts"],
    baseRef: "",
    format: "json",
    failThreshold: 0,
    rules: {},
    onlyChangedTests: false,
    noColor: true,
    quiet: true,
    ...overrides,
  };
}

const ruleIdsOf = (report: Report): RuleId[] => report.findings.map((f) => f.ruleId).sort();

// The same unambiguous two-smell fixture used by analyze.test.ts: a tautology
// (same identifier both sides) plus a confident assertion-free test. Both are
// warn-level, so without a baseline the verdict is "neutral" and the score < 100.
const FIXTURE = [
  "describe('arithmetic', () => {",
  "  it('is internally consistent', () => {",
  "    const result = 2 + 2;",
  "    expect(result).toBe(result);",
  "  });",
  "",
  "  it('runs but verifies nothing', () => {",
  "    const value = 41 + 1;",
  "    void value;",
  "  });",
  "});",
  "",
].join("\n");

const dirs: string[] = [];
async function freshDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "testtrust-baseline-"));
  dirs.push(dir);
  await writeFile(path.join(dir, "sample.test.ts"), FIXTURE, "utf8");
  return dir;
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("analyze() — baseline grandfathering", () => {
  it("with no baseline, surfaces both smells and dents the score below 100", async () => {
    const dir = await freshDir();
    const report = await analyze(makeOptions({ cwd: dir }));

    expect(ruleIdsOf(report)).toEqual(["assertion-free", "tautology"]);
    expect(report.score.score).toBeLessThan(100);
    expect(report.score.verdict).toBe("neutral");
  });

  it("a written baseline gates every captured finding: empty report, perfect score, pass", async () => {
    const dir = await freshDir();
    const blPath = path.join(dir, ".testtrust-baseline.json");

    // 1) Capture the current findings into a baseline.
    const before = await analyze(makeOptions({ cwd: dir }));
    expect(before.findings.length).toBeGreaterThanOrEqual(2);
    writeBaseline(blPath, before.findings);

    // The store actually persisted one key per finding.
    const loaded = loadBaseline(blPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.keys.length).toBe(before.findings.length);

    // 2) Re-run against that baseline: everything is grandfathered away.
    const after = await analyze(makeOptions({ cwd: dir, baselinePath: blPath }));
    expect(after.findings).toHaveLength(0);
    expect(after.score.score).toBe(100);
    expect(after.score.verdict).toBe("pass");
  });

  it("gates baselined findings but still surfaces a NEW smell added afterward", async () => {
    const dir = await freshDir();
    const blPath = path.join(dir, ".testtrust-baseline.json");
    const file = path.join(dir, "sample.test.ts");

    const before = await analyze(makeOptions({ cwd: dir }));
    writeBaseline(blPath, before.findings);

    // Append a THIRD, assertion-free test with a DISTINCT title (so its baseline
    // key differs from the grandfathered ones and it is NOT suppressed).
    const withNew =
      FIXTURE +
      [
        "describe('new', () => {",
        "  it('added later and checks nothing', () => {",
        "    const x = 1 + 1;",
        "    void x;",
        "  });",
        "});",
        "",
      ].join("\n");
    await writeFile(file, withNew, "utf8");

    const after = await analyze(makeOptions({ cwd: dir, baselinePath: blPath }));

    // The two original (grandfathered) findings are gone; only the new one rides.
    expect(after.findings).toHaveLength(1);
    expect(after.findings[0]!.ruleId).toBe("assertion-free");
    expect(after.findings[0]!.testName).toContain("added later");
  });

  it("the baseline key is line-independent: shifting findings down still gates them", async () => {
    const dir = await freshDir();
    const blPath = path.join(dir, ".testtrust-baseline.json");
    const file = path.join(dir, "sample.test.ts");

    const before = await analyze(makeOptions({ cwd: dir }));
    writeBaseline(blPath, before.findings);

    // Push every finding down 10 lines WITHOUT touching any test name or body.
    await writeFile(file, "\n".repeat(10) + FIXTURE, "utf8");

    const after = await analyze(makeOptions({ cwd: dir, baselinePath: blPath }));

    // Lines moved; keys (ruleId + file + testName) did not — still fully gated.
    expect(after.findings).toHaveLength(0);
    expect(after.score.verdict).toBe("pass");
  });

  it("a missing baseline file is a no-op (loadBaseline -> null), not a crash", async () => {
    const dir = await freshDir();
    const missing = path.join(dir, "does-not-exist.json");

    const report = await analyze(makeOptions({ cwd: dir, baselinePath: missing }));

    // No gating applied — the smells surface exactly as without a baseline.
    expect(ruleIdsOf(report)).toEqual(["assertion-free", "tautology"]);
  });
});
