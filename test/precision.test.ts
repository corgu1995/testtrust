// ============================================================================
// test/precision.test.ts
//
// THE PRECISION CONTRACT — the adversarial false-positive guard.
//
// testtrust is a tool that flags weak tests. Its single biggest risk is a FALSE
// POSITIVE: every detector's own docs say it plainly — "a single false positive
// mutes the whole tool". If healthy, well-written tests get flagged, engineers
// stop trusting the gate and disable it, and the product is dead. Recall can be
// improved later; a precision miss is a kill-shot.
//
// So this file does the opposite of every other spec: instead of proving the
// detectors CATCH bad tests, it proves they STAY SILENT on legitimate ones. For
// each of the five detectors we feed concrete, idiomatic, *good* test code that
// MUST yield zero findings (or zero findings of that detector's rule id).
//
// Per the assignment, the corpus deliberately includes at least:
//   • a well-written test with a concrete toEqual assertion      (no assertion-free,
//                                                                  no trivial, no taut.)
//   • expect(a).toBe(b) with DIFFERENT identifiers               (no tautology)
//   • a properly-mocked COLLABORATOR that is not the SUT         (no over-mocking-sut)
//   • a test using toHaveBeenCalledWith / toMatchObject          (not trivial, not taut.)
//   • a regression pair where a test was legitimately REFACTORED
//     (renamed, and toEqual -> toStrictEqual i.e. SAME-or-stronger) (no assertion-weakened)
//   • a regression pair where a NEW test was added              (nothing at all)
//   • a snapshot test that ALSO has a real expect               (not snapshot-only)
//
// Every scenario is built from inline source via the shared makeContext helper —
// no disk, no git — and each detector is invoked exactly as the engine does:
//   detector.run(makeContext(SRC), {})           // pure smells
//   detector.run(makeContext(HEAD, { baseText: BASE }), {})  // regression (the wedge)
//
// Determinism: all inputs are static string literals; no clocks, no randomness.
// ============================================================================

import { describe, expect, it } from "vitest";

import { detector as assertionFree } from "../src/detectors/assertionFree.js";
import { detector as tautology } from "../src/detectors/tautology.js";
import { detector as overMockingSut } from "../src/detectors/overMockingSut.js";
import { detector as trivialAssertion } from "../src/detectors/trivialAssertion.js";
import { detector as assertionStrength } from "../src/detectors/regression/assertionStrength.js";
import type { Detector, Finding, RuleId } from "../src/types.js";
import { makeContext } from "./helpers/context.js";

// ----------------------------------------------------------------------------
// Tiny invocation helpers — keep each scenario to one readable line.
// ----------------------------------------------------------------------------

/** No severity override: exactly how the engine calls a detector for the ACs. */
const NO_OPTIONS = {} as const;

/** Run one pure-smell detector against `src` (filePath controls SUT inference). */
function runOne(det: Detector, src: string, filePath: string): Finding[] {
  return det.run(makeContext(src, { filePath }), NO_OPTIONS);
}

/** Run the regression detector against a base/head pair. */
function runRegression(head: string, base: string, filePath = "subject.test.ts"): Finding[] {
  return assertionStrength.run(makeContext(head, { baseText: base, filePath }), NO_OPTIONS);
}

/** The four pure (non-regression) smell detectors — they all run on HEAD only. */
const PURE_DETECTORS: readonly Detector[] = [
  assertionFree,
  tautology,
  overMockingSut,
  trivialAssertion,
];

/**
 * Run EVERY pure detector against one legitimate source and return the union of
 * findings. A healthy test file must produce an empty union — this is the
 * strongest form of the precision contract (no detector may speak up).
 */
function allPureFindings(src: string, filePath: string): Finding[] {
  return PURE_DETECTORS.flatMap((det) => runOne(det, src, filePath));
}

/** Readable assertion: a finding list contains no entry with the given ruleId. */
function expectNoRule(findings: readonly Finding[], ruleId: RuleId): void {
  expect(findings.filter((f) => f.ruleId === ruleId)).toEqual([]);
}

