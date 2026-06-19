// ============================================================================
// test/report/sarif.test.ts
// Spec for the PURE SARIF 2.1.0 reporter (src/report/sarif.ts).
//
// The SARIF reporter reshapes a finished Report into a SARIF 2.1.0 log so
// findings surface inline in GitHub code-scanning / PR annotations. Its
// load-bearing guarantees — pinned here — are:
//   - the output is valid JSON,
//   - version is "2.1.0" and `$schema` is set,
//   - there is exactly one run whose tool.driver.name is "testtrust"
//     (with informationUri + version carried from the report),
//   - each finding becomes one result with the right severity->level mapping
//     (fail->error, warn->warning, info->note) and the finding's startLine,
//   - startColumn appears only when the finding has a column (else omitted),
//   - tool.driver.rules has exactly one reportingDescriptor per DISTINCT ruleId,
//   - the zero-findings case is still a valid SARIF log with empty results,
//   - the reporter is pure (no mutation) and deterministic.
//
// Reports are built inline from the frozen types; we only set the fields the
// reporter reads. Small builders keep Report/Finding construction terse,
// mirroring the Markdown reporter's spec.
// ============================================================================
import { describe, it, expect } from "vitest";
import { renderSarif } from "../../src/report/sarif.js";
import type { Finding, Report, ScoreResult, Severity } from "../../src/types.js";

// ----------------------------------------------------------------------------
// Builders — intention-revealing Report/Finding construction.
// ----------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "assertion-free",
    severity: "warn",
    file: "src/sample.test.ts",
    line: 1,
    message: "Test has no assertions.",
    ...overrides,
  };
}

/** A minimal ScoreResult; counts/breakdown default to a clean shape but each
 *  field is overridable. The SARIF reporter only reads findings + version, so
 *  the score is essentially scaffolding here. */
function makeScore(overrides: Partial<ScoreResult> = {}): ScoreResult {
  const countsBySeverity: Record<Severity, number> = { fail: 0, warn: 0, info: 0 };
  return {
    score: 100,
    verdict: "pass",
    failThreshold: 60,
    totalFindings: 0,
    countsBySeverity,
    breakdown: [],
    ...overrides,
  };
}

function makeReport(findings: Finding[], overrides: Partial<Report> = {}): Report {
  return {
    version: "0.1.6",
    generatedAt: "2026-06-18T00:00:00.000Z",
    mode: "files",
    baseRef: null,
    filesAnalyzed: 1,
    score: makeScore({ totalFindings: findings.length }),
    findings,
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// Minimal SARIF shape for typed parsing in assertions.
// ----------------------------------------------------------------------------

interface SarifRegion {
  startLine: number;
  startColumn?: number;
}
interface SarifResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: SarifRegion;
    };
  }>;
}
interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
}
interface SarifLog {
  version: string;
  $schema: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        informationUri: string;
        version: string;
        rules: SarifRule[];
      };
    };
    results: SarifResult[];
  }>;
}

/** Render + JSON.parse into the typed shape; also proves the output is valid JSON. */
function parse(report: Report): SarifLog {
  return JSON.parse(renderSarif(report)) as SarifLog;
}

