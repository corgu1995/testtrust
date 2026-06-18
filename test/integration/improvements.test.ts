import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, EmptyScanError } from "../../src/core/analyze.js";
import type { CliOptions } from "../../src/types.js";

/** Build a complete files-mode CliOptions rooted at `cwd`. */
function filesOptions(cwd: string, files: string[]): CliOptions {
  return {
    mode: "files",
    files,
    baseRef: "",
    cwd,
    format: "json",
    failThreshold: 60,
    rules: {},
    onlyChangedTests: true,
    noColor: true,
    quiet: true,
  };
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "testtrust-improve-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("filesAnalyzed", () => {
  it("reports the true number of files scanned, even with zero findings", async () => {
    writeFileSync(
      join(dir, "fa1.test.ts"),
      `import { it, expect } from "vitest";\nit("ok", () => { expect(add(1, 2)).toBe(3); });`,
    );
    writeFileSync(
      join(dir, "fa2.test.ts"),
      `import { it, expect } from "vitest";\nit("ok2", () => { expect(add(2, 2)).toEqual(4); });`,
    );
    const report = await analyze(filesOptions(dir, ["fa*.test.ts"]));
    expect(report.filesAnalyzed).toBe(2);
  });
});

describe("empty scan", () => {
  it("throws EmptyScanError instead of a vacuous 100/pass", async () => {
    await expect(
      analyze(filesOptions(dir, ["does-not-exist-xyz-*.test.ts"])),
    ).rejects.toBeInstanceOf(EmptyScanError);
  });
});

describe("inline suppression", () => {
  it("suppresses a finding via // testtrust-disable-next-line <rule>", async () => {
    const src = [
      `import { it, expect } from "vitest";`,
      `it("suppressed", () => {`,
      `  const total = 5;`,
      `  // testtrust-disable-next-line tautology`,
      `  expect(total).toBe(total);`,
      `});`,
      `it("not suppressed", () => {`,
      `  const n = 1;`,
      `  expect(n).toBe(n);`,
      `});`,
    ].join("\n");
    writeFileSync(join(dir, "supp.test.ts"), src);
    const report = await analyze(filesOptions(dir, ["supp.test.ts"]));
    const tautologies = report.findings.filter((f) => f.ruleId === "tautology");
    expect(tautologies).toHaveLength(1);
    expect(tautologies[0]?.testName).toContain("not suppressed");
  });
});

describe("focused-test through the full pipeline", () => {
  it("flags an it.only left in", async () => {
    writeFileSync(
      join(dir, "focus.test.ts"),
      `import { it, expect } from "vitest";\nit.only("x", () => { expect(1).toBe(1); });`,
    );
    const report = await analyze(filesOptions(dir, ["focus.test.ts"]));
    expect(report.findings.some((f) => f.ruleId === "focused-test")).toBe(true);
  });
});