// ----------------------------------------------------------------------------
// The legitimate corpus. Each constant is a *good* test file that an engineer
// would happily ship. They are named for the precision property they protect.
// ----------------------------------------------------------------------------

/**
 * (1) A well-written test with a concrete `toEqual` assertion. It pins an exact
 * value, so it is neither assertion-free, trivial, nor tautological.
 */
const WELL_WRITTEN_TOEQUAL = [
  `import { sum } from "./math";`,
  ``,
  `test("sums two positive numbers", () => {`,
  `  const result = sum(2, 3);`,
  `  expect(result).toEqual(5);`,
  `});`,
].join("\n");

/**
 * (2) `expect(a).toBe(b)` with DIFFERENT identifiers — the canonical NON-tautology.
 * The subject and matcher arg are distinct names, so the tautology rule (which
 * requires textually-identical sides) must stay silent.
 */
const TOBE_DIFFERENT_IDENTIFIERS = [
  `import { compute } from "./compute";`,
  ``,
  `test("returns the configured answer", () => {`,
  `  const actual = compute();`,
  `  const expected = 42;`,
  `  expect(actual).toBe(expected);`,
  `});`,
].join("\n");

/**
 * (3) A properly-mocked COLLABORATOR that is NOT the subject under test. The file
 * exercises the real `userService` (its named subject) and only mocks `./db`, a
 * downstream collaborator. This is the healthy, recommended pattern — the
 * over-mocking-sut rule must not fire (AC2). It also asserts a concrete call,
 * so no other rule fires either.
 */
const MOCKED_COLLABORATOR_NOT_SUT = [
  `import { createUser } from "./userService";`,
  `import { db } from "./db";`,
  ``,
  `vi.mock("./db");`,
  ``,
  `test("persists the new user via the db collaborator", () => {`,
  `  createUser({ name: "Ada" });`,
  `  expect(db.insert).toHaveBeenCalledWith({ name: "Ada" });`,
  `});`,
].join("\n");

/**
 * (4) Tests using `toHaveBeenCalledWith` and `toMatchObject` — strong, specific
 * matchers. Neither is in the trivial whitelist nor the tautology equality set,
 * so trivial-assertion and tautology must both stay silent (and the bodies do
 * assert, so assertion-free stays silent too).
 */
const RICH_MATCHERS = [
  `import { handle } from "./handler";`,
  ``,
  `test("forwards the enriched payload to the sink", () => {`,
  `  const sink = vi.fn();`,
  `  handle({ id: 1 }, sink);`,
  `  expect(sink).toHaveBeenCalledWith({ id: 1, ok: true });`,
  `});`,
  ``,
  `test("returns an object matching the expected shape", () => {`,
  `  const out = handle({ id: 2 });`,
  `  expect(out).toMatchObject({ id: 2, ok: true });`,
  `});`,
].join("\n");

/**
 * (5) A snapshot test that ALSO carries a concrete, non-snapshot assertion. Per
 * the assertion-free detector's AC3 the snapshot is then merely supplementary,
 * so it must NOT be reported as snapshot-only (nor assertion-free).
 */
const SNAPSHOT_PLUS_REAL_ASSERTION = [
  `import { render } from "./view";`,
  ``,
  `test("renders the hero and keeps a snapshot for context", () => {`,
  `  const out = render();`,
  `  expect(out.id).toBe("hero");`,
  `  expect(out).toMatchSnapshot();`,
  `});`,
].join("\n");

/**
 * (6) A test that legitimately asserts through a LOCAL helper. The body makes no
 * direct assertion, but the in-file helper it calls does — the detector resolves
 * the helper and must emit nothing (its load-bearing precision guard).
 */
const ASSERTS_VIA_LOCAL_HELPER = [
  `import { build } from "./builder";`,
  ``,
  `function expectValidUser(user) {`,
  `  expect(user.id).toEqual(1);`,
  `  expect(user.name).toBe("Ada");`,
  `}`,
  ``,
  `test("builds a valid user", () => {`,
  `  expectValidUser(build());`,
  `});`,
].join("\n");

