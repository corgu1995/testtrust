// ============================================================================
// src/detectors/regression/assertionStrength.ts
//
// THE WEDGE — testtrust's reason to exist.
//
// A single detector (meta.id = "assertion-weakened") that emits THREE distinct
// regression ruleIds by comparing the BASE (pre-change) version of a test file
// against its HEAD (post-change) version:
//
//   • "test-skipped"       — a test that USED to run is now skipped/todo'd.
//   • "assertion-deleted"  — a test that USED to assert now asserts nothing
//                            (including the "commented-out assertion" case,
//                            since a comment is simply gone from the AST).
//   • "assertion-weakened" — a surviving assertion swapped a strong matcher for
//                            a strictly weaker one (e.g. toEqual -> toBeTruthy).
//
// requiresBase = TRUE: with no base ref there is nothing to regress against, so
// the detector emits NOTHING (ACs 6 & 7).
//
// PRECISION IS PARAMOUNT — this gates CI. A false positive mutes the whole tool.
// Every pairing is therefore as strict as possible:
//   - tests pair ONLY on an exact title-path match (join with ">");
//   - any test whose title path contains the dynamic placeholder is skipped
//     (we cannot pair it safely);
//   - a head test with no base counterpart by title emits NOTHING (this folds
//     in renames — AC5 — and brand-new tests);
//   - assertions pair ONLY on identical normalized subject text, and when a
//     subject carries several assertions we pair positionally (in source order)
//     ONLY if base and head have the SAME count for it — a differing count is
//     ambiguous and emits nothing for that subject;
//   - unknown matchers never flag (weakeningSeverity returns undefined);
//   - a brand-new subject/assertion in head is never a weakening;
//   - and even a GENUINE downgrade only escalates to "warn" when it collapses
//     into the vacuous/existence band (toEqual -> toBeDefined); a milder
//     loosening (toBe -> toContain, toEqual -> toHaveProperty) is "info" only,
//     so a legitimate intentional refactor can never alone mute the gate.
// ============================================================================

import type { CallExpression, Node } from "ts-morph";
import type {
  Detector,
  DetectorMeta,
  DetectorRunOptions,
  Finding,
  Severity,
  TestFileContext,
} from "../../types.js";
import {
  getAssertions,
  getLineSnippet,
  getPosition,
  getTestBlocks,
  hasRealAssertion,
  type Assertion,
  type TestBlock,
} from "../shared.js";
import { weakeningSeverity } from "./strengthRank.js";

// ----------------------------------------------------------------------------
// Meta
// ----------------------------------------------------------------------------

const meta: DetectorMeta = {
  id: "assertion-weakened",
  title: "Assertion weakened",
  description:
    "Flags tests whose assertions were weakened, deleted, or skipped versus the base ref.",
  defaultSeverity: "warn",
  requiresBase: true,
};

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

/** Placeholder that {@link getTestBlocks} stamps into a title path when a title
 *  is dynamic. A path containing it cannot be paired safely. */
const DYNAMIC_TITLE = "<dynamic>";

/** Stable key for pairing a head test to a base test: the full title path. */
function pathKey(block: TestBlock): string {
  return block.titlePath.join(">");
}

/** A leaf test case (it/test) with a fully-static title path — the only blocks
 *  we ever pair. Suites (describe) and dynamic-titled blocks are excluded. */
function isPairableLeaf(block: TestBlock): boolean {
  return !block.isSuite && !block.titlePath.includes(DYNAMIC_TITLE);
}

/**
 * Index leaf test blocks by their title-path key. If two leaves share a key
 * (duplicate title path) we keep the FIRST and treat the key as ambiguous by
 * removing it, because a non-unique pairing can't be trusted — precision first.
 */
