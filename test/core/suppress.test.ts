// ============================================================================
// test/core/suppress.test.ts
// Spec for the inline suppression parser (src/core/suppress.ts).
//
// buildSuppressions() reads a test file's raw source and returns an index that
// answers isSuppressed(line, ruleId). These tests pin the directive grammar:
// disable-next-line vs disable-line, unscoped (all rules) vs scoped (named
// rules only), and the // and /* */ comment forms. They also lock the no-throw
// guarantees: unknown rule names and a trailing directive on the last line.
//
// Line numbers are 1-based to match Finding.line. To stay robust against the
// exact whitespace of these template strings, helper `lineOf` finds a line by a
// unique marker instead of hardcoding offsets.
// ============================================================================
import { describe, it, expect } from "vitest";
import { buildSuppressions, parseRuleList } from "../../src/core/suppress.js";
import type { RuleId } from "../../src/types.js";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** 1-based line number of the first line containing `marker` (throws if none). */
function lineOf(source: string, marker: string): number {
  const lines = source.split("\n");
  const idx = lines.findIndex((l) => l.includes(marker));
  if (idx === -1) throw new Error(`marker not found in source: ${marker}`);
  return idx + 1;
}

// A couple of real RuleIds and one that no detector emits, to prove scoping.
const RULE_A: RuleId = "tautology";
const RULE_B: RuleId = "assertion-free";
const RULE_OTHER: RuleId = "over-mocking-sut";

// ============================================================================
// disable-next-line — unscoped (all rules)
// ============================================================================
describe("buildSuppressions() — disable-next-line (all rules)", () => {
  it("suppresses ANY rule on the line after the directive", () => {
    const src = [
      "const x = 1;",
      "// testtrust-disable-next-line",
      "expect(true).toBe(true); // TARGET",
    ].join("\n");
    const index = buildSuppressions(src);
    const target = lineOf(src, "TARGET");

    expect(index.isSuppressed(target, RULE_A)).toBe(true);
    expect(index.isSuppressed(target, RULE_B)).toBe(true);
    expect(index.isSuppressed(target, RULE_OTHER)).toBe(true);
  });

  it("does NOT suppress the comment's own line, only the next one", () => {
    const src = [
      "// testtrust-disable-next-line // DIRECTIVE",
      "noop(); // TARGET",
    ].join("\n");
    const index = buildSuppressions(src);

    expect(index.isSuppressed(lineOf(src, "DIRECTIVE"), RULE_A)).toBe(false);
    expect(index.isSuppressed(lineOf(src, "TARGET"), RULE_A)).toBe(true);
  });
});

// ============================================================================
// disable-next-line — scoped (named rules only)
// ============================================================================
describe("buildSuppressions() — scoped disable-next-line", () => {
  it("suppresses only the named rule; other rules still report", () => {
    const src = [
      `// testtrust-disable-next-line ${RULE_A}`,
      "expect(x).toBeTruthy(); // TARGET",
    ].join("\n");
    const index = buildSuppressions(src);
    const target = lineOf(src, "TARGET");

    expect(index.isSuppressed(target, RULE_A)).toBe(true);
    expect(index.isSuppressed(target, RULE_B)).toBe(false);
    expect(index.isSuppressed(target, RULE_OTHER)).toBe(false);
  });

  it("supports a comma/space separated list of rules", () => {
    const src = [
      `// testtrust-disable-next-line ${RULE_A}, ${RULE_B}`,
      "doThing(); // TARGET",
    ].join("\n");
    const index = buildSuppressions(src);
    const target = lineOf(src, "TARGET");

    expect(index.isSuppressed(target, RULE_A)).toBe(true);
    expect(index.isSuppressed(target, RULE_B)).toBe(true);
    expect(index.isSuppressed(target, RULE_OTHER)).toBe(false);
  });
});

// ============================================================================
// disable-line — same line as the directive
// ============================================================================
describe("buildSuppressions() — disable-line (same line)", () => {
  it("suppresses all rules on the SAME line when unscoped", () => {
    const src = [
      "const y = 2;",
      "expect(a).toBe(a); // testtrust-disable-line   <- TARGET",
    ].join("\n");
    const index = buildSuppressions(src);
    const target = lineOf(src, "TARGET");

    expect(index.isSuppressed(target, RULE_A)).toBe(true);
    expect(index.isSuppressed(target, RULE_B)).toBe(true);
    // The previous line is unaffected.
    expect(index.isSuppressed(target - 1, RULE_A)).toBe(false);
  });

  it("suppresses only the named rule on the same line when scoped", () => {
    const src = [
      `flaky(); // testtrust-disable-line ${RULE_A}  <- TARGET`,
    ].join("\n");
    const index = buildSuppressions(src);
    const target = lineOf(src, "TARGET");

    expect(index.isSuppressed(target, RULE_A)).toBe(true);
    expect(index.isSuppressed(target, RULE_B)).toBe(false);
  });
});

