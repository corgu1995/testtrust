// ============================================================================
// src/detectors/tautology.ts
//
// The "tautology" smell detector.
//
// A tautological assertion is one that can NEVER fail — it asserts a value
// against itself, so the test passes no matter what the code under test does.
// These are a classic shape of test-gaming: an agent told to "add a test" emits
// `expect(true).toBe(true)` or `expect(result).toBe(result)`, CI goes green, and
// nothing was actually verified.
//
// We flag three rock-solid shapes (all on the `expect(...).matcher(arg)` form):
//   AC1  expect(true).toBe(true) / expect(false).toBe(false)   (same boolean lit)
//   AC2  expect(x).toBe(x) / expect(x).toEqual(x)              (same identifier)
//   AC3  expect(LIT).toBe(LIT)                                 (identical literal)
// We do NOT flag `expect(a).toBe(b)` with DIFFERENT identifiers (AC4).
//
// CALLS ARE NOT TAUTOLOGIES (AC5): when either side is (or contains) a CALL —
// e.g. `expect(f()).toBe(f())`, `expect(useStore()).toBe(useStore())`,
// `expect(obj.get()).toBe(obj.get())` — we emit NOTHING. Two evaluations of a
// call can return DIFFERENT values, so asserting they are equal verifies
// something real: memoization (jotai `atomFamily` caching by param), singletons
// (a pinia/zustand store), or idempotency. Flagging these would be a false
// positive that tanks the tool's credibility, so only PROVABLY always-true forms
// (same primitive literal or same plain identifier on both sides) are emitted,
// always at "warn".
//
// DESIGN BIAS — PRECISION FIRST (this feeds a CI gate; one false positive mutes
// the whole tool). Every ambiguous shape is resolved toward emitting NOTHING:
//
//   * Only POSITIVE assertions count. A negated chain (`expect(x).not.toBe(x)`)
//     always FAILS, so flagging it as "never fails" would be exactly backwards.
//     `.resolves` / `.rejects` chains are skipped too — the subject is a promise
//     and self-equality there is not the trivial tautology this rule targets.
//
//   * Only the EQUALITY matchers where self-equality is genuinely meaningful:
//     `toBe`, `toEqual`, `toStrictEqual`. (Asymmetric / partial matchers like
//     `toMatchObject` or `toContain` are out of scope.)
//
//   * Only PRIMITIVE literals and PLAIN identifiers are treated as "provably
//     self-equal". We deliberately do NOT flag identical-text object/array
//     literals: under `toBe` (===) two distinct `[1]` / `{a:1}` literals are NOT
//     equal — that assertion would FAIL, and flagging it as a tautology would be
//     a false positive. Member accesses (`a.b`, possible getters), `new`, and
//     templates with holes are likewise left alone.
//
//   * The two sides must be textually identical (whitespace-insensitive). That
//     is what separates a tautology from a real assertion such as
//     `expect(a).toBe(b)`.
// ============================================================================

import { SyntaxKind } from "ts-morph";
import type { Node } from "ts-morph";
import type {
  Detector,
  DetectorMeta,
  DetectorRunOptions,
  Finding,
  TestFileContext,
} from "../types.js";
import {
  getAssertions,
  getLineSnippet,
  getPosition,
  hasTypeLevelAssertion,
  type Assertion,
} from "./shared.js";

// ----------------------------------------------------------------------------
// Static description
// ----------------------------------------------------------------------------

const meta: DetectorMeta = {
  id: "tautology",
  title: "Tautological assertion",
  description: "Flags assertions that compare a value to itself and can never fail.",
  defaultSeverity: "warn",
  requiresBase: false,
};

// ----------------------------------------------------------------------------
// Matcher allow-list
// ----------------------------------------------------------------------------

/**
 * The ONLY matchers for which "subject equals matcher-arg" is a meaningful
 * always-true claim. All three are symmetric equality assertions:
 *   - `toBe`         — Object.is / === (reference or primitive identity)
 *   - `toEqual`      — recursive structural equality
 *   - `toStrictEqual`— recursive structural equality + type/undefined-key checks
 *
 * For each of these, `expect(X).matcher(X)` (same literal or same identifier) is
 * reflexively true. Partial/asymmetric matchers (`toMatchObject`, `toContain`,
 * `toHaveProperty`, …) are intentionally excluded — self-comparison there is not
 * the trivial tautology this rule targets.
 */