function indexLeavesByPath(blocks: readonly TestBlock[]): Map<string, TestBlock> {
  const byPath = new Map<string, TestBlock>();
  const ambiguous = new Set<string>();
  for (const block of blocks) {
    if (!isPairableLeaf(block)) continue;
    const key = pathKey(block);
    if (byPath.has(key)) {
      ambiguous.add(key);
      continue;
    }
    byPath.set(key, block);
  }
  for (const key of ambiguous) byPath.delete(key);
  return byPath;
}

/**
 * "Effective skip": is this leaf — or any of its enclosing describe ancestors —
 * marked `.skip` or `.todo` (covers it.skip / xit / describe.skip / test.todo)?
 *
 * We resolve ancestry STRUCTURALLY by walking the AST parent chain of the
 * block's own call, OR-ing in the modifiers of every enclosing test/suite call
 * we recognise (looked up in `byCall`). This is more reliable than matching on
 * the textual title-path prefix, and it correctly handles repeated titles.
 */
function isEffectivelySkipped(block: TestBlock, byCall: ReadonlyMap<CallExpression, TestBlock>): boolean {
  if (block.modifiers.skip || block.modifiers.todo) return true;
  try {
    let parent: Node | undefined = block.call.getParent();
    for (let i = 0; parent !== undefined && i < 256; i++) {
      const enclosing = byCall.get(parent as CallExpression);
      if (enclosing && (enclosing.modifiers.skip || enclosing.modifiers.todo)) {
        return true;
      }
      parent = parent.getParent();
    }
  } catch {
    // On any traversal surprise, fall back to the block's own modifiers only.
  }
  return false;
}

/** Map every block's underlying call node to the block, for ancestor lookup. */
function indexByCall(blocks: readonly TestBlock[]): Map<CallExpression, TestBlock> {
  const byCall = new Map<CallExpression, TestBlock>();
  for (const block of blocks) byCall.set(block.call, block);
  return byCall;
}

/** Normalize a subject's source text for pairing: trim + collapse whitespace so
 *  trivial reformatting doesn't break the match. Returns `undefined` when the
 *  subject text can't be read. */
