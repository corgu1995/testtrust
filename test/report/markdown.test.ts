// ============================================================================
// test/report/markdown.test.ts
// Spec for the PURE Markdown reporter (src/report/markdown.ts).
//
// The Markdown reporter formats a finished Report into a PR-comment-friendly
// block. Its load-bearing guarantees — pinned here so the CI sticky-comment
// step can rely on them — are:
//   - line 1 is the exact HTML marker (so CI can find + update its comment),
//   - the score + UPPER-CASED verdict (with the right emoji) appear in the H2,
//   - the one-line counts summary is present,
//   - each finding renders as a table row, sorted by file then line,
//   - the table is capped at MAX_ROWS with a trailing "…and K more",
//   - `|` and newlines inside a message are escaped so the table can't break,
//   - the zero-findings case prints the all-clear line and NO table,
//   - the footer (suppression hint) is always present.
//
// Reports are built inline from the frozen types; we only set the fields the
// reporter reads. A small helper keeps Report/Finding construction terse.
// ============================================================================
import { describe, it, expect } from "vitest";
import { renderMarkdown, REPORT_MARKER, MAX_ROWS } from "../../src/report/markdown.js";
import type { Finding, Report, ScoreResult, Severity, Verdict } from "../../src/types.js";

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
 *  field is overridable so a test can pin exactly what it asserts on. */
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

function makeReport(findings: Finding[], score: ScoreResult, filesAnalyzed = 1): Report {
  return {
    version: "0.1.2",
    generatedAt: "2026-06-18T00:00:00.000Z",
    mode: "files",
    baseRef: null,
    filesAnalyzed,
    score,
    findings,
  };
}

/** Convenience: derive a plausible score for a given finding list so summary
 *  counts line up with what the table renders. */
function scoreFor(
  findings: Finding[],
  verdict: Verdict,
  score = 80,
): ScoreResult {
  const countsBySeverity: Record<Severity, number> = { fail: 0, warn: 0, info: 0 };
  for (const f of findings) countsBySeverity[f.severity] += 1;
  return makeScore({
    score,
    verdict,
    totalFindings: findings.length,
    countsBySeverity,
  });
}

// ============================================================================
// The sticky-comment marker
// ============================================================================
describe("renderMarkdown() — sticky-comment marker", () => {
  it("emits the exact marker as the very first line", () => {
    const md = renderMarkdown(makeReport([], makeScore()));
    expect(md.split("\n")[0]).toBe(REPORT_MARKER);
    expect(REPORT_MARKER).toBe("<!-- testtrust-report -->");
  });

  it("keeps the marker on line 1 even when findings are present", () => {
    const findings = [makeFinding()];
    const md = renderMarkdown(makeReport(findings, scoreFor(findings, "neutral")));
    expect(md.split("\n")[0]).toBe(REPORT_MARKER);
  });
});

// ============================================================================
// Header: score + verdict + emoji
// ============================================================================
describe("renderMarkdown() — header", () => {
  it("shows score/100 and the UPPER-CASED verdict in the H2", () => {
    const md = renderMarkdown(makeReport([], makeScore({ score: 72, verdict: "neutral" })));
    expect(md).toContain("## 🧪 testtrust — 72/100 · ");
    expect(md).toContain("NEUTRAL");
    // verdict must be upper-cased, not the raw lower-case enum value.
    expect(md).not.toContain("neutral");
  });

  it("prefixes ✅ for a pass verdict", () => {
    const md = renderMarkdown(makeReport([], makeScore({ score: 100, verdict: "pass" })));
    expect(md).toContain("## 🧪 testtrust — 100/100 · ✅ PASS");
  });

  it("prefixes ⚠️ for a neutral verdict", () => {
    const md = renderMarkdown(makeReport([], makeScore({ score: 88, verdict: "neutral" })));
    expect(md).toContain("## 🧪 testtrust — 88/100 · ⚠️ NEUTRAL");
  });

  it("prefixes ❌ for a fail verdict", () => {
    const md = renderMarkdown(makeReport([], makeScore({ score: 40, verdict: "fail" })));
    expect(md).toContain("## 🧪 testtrust — 40/100 · ❌ FAIL");
  });
});

// ============================================================================
// Summary line
// ============================================================================
describe("renderMarkdown() — summary line", () => {
  it("renders the analyzed/findings counts with correct pluralisation", () => {
    const findings = [
      makeFinding({ severity: "fail", line: 1 }),
      makeFinding({ severity: "warn", line: 2 }),
      makeFinding({ severity: "info", line: 3 }),
    ];
    const score = makeScore({
      score: 70,
      verdict: "fail",
      totalFindings: 3,
      countsBySeverity: { fail: 1, warn: 1, info: 1 },
    });
    const md = renderMarkdown(makeReport(findings, score, 3));
    expect(md).toContain("Analyzed 3 files · 3 findings (1 fail · 1 warn · 1 info)");
  });

  it("uses singular nouns for a single file / single finding", () => {
    const findings = [makeFinding({ severity: "warn" })];
    const score = makeScore({
      score: 90,
      verdict: "neutral",
      totalFindings: 1,
      countsBySeverity: { fail: 0, warn: 1, info: 0 },
    });
    const md = renderMarkdown(makeReport(findings, score, 1));
    expect(md).toContain("Analyzed 1 file · 1 finding (0 fail · 1 warn · 0 info)");
  });
});