const EQUALITY_MATCHERS: ReadonlySet<string> = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
]);

// ----------------------------------------------------------------------------
// Node-shape predicates (purely syntactic; never throw)
// ----------------------------------------------------------------------------

/**
 * Primitive literal kinds that are PROVABLY self-equal under every matcher in
 * {@link EQUALITY_MATCHERS}. Two textually-identical primitives are equal by
 * `===` AND by deep equality.
 *
 * Deliberately EXCLUDES object/array literals: under `toBe` two distinct object
 * literals are NOT `===`, so `expect([1]).toBe([1])` actually FAILS — treating
 * it as a tautology would be a false positive.
 *
 * Note `undefined` / `NaN` / `Infinity` are plain identifiers, not literal
 * kinds, and are handled by {@link isPlainIdentifier} instead — which is correct
 * (`expect(undefined).toBe(undefined)` is a genuine self-equal tautology).
 */
const PRIMITIVE_LITERAL_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.StringLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
]);

/** True when `node` is a primitive literal (see {@link PRIMITIVE_LITERAL_KINDS}). */
function isPrimitiveLiteral(node: Node | undefined): boolean {
  if (node === undefined) return false;
  try {
    return PRIMITIVE_LITERAL_KINDS.has(node.getKind());
  } catch {
    return false;
  }
}

/** True when `node` is a bare identifier (e.g. `x`, `undefined`, `result`). */
function isPlainIdentifier(node: Node | undefined): boolean {
  if (node === undefined) return false;
  try {
    return node.getKind() === SyntaxKind.Identifier;
  } catch {
    return false;
  }
}

/**
 * True when `node` IS a call expression or contains one anywhere in its subtree.
 * Used to SUPPRESS the finding entirely: a call's return value can differ
 * between the two evaluations, so an identical-text self-comparison around a
 * call is not provably always-true — it is real verification (memoization /
 * singleton / idempotency), not a tautology. Never throws.
 */