// ============================================================================
// Block-comment form /* ... */
// ============================================================================
describe("buildSuppressions() — block-comment form", () => {
  it("accepts /* testtrust-disable-next-line */ (unscoped)", () => {
    const src = [
      "/* testtrust-disable-next-line */",
      "expect(true).toBe(true); // TARGET",
    ].join("\n");
    const index = buildSuppressions(src);

    expect(index.isSuppressed(lineOf(src, "TARGET"), RULE_A)).toBe(true);
  });

  it("accepts a scoped block-comment directive and stops at the closing */", () => {
    const src = [
      `/* testtrust-disable-next-line ${RULE_A} */`,
      "expect(x).toBeTruthy(); // TARGET",
    ].join("\n");
    const index = buildSuppressions(src);
    const target = lineOf(src, "TARGET");

    expect(index.isSuppressed(target, RULE_A)).toBe(true);
    // RULE_B appears nowhere in the directive, so it must not be suppressed —
    // proves the trailing `*/` is not swallowed into the rule list.
    expect(index.isSuppressed(target, RULE_B)).toBe(false);
  });

  it("accepts the block-comment disable-line form on the same line", () => {
    const src = [
      "noisy(); /* testtrust-disable-line */ // TARGET",
    ].join("\n");
    const index = buildSuppressions(src);

    expect(index.isSuppressed(lineOf(src, "TARGET"), RULE_B)).toBe(true);
  });
});

// ============================================================================
// Negative cases & robustness
// ============================================================================
describe("buildSuppressions() — no directive / robustness", () => {
  it("suppresses nothing on a line that has no directive", () => {
    const src = [
      "const z = 3;",
      "expect(z).toBe(3); // just a normal comment, no directive",
    ].join("\n");
    const index = buildSuppressions(src);

    expect(index.isSuppressed(1, RULE_A)).toBe(false);
    expect(index.isSuppressed(2, RULE_A)).toBe(false);
    expect(index.isSuppressed(2, RULE_B)).toBe(false);
  });

  it("does NOT suppress a rule whose name differs from the scoped one", () => {
    const src = [
      `// testtrust-disable-next-line ${RULE_A}`,
      "expect(x).toBe(x); // TARGET",
    ].join("\n");
    const index = buildSuppressions(src);
    const target = lineOf(src, "TARGET");

    // The directive scopes to RULE_A only; a finding for RULE_OTHER reports.
    expect(index.isSuppressed(target, RULE_OTHER)).toBe(false);
  });

  it("records unknown rule names without throwing (they never match)", () => {
    const src = [
      "// testtrust-disable-next-line not-a-real-rule",
      "expect(x).toBe(x); // TARGET",
    ].join("\n");

    let index!: ReturnType<typeof buildSuppressions>;
    expect(() => {
      index = buildSuppressions(src);
    }).not.toThrow();

    const target = lineOf(src, "TARGET");
    // Unknown name was recorded but matches no real RuleId.
    expect(index.isSuppressed(target, RULE_A)).toBe(false);
    // Cast only to exercise the literal that was recorded.
    expect(index.isSuppressed(target, "not-a-real-rule" as RuleId)).toBe(true);
  });

  it("treats a disable-next-line on the last line as a harmless no-op", () => {
    const src = ["const w = 4;", "// testtrust-disable-next-line"].join("\n");

    expect(() => buildSuppressions(src)).not.toThrow();
    const index = buildSuppressions(src);
    // There is no line 3 to suppress; nothing is suppressed anywhere.
    expect(index.isSuppressed(3, RULE_A)).toBe(false);
    expect(index.isSuppressed(2, RULE_A)).toBe(false);
  });

  it("handles CRLF line endings (trailing \\r does not break matching)", () => {
    const src = "// testtrust-disable-next-line\r\nexpect(true).toBe(true);\r\n";
    const index = buildSuppressions(src);
    // Line 1 = directive, line 2 = target.
    expect(index.isSuppressed(2, RULE_A)).toBe(true);
  });
});

// ============================================================================
// parseRuleList — the comma/space tokenizer
// ============================================================================
describe("parseRuleList()", () => {
  it("splits on commas and/or whitespace and trims", () => {
    expect(parseRuleList(" tautology,  assertion-free   over-mocking-sut ")).toEqual([
      "tautology",
      "assertion-free",
      "over-mocking-sut",
    ]);
  });

  it("returns an empty list for empty or whitespace-only input", () => {
    expect(parseRuleList("")).toEqual([]);
    expect(parseRuleList("   ")).toEqual([]);
  });
});