// ============================================================================
// Findings table
// ============================================================================
describe("renderMarkdown() — findings table", () => {
  it("renders a row for a finding with rule, location and message", () => {
    const findings = [
      makeFinding({
        ruleId: "tautology",
        file: "src/cart.test.ts",
        line: 6,
        message: "This assertion compares a value to itself and can never fail.",
      }),
    ];
    const md = renderMarkdown(makeReport(findings, scoreFor(findings, "neutral")));

    expect(md).toContain("| Rule | Location | Message |");
    expect(md).toContain("| --- | --- | --- |");
    expect(md).toContain(
      "| `tautology` | `src/cart.test.ts:6` | This assertion compares a value to itself and can never fail. |",
    );
    // Table is folded inside a <details> block.
    expect(md).toContain("<details><summary>1 finding</summary>");
    expect(md).toContain("</details>");
  });

  it("sorts rows by file ascending, then by line ascending", () => {
    const findings = [
      makeFinding({ ruleId: "tautology", file: "src/b.test.ts", line: 5, message: "b5" }),
      makeFinding({ ruleId: "assertion-free", file: "src/a.test.ts", line: 20, message: "a20" }),
      makeFinding({ ruleId: "snapshot-only", file: "src/a.test.ts", line: 3, message: "a3" }),
    ];
    const md = renderMarkdown(makeReport(findings, scoreFor(findings, "neutral")));

    const aThree = md.indexOf("`src/a.test.ts:3`");
    const aTwenty = md.indexOf("`src/a.test.ts:20`");
    const bFive = md.indexOf("`src/b.test.ts:5`");

    expect(aThree).toBeGreaterThan(-1);
    expect(aThree).toBeLessThan(aTwenty); // same file, line 3 before line 20
    expect(aTwenty).toBeLessThan(bFive); // file a before file b
  });

  it("escapes `|` and flattens newlines so a message can't break the table", () => {
    const findings = [
      makeFinding({
        ruleId: "tautology",
        file: "src/x.test.ts",
        line: 9,
        message: "weird | pipe\nand a newline",
      }),
    ];
    const md = renderMarkdown(makeReport(findings, scoreFor(findings, "neutral")));

    // The literal "| pipe" delimiter must be escaped to "\| pipe".
    expect(md).toContain("weird \\| pipe and a newline");
    // No raw newline survives inside the message cell.
    expect(md).not.toContain("weird | pipe\nand a newline");
  });
});

// ============================================================================
// Row cap + "…and K more"
// ============================================================================
describe("renderMarkdown() — row cap", () => {
  it(`renders all rows and no overflow note at exactly ${MAX_ROWS} findings`, () => {
    const findings = Array.from({ length: MAX_ROWS }, (_unused, i) =>
      makeFinding({ file: "src/big.test.ts", line: i + 1, message: `m${i + 1}` }),
    );
    const md = renderMarkdown(makeReport(findings, scoreFor(findings, "neutral"), 1));

    const rowCount = md.split("\n").filter((l) => l.startsWith("| `")).length;
    expect(rowCount).toBe(MAX_ROWS);
    expect(md).not.toContain("more");
  });

  it("caps at MAX_ROWS and appends '…and K more' when exceeded", () => {
    const total = MAX_ROWS + 7;
    const findings = Array.from({ length: total }, (_unused, i) =>
      makeFinding({ file: "src/big.test.ts", line: i + 1, message: `m${i + 1}` }),
    );
    const md = renderMarkdown(makeReport(findings, scoreFor(findings, "fail", 10), 1));

    // Exactly MAX_ROWS data rows rendered.
    const rowCount = md.split("\n").filter((l) => l.startsWith("| `")).length;
    expect(rowCount).toBe(MAX_ROWS);
    // …and the remainder reported.
    expect(md).toContain(`…and ${total - MAX_ROWS} more`);
    // The summary still reflects the TRUE total, not the capped count.
    expect(md).toContain(`${total} findings`);
  });
});

// ============================================================================
// Zero-findings case
// ============================================================================
describe("renderMarkdown() — zero findings", () => {
  it("prints the all-clear line and renders NO table", () => {
    const md = renderMarkdown(makeReport([], makeScore({ score: 100, verdict: "pass" })));
    expect(md).toContain("✅ No test-trust issues found.");
    expect(md).not.toContain("| Rule | Location | Message |");
    expect(md).not.toContain("<details>");
  });
});

// ============================================================================
// Footer
// ============================================================================
describe("renderMarkdown() — footer", () => {
  it("always emits the powered-by + suppression hint footer", () => {
    const withNone = renderMarkdown(makeReport([], makeScore()));
    const findings = [makeFinding()];
    const withSome = renderMarkdown(makeReport(findings, scoreFor(findings, "neutral")));

    for (const md of [withNone, withSome]) {
      expect(md).toContain("Powered by [testtrust](https://github.com/corgu1995/testtrust)");
      expect(md).toContain("// testtrust-disable-next-line <rule>");
      expect(md).toContain("<sub>");
    }
  });
});

// ============================================================================
// Purity
// ============================================================================
describe("renderMarkdown() — purity", () => {
  it("does not mutate the report's findings array (no in-place sort)", () => {
    const findings = [
      makeFinding({ file: "src/z.test.ts", line: 1 }),
      makeFinding({ file: "src/a.test.ts", line: 1 }),
    ];
    const before = [...findings];
    renderMarkdown(makeReport(findings, scoreFor(findings, "neutral")));
    // Same references in the same original order: the reporter sorted a copy.
    expect(findings).toEqual(before);
    expect(findings[0]?.file).toBe("src/z.test.ts");
  });

  it("is deterministic: equal reports render byte-identical output", () => {
    const build = (): Report => {
      const findings = [
        makeFinding({ ruleId: "tautology", file: "src/a.test.ts", line: 2, message: "a" }),
        makeFinding({ ruleId: "snapshot-only", file: "src/b.test.ts", line: 9, message: "b" }),
      ];
      return makeReport(findings, scoreFor(findings, "neutral"));
    };
    expect(renderMarkdown(build())).toBe(renderMarkdown(build()));
  });
});