/**
 * (7) A positive `toThrow(SpecificError)` — it pins an expected error type, so it
 * carries real signal and is NOT trivial (only a NEGATED `.not.toThrow()` is).
 */
const POSITIVE_TOTHROW_WITH_ARG = [
  `import { parse } from "./parser";`,
  ``,
  `test("rejects malformed input with a SyntaxError", () => {`,
  `  expect(() => parse("oops")).toThrow(SyntaxError);`,
  `});`,
].join("\n");

/**
 * (8) A `node:assert` based test with a concrete equality check. The shared
 * helpers treat node:assert calls as real, concrete assertions, so none of the
 * smells fire.
 */
const NODE_ASSERT_CONCRETE = [
  `import assert from "node:assert";`,
  `import { slugify } from "./slug";`,
  ``,
  `test("slugifies a title deterministically", () => {`,
  `  assert.deepStrictEqual(slugify("Hello World"), "hello-world");`,
  `});`,
].join("\n");

/** Every legitimate pure-smell source, with the file name the engine would see. */
const LEGIT_CORPUS: ReadonlyArray<{ name: string; src: string; filePath: string }> = [
  { name: "well-written toEqual", src: WELL_WRITTEN_TOEQUAL, filePath: "math.test.ts" },
  { name: "toBe with different identifiers", src: TOBE_DIFFERENT_IDENTIFIERS, filePath: "compute.test.ts" },
  { name: "mocked collaborator (not SUT)", src: MOCKED_COLLABORATOR_NOT_SUT, filePath: "userService.test.ts" },
  { name: "rich matchers (calledWith / matchObject)", src: RICH_MATCHERS, filePath: "handler.test.ts" },
  { name: "snapshot + real assertion", src: SNAPSHOT_PLUS_REAL_ASSERTION, filePath: "view.test.ts" },
  { name: "asserts via local helper", src: ASSERTS_VIA_LOCAL_HELPER, filePath: "builder.test.ts" },
  { name: "positive toThrow(arg)", src: POSITIVE_TOTHROW_WITH_ARG, filePath: "parser.test.ts" },
  { name: "node:assert concrete", src: NODE_ASSERT_CONCRETE, filePath: "slug.test.ts" },
];

// ============================================================================
// Tests
// ============================================================================