function containsCall(node: Node | undefined): boolean {
  if (node === undefined) return false;
  try {
    if (node.getKind() === SyntaxKind.CallExpression) return true;
    // `getFirstDescendantByKind` is a cheap, bounded search; we only need to
    // know existence, not collect them.
    return node.getFirstDescendantByKind(SyntaxKind.CallExpression) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Whitespace-insensitive source text of a node, or `undefined` on failure.
 * Collapsing all whitespace lets us treat `f( )` and `f()` — or a subject and
 * matcher arg spread across lines — as the same text, while the node-kind gates
 * around the call site keep this from over-matching. Never throws.
 */
function normalizedText(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  try {
    if (node.wasForgotten()) return undefined;
    return node.getText().replace(/\s+/g, "");
  } catch {
    return undefined;
  }
}

// ----------------------------------------------------------------------------
// Per-assertion classification
// ----------------------------------------------------------------------------

/**
 * Outcome of inspecting one assertion: a "warn"-level tautology, or nothing.
 *
 * There is intentionally no "info" tier: a self-comparison is only ever flagged
 * when it is PROVABLY always-true (same primitive literal or same plain
 * identifier on both sides). The moment a CALL appears on either side the
 * equality is no longer provable — two calls can return different values — so we
 * emit nothing rather than a low-confidence finding (that shape is real
 * memoization / singleton / idempotency verification, not a tautology).
 */
type TautologyKind = "warn" | undefined;

/**
 * Decide whether `assertion` is a self-comparison tautology and, if so, at what
 * confidence. Returns `undefined` for anything that is not a clear tautology.
 *
 * Requirements (every one must hold; any miss => `undefined`):
 *   - framework is `expect` (the only shape the ACs cover);
 *   - NOT negated and NO `.resolves`/`.rejects` modifier;
 *   - matcher is one of {@link EQUALITY_MATCHERS};
 *   - exactly one subject arg AND exactly one matcher arg;
 *   - the two args are textually identical (whitespace-insensitive).
 *
 * Severity:
 *   - "warn" when BOTH sides are primitive literals, or BOTH are plain
 *     identifiers (provably self-equal: AC1 / AC2 / AC3);
 *   - `undefined` (emit nothing) when either side is / contains a CALL — the
 *     equality is unprovable because two calls can return different values, so
 *     the assertion verifies something real (memoization / singleton /
 *     idempotency), NOT a tautology (AC5);
 *   - `undefined` otherwise (identical text but some other expression shape —
 *     e.g. object/array literal, member access — which we refuse to judge).
 */
function classifyAssertion(assertion: Assertion): TautologyKind {
  if (assertion.framework !== "expect") return undefined;
  // A negated or async chain is NOT an always-pass tautology.
  if (assertion.negated) return undefined;
  if (assertion.modifier !== undefined) return undefined;

  const matcher = assertion.matcher;
  if (matcher === undefined || !EQUALITY_MATCHERS.has(matcher)) return undefined;

  // Exactly one value on each side. Anything else (no subject, extra args, a
  // spread, …) is outside the simple `expect(X).matcher(X)` shape we model.
  if (assertion.subjectArgs.length !== 1 || assertion.matcherArgs.length !== 1) {
    return undefined;
  }

  const subject = assertion.subjectArgs[0];
  const matcherArg = assertion.matcherArgs[0];
  if (subject === undefined || matcherArg === undefined) return undefined;

  // The defining property of a self-comparison: identical text on both sides.
  // This is what excludes the legitimate `expect(a).toBe(b)` case (AC4).
  const subjectText = normalizedText(subject);
  const matcherText = normalizedText(matcherArg);
  if (subjectText === undefined || matcherText === undefined) return undefined;
  if (subjectText !== matcherText) return undefined;

  // Identical text — now decide confidence by what KIND of expression it is.

  // (AC5) Any call on either side: emit NOTHING. Identical text is NOT a
  // tautology here, because two evaluations of a call can return DIFFERENT
  // values — so asserting they are equal verifies something real. This is the
  // memoization / singleton / idempotency family we must never flag, e.g.
  //   expect(myFamily(0)).toEqual(myFamily(0))  // atomFamily caches by param
  //   expect(useStore()).toBe(useStore())       // store is a singleton
  //   expect(obj.get()).toBe(obj.get())         // method call, same idea
  // `containsCall` matches a CallExpression anywhere in either operand's
  // subtree, so wrapped forms like `f(x)` and `obj.make()` are covered too.
  if (containsCall(subject) || containsCall(matcherArg)) return undefined;

  // (AC1 / AC3) Both sides the same primitive literal: provably equal.
  if (isPrimitiveLiteral(subject) && isPrimitiveLiteral(matcherArg)) return "warn";

  // (AC2) Both sides the same plain identifier: reflexively equal.
  if (isPlainIdentifier(subject) && isPlainIdentifier(matcherArg)) return "warn";

  // Identical text but some other shape (object/array literal, member access,
  // `new`, template-with-holes, …). Too risky to call a tautology — under `toBe`
  // some of these would actually FAIL. Emit nothing (precision over recall).
  return undefined;
}

// ----------------------------------------------------------------------------
// Detector entry point
// ----------------------------------------------------------------------------

/**
 * Walk every assertion in the HEAD file and emit a finding for each
 * self-comparison tautology. Pure & synchronous; tolerates malformed input via
 * the never-throwing shared helpers.
 */
function run(ctx: TestFileContext, options: DetectorRunOptions): Finding[] {
  const findings: Finding[] = [];

  // One pass over the whole file's assertions. `getAssertions` already returns
  // the OUTERMOST matcher call per chain, so there's no double-reporting.
  for (const assertion of getAssertions(ctx.sourceFile)) {
    const kind = classifyAssertion(assertion);
    if (kind === undefined) continue;

    // A tautology that sits beside a REAL assertion in the same test (a sibling-
    // branch `throw`, or a co-located type-level assertion) is just a "we reached
    // this branch" marker, not the test's verification — emit nothing.
    if (isReachabilityMarker(assertion.node)) continue;

    // Report at the assertion's outermost call node (drives line/column).
    const pos = getPosition(assertion.node);
    if (pos === undefined) continue; // detached/forgotten node — skip safely.

    // `kind` is always "warn" here (the only tier we emit); an explicit
    // override always wins.
    const severity = options.severityOverride ?? kind;

    const snippet = getLineSnippet(assertion.node);

    const finding: Finding = {
      ruleId: "tautology",
      severity,
      file: ctx.filePath,
      line: pos.line,
      column: pos.column,
      message: `This assertion compares a value to itself via .${assertion.matcher}() and can never fail.`,
      data: { matcher: assertion.matcher },
    };

    // Attach optional keys only when we actually have them (the wire contract
    // says OMIT, not set-to-undefined; also matters under exactOptionalPropertyTypes).
    if (snippet !== undefined) finding.snippet = snippet;
    const testName = nearestTestName(assertion.node);
    if (testName !== undefined) finding.testName = testName;

    findings.push(finding);
  }

  return findings;
}

/**
 * Best-effort title of the nearest enclosing `it(...)` / `test(...)` block, for
 * the `testName` field. Walks up to the first ancestor call whose callee is a
 * test-case identifier and reads its string-literal title. Returns `undefined`
 * when there is no static title (dynamic title, or the assertion lives outside a
 * test block). Never throws.
 *
 * Kept local (rather than re-deriving via `getTestBlocks`) so the detector stays
 * a single linear pass over `getAssertions` without a second whole-file walk.
 */
function nearestTestName(node: Node): string | undefined {
  try {
    let parent: Node | undefined = node.getParent();
    for (let i = 0; parent !== undefined && i < 256; i++) {
      const call = parent.asKind(SyntaxKind.CallExpression);
      if (call) {
        const callee = call.getExpression().asKind(SyntaxKind.Identifier);
        const name = callee?.getText();
        if (name === "it" || name === "test" || name === "fit" || name === "xit") {
          const firstArg = call.getArguments()[0];
          const str =
            firstArg?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue() ??
            firstArg?.asKind(SyntaxKind.NoSubstitutionTemplateLiteral)?.getLiteralValue();
          return str ?? undefined;
        }
      }
      parent = parent.getParent();
    }
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Is the tautology at `node` merely a "we reached this branch" reachability
 * MARKER rather than the test's real verification? True when the enclosing
 * it()/test() body ALSO contains a real assertion the marker is incidental to —
 * specifically a `throw` statement (e.g. the `else { throw }` of a type-guard
 * narrowing test) or a co-located type-level assertion (`Expect<Equal<>>`,
 * `expectTypeOf`, …). In that case `expect(true).toBe(true)` is just marking the
 * taken branch, so flagging it is a false positive. Conservative: a bare
 * `expect(true).toBe(true)` test (no throw, no type assertion) is NOT a marker
 * and stays flagged. Never throws.
 */
function isReachabilityMarker(node: Node): boolean {
  try {
    const body = enclosingTestBody(node);
    if (body === undefined) return false;
    // A `throw` anywhere in the body — typically the opposite branch of the
    // if/else whose taken branch holds the marker.
    if (body.getFirstDescendantByKind(SyntaxKind.ThrowStatement) !== undefined) return true;
    // A co-located compile-time assertion.
    return hasTypeLevelAssertion(body);
  } catch {
    return false;
  }
}

/**
 * The callback body Node of the nearest enclosing it()/test() block, or
 * `undefined`. Mirrors {@link nearestTestName}'s ancestor walk, returning the
 * test function's body (block or expression). Never throws.
 */
function enclosingTestBody(node: Node): Node | undefined {
  try {
    let parent: Node | undefined = node.getParent();
    for (let i = 0; parent !== undefined && i < 256; i++) {
      const call = parent.asKind(SyntaxKind.CallExpression);
      if (call) {
        const callee = call.getExpression().asKind(SyntaxKind.Identifier);
        const name = callee?.getText();
        if (name === "it" || name === "test" || name === "fit" || name === "xit") {
          const fnArg = call.getArguments()[1];
          if (fnArg === undefined) return undefined;
          const arrow = fnArg.asKind(SyntaxKind.ArrowFunction);
          if (arrow) return arrow.getBody();
          const fn = fnArg.asKind(SyntaxKind.FunctionExpression);
          if (fn) return fn.getBody();
          return undefined;
        }
      }
      parent = parent.getParent();
    }
  } catch {
    // fall through
  }
  return undefined;
}

// ----------------------------------------------------------------------------
// Exported detector
// ----------------------------------------------------------------------------

export const detector: Detector = { meta, run };