// ============================================================================
// Valid JSON + top-level SARIF envelope
// ============================================================================
describe("renderSarif() — SARIF envelope", () => {
  it("emits parseable JSON", () => {
    const out = renderSarif(makeReport([makeFinding()]));
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("is pretty-printed with 2-space indentation", () => {
    const out = renderSarif(makeReport([makeFinding()]));
    // A pretty-printed object has newlines and a 2-space first-level indent.
    expect(out).toContain("\n");
    expect(out).toContain('\n  "version": "2.1.0"');
  });

  it('sets version to "2.1.0"', () => {
    expect(parse(makeReport([])).version).toBe("2.1.0");
  });

  it("sets a non-empty $schema", () => {
    const log = parse(makeReport([]));
    expect(typeof log.$schema).toBe("string");
    expect(log.$schema.length).toBeGreaterThan(0);
    expect(log.$schema).toContain("sarif");
  });

  it("produces exactly one run", () => {
    expect(parse(makeReport([makeFinding()])).runs).toHaveLength(1);
  });
});

// ============================================================================
// tool.driver
// ============================================================================
describe("renderSarif() — tool.driver", () => {
  it('sets driver.name to "testtrust"', () => {
    const driver = parse(makeReport([])).runs[0]!.tool.driver;
    expect(driver.name).toBe("testtrust");
  });

  it("sets the informationUri to the project repo", () => {
    const driver = parse(makeReport([])).runs[0]!.tool.driver;
    expect(driver.informationUri).toBe("https://github.com/corgu1995/testtrust");
  });

  it("carries the report version onto the driver", () => {
    const driver = parse(makeReport([], { version: "9.9.9" })).runs[0]!.tool.driver;
    expect(driver.version).toBe("9.9.9");
  });
});

// ============================================================================
// Results — one per finding, with level + location
// ============================================================================
describe("renderSarif() — results", () => {
  it("emits one result per finding", () => {
    const findings = [
      makeFinding({ line: 1 }),
      makeFinding({ line: 2 }),
      makeFinding({ line: 3 }),
    ];
    const results = parse(makeReport(findings)).runs[0]!.results;
    expect(results).toHaveLength(3);
  });

  it("maps the finding into ruleId, message text, and location", () => {
    const finding = makeFinding({
      ruleId: "tautology",
      file: "src/cart.test.ts",
      line: 6,
      message: "This assertion compares a value to itself and can never fail.",
    });
    const result = parse(makeReport([finding])).runs[0]!.results[0]!;

    expect(result.ruleId).toBe("tautology");
    expect(result.message.text).toBe(
      "This assertion compares a value to itself and can never fail.",
    );
    const phys = result.locations[0]!.physicalLocation;
    expect(phys.artifactLocation.uri).toBe("src/cart.test.ts");
    expect(phys.region.startLine).toBe(6);
  });

  it("maps fail -> error", () => {
    const result = parse(makeReport([makeFinding({ severity: "fail" })])).runs[0]!.results[0]!;
    expect(result.level).toBe("error");
  });

  it("maps warn -> warning", () => {
    const result = parse(makeReport([makeFinding({ severity: "warn" })])).runs[0]!.results[0]!;
    expect(result.level).toBe("warning");
  });

  it("maps info -> note", () => {
    const result = parse(makeReport([makeFinding({ severity: "info" })])).runs[0]!.results[0]!;
    expect(result.level).toBe("note");
  });

  it("includes the finding's startLine in the region", () => {
    const result = parse(makeReport([makeFinding({ line: 42 })])).runs[0]!.results[0]!;
    expect(result.locations[0]!.physicalLocation.region.startLine).toBe(42);
  });
});

// ============================================================================
// startColumn — present only when the finding has a column
// ============================================================================
describe("renderSarif() — startColumn", () => {
  it("includes startColumn when the finding has a column", () => {
    const result = parse(makeReport([makeFinding({ line: 5, column: 13 })])).runs[0]!.results[0]!;
    expect(result.locations[0]!.physicalLocation.region.startColumn).toBe(13);
  });

  it("omits startColumn entirely when the finding has no column", () => {
    const out = renderSarif(makeReport([makeFinding({ line: 5 })]));
    expect(out).not.toContain("startColumn");

    const region = (JSON.parse(out) as SarifLog).runs[0]!.results[0]!.locations[0]!
      .physicalLocation.region;
    expect("startColumn" in region).toBe(false);
    expect(region.startLine).toBe(5);
  });
});

// ============================================================================
// Rules — one reportingDescriptor per DISTINCT ruleId
// ============================================================================
describe("renderSarif() — tool.driver.rules", () => {
  it("emits one rule with id, name and shortDescription.text for a single finding", () => {
    const rules = parse(makeReport([makeFinding({ ruleId: "assertion-free" })])).runs[0]!.tool
      .driver.rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]!.id).toBe("assertion-free");
    expect(typeof rules[0]!.name).toBe("string");
    expect(rules[0]!.name.length).toBeGreaterThan(0);
    expect(typeof rules[0]!.shortDescription.text).toBe("string");
    expect(rules[0]!.shortDescription.text.length).toBeGreaterThan(0);
  });

  it("collapses duplicate ruleIds into a single rule entry", () => {
    const findings = [
      makeFinding({ ruleId: "tautology", line: 1 }),
      makeFinding({ ruleId: "tautology", line: 2 }),
      makeFinding({ ruleId: "tautology", line: 3 }),
    ];
    const rules = parse(makeReport(findings)).runs[0]!.tool.driver.rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]!.id).toBe("tautology");
  });

  it("emits one rule per DISTINCT ruleId across many findings", () => {
    const findings = [
      makeFinding({ ruleId: "assertion-free", line: 1 }),
      makeFinding({ ruleId: "tautology", line: 2 }),
      makeFinding({ ruleId: "assertion-free", line: 3 }),
      makeFinding({ ruleId: "snapshot-only", line: 4 }),
      makeFinding({ ruleId: "tautology", line: 5 }),
    ];
    const rules = parse(makeReport(findings)).runs[0]!.tool.driver.rules;
    expect(rules).toHaveLength(3);
    const ids = rules.map((r) => r.id);
    // First-seen order, de-duplicated.
    expect(ids).toEqual(["assertion-free", "tautology", "snapshot-only"]);
    // Every result's ruleId is described by exactly one rule.
    for (const ruleId of ["assertion-free", "tautology", "snapshot-only"]) {
      expect(ids.filter((id) => id === ruleId)).toHaveLength(1);
    }
  });
});

// ============================================================================
// Zero-findings case
// ============================================================================
describe("renderSarif() — zero findings", () => {
  it("produces a valid SARIF log with empty results and empty rules", () => {
    const log = parse(makeReport([]));
    expect(log.version).toBe("2.1.0");
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0]!.tool.driver.name).toBe("testtrust");
    expect(log.runs[0]!.results).toEqual([]);
    expect(log.runs[0]!.tool.driver.rules).toEqual([]);
  });
});

// ============================================================================
// Purity + determinism
// ============================================================================
describe("renderSarif() — purity", () => {
  it("does not mutate the report or its findings", () => {
    const findings = [
      makeFinding({ ruleId: "tautology", file: "src/a.test.ts", line: 2, column: 4 }),
      makeFinding({ ruleId: "snapshot-only", file: "src/b.test.ts", line: 9 }),
    ];
    const snapshot = structuredClone(findings);
    renderSarif(makeReport(findings));
    expect(findings).toEqual(snapshot);
  });

  it("is deterministic: equal reports render byte-identical output", () => {
    const build = (): Report => {
      const findings = [
        makeFinding({ ruleId: "tautology", file: "src/a.test.ts", line: 2, message: "a" }),
        makeFinding({ ruleId: "snapshot-only", file: "src/b.test.ts", line: 9, message: "b" }),
      ];
      return makeReport(findings);
    };
    expect(renderSarif(build())).toBe(renderSarif(build()));
  });
});