describe("precision contract — legitimate tests must produce ZERO findings", () => {
  // --------------------------------------------------------------------------
  // The master sweep: NO pure detector may flag ANY legitimate source. If this
  // ever goes red, the tool has started biting the hand that feeds it.
  // --------------------------------------------------------------------------
  describe("master sweep: every pure detector stays silent on every good file", () => {
    for (const { name, src, filePath } of LEGIT_CORPUS) {
      it(`emits nothing across all detectors for: ${name}`, () => {
        const findings = allPureFindings(src, filePath);
        expect(findings).toEqual([]);
        expect(findings).toHaveLength(0);
      });
    }
  });

  // --------------------------------------------------------------------------
  // (1) assertion-free / snapshot-only — must not fire on real assertions.
  // --------------------------------------------------------------------------
  describe("assertion-free detector", () => {
    it("does not flag a well-written test with a concrete toEqual", () => {
      const findings = runOne(assertionFree, WELL_WRITTEN_TOEQUAL, "math.test.ts");
      expect(findings).toEqual([]);
    });

    it("does not flag a snapshot test that ALSO has a real expect (not snapshot-only)", () => {
      const findings = runOne(assertionFree, SNAPSHOT_PLUS_REAL_ASSERTION, "view.test.ts");
      // Neither the assertion-free nor the snapshot-only rule may appear.
      expect(findings).toEqual([]);
      expectNoRule(findings, "snapshot-only");
      expectNoRule(findings, "assertion-free");
    });

    it("does not flag a test that asserts via a resolvable in-file helper", () => {
      const findings = runOne(assertionFree, ASSERTS_VIA_LOCAL_HELPER, "builder.test.ts");
      expect(findings).toEqual([]);
    });

    it("does not flag a node:assert based test", () => {
      const findings = runOne(assertionFree, NODE_ASSERT_CONCRETE, "slug.test.ts");
      expectNoRule(findings, "assertion-free");
      expectNoRule(findings, "snapshot-only");
      expect(findings).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // (2) tautology — must not fire when the two sides differ.
  // --------------------------------------------------------------------------
  describe("tautology detector", () => {
    it("does not flag expect(a).toBe(b) with DIFFERENT identifiers", () => {
      const findings = runOne(tautology, TOBE_DIFFERENT_IDENTIFIERS, "compute.test.ts");
      expectNoRule(findings, "tautology");
      expect(findings).toEqual([]);
    });

    it("does not flag a concrete toEqual against a distinct literal", () => {
      const findings = runOne(tautology, WELL_WRITTEN_TOEQUAL, "math.test.ts");
      expect(findings).toEqual([]);
    });

    it("does not flag asymmetric matchers like toHaveBeenCalledWith / toMatchObject", () => {
      const findings = runOne(tautology, RICH_MATCHERS, "handler.test.ts");
      expectNoRule(findings, "tautology");
      expect(findings).toHaveLength(0);
    });

    it("does not flag a non-equality matcher even when both sides read alike", () => {
      // toContain is NOT an equality matcher, so self-ish shape never tautologizes.
      const src = [
        `test("contains the expected member", () => {`,
        `  const list = collect();`,
        `  expect(list).toContain(list[0]);`,
        `});`,
      ].join("\n");
      const findings = runOne(tautology, src, "collect.test.ts");
      expect(findings).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // (3) over-mocking-sut — must not fire when a COLLABORATOR (not the SUT) is
  // mocked. This is the over-mocking precision case the assignment asks for.
  // --------------------------------------------------------------------------
  describe("over-mocking-sut detector", () => {
    it("does not flag mocking a collaborator that is not the subject under test", () => {
      const findings = runOne(overMockingSut, MOCKED_COLLABORATOR_NOT_SUT, "userService.test.ts");
      expectNoRule(findings, "over-mocking-sut");
      expect(findings).toEqual([]);
    });

    it("does not flag a mere basename collision in a different directory", () => {
      // Subject "cart" is imported from "../services/cart"; the mock targets a
      // DIFFERENT path "./cart". Trivial normalization must not equate them.
      const src = [
        `import { addItem } from "../services/cart";`,
        `vi.mock("./cart");`,
        `test("adds an item", () => { expect(addItem([], "x")).toEqual(["x"]); });`,
      ].join("\n");
      const findings = runOne(overMockingSut, src, "cart.test.ts");
      expect(findings).toEqual([]);
    });

    it("does not flag a test file that mocks nothing at all", () => {
      const findings = runOne(overMockingSut, WELL_WRITTEN_TOEQUAL, "math.test.ts");
      expect(findings).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // (4) trivial-assertion — must not fire when a concrete check is present.
  // --------------------------------------------------------------------------
  describe("trivial-assertion detector", () => {
    it("does not flag a test using toHaveBeenCalledWith / toMatchObject", () => {
      const findings = runOne(trivialAssertion, RICH_MATCHERS, "handler.test.ts");
      expectNoRule(findings, "trivial-assertion");
      expect(findings).toEqual([]);
    });

    it("does not flag a concrete toEqual assertion", () => {
      const findings = runOne(trivialAssertion, WELL_WRITTEN_TOEQUAL, "math.test.ts");
      expect(findings).toEqual([]);
    });

    it("does not flag a POSITIVE toThrow that pins an expected error type", () => {
      // Only `.not.toThrow()` is trivial; a positive toThrow(SpecificError) is not.
      const findings = runOne(trivialAssertion, POSITIVE_TOTHROW_WITH_ARG, "parser.test.ts");
      expectNoRule(findings, "trivial-assertion");
      expect(findings).toEqual([]);
    });

    it("does not flag a body that mixes a weak matcher WITH a concrete one", () => {
      // AC2: the presence of one non-trivial assertion clears the test, even if a
      // weak toBeDefined sits alongside it.
      const src = [
        `import { load } from "./loader";`,
        `test("loads a defined, correctly-shaped record", () => {`,
        `  const rec = load();`,
        `  expect(rec).toBeDefined();`,
        `  expect(rec).toEqual({ id: 1, name: "Ada" });`,
        `});`,
      ].join("\n");
      const findings = runOne(trivialAssertion, src, "loader.test.ts");
      expect(findings).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // (5) regression / "the wedge" — must not fire on legitimate refactors, new
  // tests, or strengthened assertions. These are the highest-stakes false
  // positives because the whole product is built around this one detector.
  // --------------------------------------------------------------------------
  describe("regression detector (assertion-weakened / -deleted / test-skipped)", () => {
    it("does not flag a legitimately RENAMED test (no base counterpart by title)", () => {
      // Same body and same strength; only the title changed. The detector pairs on
      // exact title path, so a rename has no base counterpart => emit nothing (AC5).
      const base = `test("old wording of the case", () => { expect(load()).toEqual({ a: 1 }); });`;
      const head = `test("new clearer wording of the case", () => { expect(load()).toEqual({ a: 1 }); });`;
      const findings = runRegression(head, base);
      expect(findings).toEqual([]);
    });

    it("does not flag an assertion that was STRENGTHENED toEqual -> toStrictEqual", () => {
      // Same title, same subject, SAME-or-stronger matcher (both tier 4, and strict
      // is if anything stronger). A same-or-stronger change is never a weakening.
      const base = `test("keeps the record exact", () => { expect(build()).toEqual({ a: 1 }); });`;
      const head = `test("keeps the record exact", () => { expect(build()).toStrictEqual({ a: 1 }); });`;
      const findings = runRegression(head, base);
      expectNoRule(findings, "assertion-weakened");
      expect(findings).toEqual([]);
    });

    it("does not flag a same-tier matcher swap (toEqual -> toMatchObject)", () => {
      // Both are tier-4 structural matchers; an intra-tier swap is explicitly NOT a
      // weakening (the model only flags cross-tier downgrades).
      const base = `test("same strength swap", () => { expect(load()).toEqual({ a: 1 }); });`;
      const head = `test("same strength swap", () => { expect(load()).toMatchObject({ a: 1 }); });`;
      const findings = runRegression(head, base);
      expectNoRule(findings, "assertion-weakened");
      expect(findings).toEqual([]);
    });

    it("does not flag a brand-NEW test added alongside the unchanged one", () => {
      const base = `test("pre-existing case", () => { expect(f()).toBe(1); });`;
      const head = [
        `test("pre-existing case", () => { expect(f()).toBe(1); });`,
        `test("freshly added case", () => { expect(g()).toBe(2); });`,
      ].join("\n");
      const findings = runRegression(head, base);
      // No rule of any kind: the old test is identical, the new one has no base.
      expect(findings).toEqual([]);
    });

    it("does not flag a test whose assertions are unchanged (identical base/head)", () => {
      const same = [
        `test("a stable, unchanged assertion", () => {`,
        `  expect(compute()).toEqual({ ok: true });`,
        `});`,
      ].join("\n");
      const findings = runRegression(same, same);
      expect(findings).toEqual([]);
    });

    it("does not flag a test that ADDED an extra assertion (strengthened coverage)", () => {
      // Head keeps the original assertion and adds a second concrete one. Pairing is
      // by subject; the surviving subject is unchanged and the new subject has no
      // base counterpart, so nothing is a weakening.
      const base = [
        `test("verifies the id", () => {`,
        `  expect(make().id).toBe(1);`,
        `});`,
      ].join("\n");
      const head = [
        `test("verifies the id", () => {`,
        `  expect(make().id).toBe(1);`,
        `  expect(make().name).toEqual("Ada");`,
        `});`,
      ].join("\n");
      const findings = runRegression(head, base);
      expect(findings).toEqual([]);
    });

    it("emits nothing when there is no base ref at all (requiresBase)", () => {
      // With no baseText, baseSourceFile is undefined and the wedge has nothing to
      // regress against — it must stay completely silent.
      const findings = assertionStrength.run(
        makeContext(WELL_WRITTEN_TOEQUAL, { filePath: "math.test.ts" }),
        NO_OPTIONS,
      );
      expect(findings).toEqual([]);
    });
  });
});

// ============================================================================
// WAVE B — false-positive classes found auditing 8 fresh real-world repos
// (valibot, es-toolkit, remeda, radashi, ts-pattern, neverthrow, valita,
// ts-essentials) before the v0.1.8 precision pass. Each block pins one class:
// the LEGIT pattern must stay SILENT, and — just as important — the confirmed
// TRUE positives from the same audit must STILL fire (so a fix never trades a
// false positive for a false negative).
// ============================================================================
describe("precision: Wave B FP classes (v0.1.8)", () => {
  // -- Class 1: custom assertion-helper wrappers (valibot, 1458 hits) --------
  describe("assertion-free: named assertion-helper wrappers", () => {
    it("stays silent when the body delegates to an imported expect*-named helper", () => {
      // valibot funnels nearly every parse test through library/src/vitest helpers
      // (expectNoSchemaIssue/expectNoActionIssue) that loop expect(...).toStrictEqual.
      const src = [
        `import { expect } from "vitest";`,
        `import { expectNoSchemaIssue } from "../../vitest";`,
        `test("accepts the listed values", () => {`,
        `  expectNoSchemaIssue(schema, [-1n, 0n, 123n]);`,
        `});`,
      ].join("\n");
      expectNoRule(runOne(assertionFree, src, "any.test.ts"), "assertion-free");
    });

    it("stays silent for an assert*-named imported helper too", () => {
      const src = [
        `import { assertParsed } from "./helpers";`,
        `test("parses ok", () => { assertParsed(schema, input); });`,
      ].join("\n");
      expectNoRule(runOne(assertionFree, src, "parse.test.ts"), "assertion-free");
    });

    // TRUE POSITIVE GUARD: a real no-op `expect(x)` with NO matcher (es-toolkit's
    // ported-from-lodash bug) must STILL be caught — the named-helper rule only
    // suppresses bare HELPER calls, never an `expect(...)` entry with no matcher.
    it("still flags a real no-matcher expect() no-op", () => {
      const src = [
        `import { expect, test } from "vitest";`,
        `test("random in range", () => {`,
        `  const actual = random(min, max);`,
        `  expect(actual % 1);`,
        `  expect(actual >= min && actual <= max);`,
        `});`,
      ].join("\n");
      const findings = runOne(assertionFree, src, "random.spec.ts");
      expect(findings.some((f) => f.ruleId === "assertion-free")).toBe(true);
    });

    // GUARD: a non-asserting-named imported helper stays a low-confidence info
    // (we genuinely cannot tell whether it asserts), NOT suppressed.
    it("still emits info for a non-asserting-named imported helper", () => {
      const src = [
        `import { processResult } from "./helpers";`,
        `test("delegates outside the file", () => { processResult(thing()); });`,
      ].join("\n");
      const findings = runOne(assertionFree, src, "x.test.ts");
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe("info");
    });
  });

  // -- Class 2: ts-pattern throwing terminal .exhaustive()/.run() (13 hits) ---
  describe("assertion-free: ts-pattern exhaustive match terminal", () => {
    it("stays silent on a match(...).with(...).exhaustive() body", () => {
      const src = [
        `import { match } from "ts-pattern";`,
        `it("works with nullables", () => {`,
        `  match(input)`,
        `    .with(null, undefined, (x) => "Nullable")`,
        `    .exhaustive();`,
        `});`,
      ].join("\n");
      expectNoRule(runOne(assertionFree, src, "multiple-patterns.test.ts"), "assertion-free");
    });

    it("stays silent on the .run() alias too", () => {
      const src = [
        `import { match } from "ts-pattern";`,
        `it("routes", () => { match(x).with(1, () => "a").run(); });`,
      ].join("\n");
      expectNoRule(runOne(assertionFree, src, "run.test.ts"), "assertion-free");
    });

    // GUARD: `.otherwise()` does NOT throw (it returns a fallback), so a body that
    // only matches with an otherwise() fallback genuinely asserts nothing at runtime.
    it("still flags a non-throwing .otherwise() terminal", () => {
      const src = [
        `import { match } from "ts-pattern";`,
        `it("falls back", () => { match(x).with(1, () => "a").otherwise(() => "b"); });`,
      ].join("\n");
      const findings = runOne(assertionFree, src, "otherwise.test.ts");
      expect(findings.some((f) => f.ruleId === "assertion-free")).toBe(true);
    });

    // GUARD: a generic `.run()` NOT rooted at match() must not be excused.
    it("still flags a bare .run() not rooted at match()", () => {
      const src = [`it("invokes a runner", () => { const job = makeJob(); job.run(); });`].join("\n");
      const findings = runOne(assertionFree, src, "job.test.ts");
      expect(findings.some((f) => f.ruleId === "assertion-free")).toBe(true);
    });
  });

  // -- Class 3: typed-return-position type test (valita, 4 hits) -------------
  describe("assertion-free: typed-return-position type assertion", () => {
    it("stays silent when a nested fn's return-type annotation is the assertion", () => {
      const src = [
        `import * as v from "@badrap/valita";`,
        `it("returns ValitaResult<T> for v.Type<T>", () => {`,
        `  function _<T>(type: v.Type<T>, value: unknown): v.ValitaResult<T> {`,
        `    return type.try(value);`,
        `  }`,
        `});`,
      ].join("\n");
      expectNoRule(runOne(assertionFree, src, "Type.test.ts"), "assertion-free");
    });

    it("handles a bare type-parameter return type", () => {
      const src = [
        `it("returns T for v.Type<T>", () => {`,
        `  function _<T>(type: v.Type<T>, value: unknown): T {`,
        `    return type.parse(value);`,
        `  }`,
        `});`,
      ].join("\n");
      expectNoRule(runOne(assertionFree, src, "Type.test.ts"), "assertion-free");
    });

    // GUARD: a function with NO params is not the typed-return idiom — a genuinely
    // empty test like this must STILL be flagged (the return annotation alone is
    // not a SUT-type assertion).
    it("still flags a no-arg typed function (not a type test)", () => {
      const src = [
        `it("does setup only", () => {`,
        `  function setup(): number { return compute(); }`,
        `});`,
      ].join("\n");
      const findings = runOne(assertionFree, src, "setup.test.ts");
      expect(findings.some((f) => f.ruleId === "assertion-free")).toBe(true);
    });
  });

  // -- Class 4: concrete-boolean subject under toBeTruthy/toBeFalsy ----------
  // (radashi ~124 hits, es-toolkit)
  describe("trivial-assertion: concrete boolean subject", () => {
    it("stays silent on a type-guard predicate under toBeFalsy", () => {
      const src = [
        `it("isClass", () => {`,
        `  expect(_.isClass(OldSchoolClass)).toBeFalsy();`,
        `  expect(_.isClass(fn)).toBeFalsy();`,
        `  expect(_.isClass(Number.NaN)).toBeFalsy();`,
        `});`,
      ].join("\n");
      expectNoRule(runOne(trivialAssertion, src, "isClass.test.ts"), "trivial-assertion");
    });

    it("stays silent on a boolean-returning method (.includes) under toBeFalsy", () => {
      const src = `it("not iterated", () => { expect(keys.includes("a")).toBeFalsy(); });`;
      expectNoRule(runOne(trivialAssertion, src, "forEach.spec.ts"), "trivial-assertion");
    });

    it("stays silent on a comparison/logical expression under toBeTruthy", () => {
      const src = `it("in range", () => { expect(value >= min && value <= max).toBeTruthy(); });`;
      expectNoRule(runOne(trivialAssertion, src, "range.test.ts"), "trivial-assertion");
    });

    it("stays silent on a deep-equality predicate under toBeTruthy", () => {
      const src = `it("isEqual", () => { expect(isEqual(actual, new Error("x"))).toBeTruthy(); });`;
      expectNoRule(runOne(trivialAssertion, src, "attempt.spec.ts"), "trivial-assertion");
    });

    it("stays silent on a variable assigned from a predicate then checked (radashi shape)", () => {
      // const result = _.isSymbol(x); expect(result).toBeFalsy() — result is boolean.
      const src = [
        `import * as _ from "radashi";`,
        `test("isSymbol on a non-symbol", () => {`,
        `  const result = _.isSymbol(123);`,
        `  expect(result).toBeFalsy();`,
        `});`,
      ].join("\n");
      expectNoRule(runOne(trivialAssertion, src, "isSymbol.test.ts"), "trivial-assertion");
    });

    // TRUE POSITIVE GUARDS: the genuinely weak shapes must STILL be flagged.
    it("still flags toBeTruthy on a bare identifier", () => {
      const findings = runOne(trivialAssertion, `it("x", () => { expect(result).toBeTruthy(); });`, "x.test.ts");
      expect(findings.some((f) => f.ruleId === "trivial-assertion")).toBe(true);
    });

    it("still flags toBeTruthy on a non-predicate call (getUser())", () => {
      const findings = runOne(trivialAssertion, `it("x", () => { expect(getUser()).toBeTruthy(); });`, "x.test.ts");
      expect(findings.some((f) => f.ruleId === "trivial-assertion")).toBe(true);
    });

    it("still flags a variable assigned from a NON-predicate call", () => {
      const src = `test("x", () => { const result = getUser(); expect(result).toBeTruthy(); });`;
      const findings = runOne(trivialAssertion, src, "x.test.ts");
      expect(findings.some((f) => f.ruleId === "trivial-assertion")).toBe(true);
    });

    it("still flags toBeDefined regardless of subject", () => {
      const findings = runOne(trivialAssertion, `it("x", () => { expect(isReady()).toBeDefined(); });`, "x.test.ts");
      expect(findings.some((f) => f.ruleId === "trivial-assertion")).toBe(true);
    });

    it("still flags a lone .not.toThrow()", () => {
      const findings = runOne(trivialAssertion, `it("x", () => { expect(() => run()).not.toThrow(); });`, "x.test.ts");
      expect(findings.some((f) => f.ruleId === "trivial-assertion")).toBe(true);
    });
  });

  // -- Class 5: tautology used as a reachability marker (ts-pattern, 2 hits) --
  describe("tautology: reachability marker beside a real assertion", () => {
    it("stays silent on expect(true).toBe(true) next to an else-throw + type assertion", () => {
      const src = [
        `import { expect } from "vitest";`,
        `it("narrows via the guard", () => {`,
        `  if (isBlogPost(something)) {`,
        `    type t = Expect<Equal<typeof something, { title: string }>>;`,
        `    expect(true).toBe(true);`,
        `  } else {`,
        `    throw new Error("isMatching should have returned true");`,
        `  }`,
        `});`,
      ].join("\n");
      expectNoRule(runOne(tautology, src, "is-matching.test.ts"), "tautology");
    });

    // TRUE POSITIVE GUARD: a bare expect(true).toBe(true) with no co-located real
    // assertion is the classic test-gaming tautology and must STILL be flagged.
    it("still flags a bare expect(true).toBe(true) test-gaming tautology", () => {
      const findings = runOne(tautology, `it("totally works", () => { expect(true).toBe(true); });`, "gamed.test.ts");
      expect(findings.some((f) => f.ruleId === "tautology")).toBe(true);
    });
  });
});