function subjectText(assertion: Assertion): string | undefined {
  const node = assertion.subjectArgs[0];
  if (node === undefined) return undefined;
  try {
    const raw = node.getText();
    const normalized = raw.replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The matcher string to feed to {@link isWeakening}. The shared {@link Assertion}
 * already carries a BARE matcher name; for the context-sensitive `toThrow`
 * family we must hand the rank model the *call form* so it can tell a precise
 * `toThrow(expected)` (tier 3) from a vacuous bare `toThrow()` (tier 0):
 *   - matcherArgs non-empty -> "toThrow(x)"
 *   - matcherArgs empty     -> "toThrow()"
 * Every other matcher is passed through bare.
 */
function matcherForRank(assertion: Assertion): string | undefined {
  const name = assertion.matcher;
  if (name === undefined) return undefined;
  if (name === "toThrow" || name === "toThrowError") {
    return assertion.matcherArgs.length > 0 ? `${name}(x)` : `${name}()`;
  }
  return name;
}

/**
 * Bucket a test body's assertions into ORDERED lists keyed by normalized subject
 * text, preserving source order within each bucket ({@link getAssertions} yields
 * assertions in source order, and we append in that order).
 *
 * We deliberately do NOT collapse or drop duplicate-subject keys here. Two (or
 * more) assertions on the same subject are extremely common — e.g.
 *   expect(result).toEqual({ ... });
 *   expect(result).toBeDefined();
 * — and the caller pairs base/head buckets POSITIONALLY only when their lengths
 * match (see {@link run}), which lets a weakening of just ONE of several
 * same-subject assertions still be caught. When the counts differ the caller
 * treats the subject as ambiguous and emits nothing, so precision is preserved.
 */
function indexAssertionsBySubject(body: Node | undefined): Map<string, Assertion[]> {
  const bySubject = new Map<string, Assertion[]>();
  for (const assertion of getAssertions(body)) {
    const subject = subjectText(assertion);
    if (subject === undefined) continue;
    const bucket = bySubject.get(subject);
    if (bucket === undefined) {
      bySubject.set(subject, [assertion]);
    } else {
      bucket.push(assertion);
    }
  }
  return bySubject;
}

// ----------------------------------------------------------------------------
// run
// ----------------------------------------------------------------------------

function run(ctx: TestFileContext, options: DetectorRunOptions): Finding[] {
  // AC6 & AC7: no base ref => no regression to measure => emit nothing.
  if (ctx.baseSourceFile === undefined) return [];

  const headBlocks = getTestBlocks(ctx.sourceFile);
  const baseBlocks = getTestBlocks(ctx.baseSourceFile);
  if (headBlocks.length === 0 || baseBlocks.length === 0) return [];

  const baseByPath = indexLeavesByPath(baseBlocks);
  const headByCall = indexByCall(headBlocks);
  const baseByCall = indexByCall(baseBlocks);

  const severity: Severity = options.severityOverride ?? meta.defaultSeverity;
  const findings: Finding[] = [];

  for (const head of headBlocks) {
    if (!isPairableLeaf(head)) continue;

    const key = pathKey(head);
    const base = baseByPath.get(key);
    // No base counterpart by exact title => new test or rename (AC5): emit nothing.
    if (base === undefined) continue;

    const testName = head.titlePath.join(" > ");

    // --- "test-skipped" -----------------------------------------------------
    // Base ran, head is now effectively skipped. Emit and CONTINUE (a skipped
    // test should not also be judged for deleted/weakened assertions).
    const baseSkipped = isEffectivelySkipped(base, baseByCall);
    const headSkipped = isEffectivelySkipped(head, headByCall);
    if (!baseSkipped && headSkipped) {
      const finding = makeFinding({
        ruleId: "test-skipped",
        severity,
        file: ctx.filePath,
        node: head.call,
        message: `Test "${testName}" was running on the base ref but is now skipped, so it no longer guards anything.`,
        testName,
      });
      if (finding) findings.push(finding);
      continue;
    }
    // If head is skipped for any reason, do not run value-based comparisons.
    if (headSkipped) continue;

    // --- "assertion-deleted" ------------------------------------------------
    // Base asserted something real; head asserts nothing at all. A commented-out
    // assertion is gone from the AST, so AC4 folds in here too.
    const baseHadAssertion = hasRealAssertion(base.body);
    const headHasAssertion = hasRealAssertion(head.body);
    if (baseHadAssertion && !headHasAssertion) {
      const finding = makeFinding({
        ruleId: "assertion-deleted",
        severity,
        file: ctx.filePath,
        node: head.call,
        message: `Test "${testName}" asserted something on the base ref but now has no assertions (removed or commented out).`,
        testName,
      });
      if (finding) findings.push(finding);
      continue;
    }

    // --- "assertion-weakened" ----------------------------------------------
    // Pair surviving assertions by normalized subject text; flag a strict
    // cross-tier downgrade. Only subjects present on BOTH sides are considered.
    //
    // Both sides are bucketed into ORDERED lists per subject. For each subject
    // we pair POSITIONALLY (base[i] <-> head[i]) only when the two lists have
    // EQUAL length — that is the one regime in which positional correspondence
    // is unambiguous, and it covers the common "two assertions on the same
    // subject, one of them weakened" gaming move. When the counts DIFFER we
    // refuse to cross-pair and emit nothing for that subject (precision first).
    const baseAssertions = indexAssertionsBySubject(base.body);
    if (baseAssertions.size === 0) continue;
    const headAssertions = indexAssertionsBySubject(head.body);

    for (const [subject, baseBucket] of baseAssertions) {
      const headBucket = headAssertions.get(subject);
      // Subject gone from head, or a differing number of same-subject
      // assertions => ambiguous pairing => emit nothing for this subject.
      if (headBucket === undefined || headBucket.length !== baseBucket.length) continue;

      for (let i = 0; i < baseBucket.length; i++) {
        const baseAssertion = baseBucket[i];
        const headAssertion = headBucket[i];
        if (baseAssertion === undefined || headAssertion === undefined) continue;

        const finding = gradeAssertionPair({
          subject,
          testName,
          filePath: ctx.filePath,
          baseAssertion,
          headAssertion,
          severityOverride: options.severityOverride,
        });
        if (finding) findings.push(finding);
      }
    }
  }

  return findings;
}

/** Inputs for grading one positionally-paired base/head assertion. */
interface GradePairSpec {
  subject: string;
  testName: string;
  filePath: string;
  baseAssertion: Assertion;
  headAssertion: Assertion;
  severityOverride: Severity | undefined;
}

/**
 * Grade a single (base, head) assertion pair on the same subject and, if it is a
 * genuine weakening, build the `assertion-weakened` finding. Returns `undefined`
 * when the transition is not a weakening (unknown matcher on either side, or a
 * same-tier swap / strengthening) or the head node has no resolvable position.
 *
 * The grading itself is unchanged from before the bucketing rework:
 *   - "warn": the canonical gaming collapse into the vacuous/existence band
 *     (e.g. toEqual -> toBeTruthy) — the wedge's reason to exist.
 *   - "info": a real but commonly-legitimate loosening (e.g. toBe -> toContain,
 *     toEqual -> toHaveProperty) — advisory only, so a single intentional
 *     refactor can never mute the gate.
 */
function gradeAssertionPair(spec: GradePairSpec): Finding | undefined {
  const { subject, testName, filePath, baseAssertion, headAssertion, severityOverride } = spec;

  const baseMatcher = matcherForRank(baseAssertion);
  const headMatcher = matcherForRank(headAssertion);
  if (baseMatcher === undefined || headMatcher === undefined) return undefined;

  const graded = weakeningSeverity(
    baseMatcher,
    headMatcher,
    baseAssertion.negated,
    headAssertion.negated,
  );
  if (graded === undefined) return undefined;

  // Honor an explicit per-rule severity override; otherwise use the graded
  // severity so legitimate loosenings stay "info" and never fail CI alone.
  const weakenedSeverity: Severity = severityOverride ?? graded;

  return makeFinding({
    ruleId: "assertion-weakened",
    severity: weakenedSeverity,
    file: filePath,
    node: headAssertion.node,
    message: `Assertion on "${subject}" in test "${testName}" was weakened from \`${baseMatcher}\` to \`${headMatcher}\`, so it now catches fewer bugs.`,
    testName,
    data: {
      baseMatcher: baseAssertion.matcher,
      headMatcher: headAssertion.matcher,
      subject,
    },
  });
}

// ----------------------------------------------------------------------------
// Finding construction (omits unknown optional keys per exactOptionalPropertyTypes)
// ----------------------------------------------------------------------------

interface FindingSpec {
  ruleId: Finding["ruleId"];
  severity: Severity;
  file: string;
  node: Node;
  message: string;
  testName: string;
  data?: Record<string, unknown>;
}

/**
 * Build a {@link Finding}, deriving line/column/snippet from `node`. Returns
 * `undefined` if the node has no resolvable position (a forgotten/detached
 * node) — we'd rather drop the finding than emit one with a bogus line.
 */
function makeFinding(spec: FindingSpec): Finding | undefined {
  const pos = getPosition(spec.node);
  if (pos === undefined) return undefined;

  const finding: Finding = {
    ruleId: spec.ruleId,
    severity: spec.severity,
    file: spec.file,
    line: pos.line,
    column: pos.column,
    message: spec.message,
    testName: spec.testName,
  };

  const snippet = getLineSnippet(spec.node);
  if (snippet !== undefined) finding.snippet = snippet;
  if (spec.data !== undefined) finding.data = spec.data;

  return finding;
}

// ----------------------------------------------------------------------------
// Export
// ----------------------------------------------------------------------------

export const detector: Detector = { meta, run };
