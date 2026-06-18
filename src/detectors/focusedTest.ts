// ============================================================================
// src/detectors/focusedTest.ts
//
// The "focused-test" smell (warn).
//
// A *focused* test pins the runner to a subset of the suite: `it.only(...)`,
// `test.only(...)`, `describe.only(...)` (and the `fit` / `fdescribe` aliases)
// tell Jest/Vitest to run ONLY the focused block(s) and silently skip every
// other test in the file. This is a debugging convenience that is catastrophic
// when committed: CI reports green while the vast majority of the suite never
// executed. A single stray `.only` can hide a wall of real failures.
//
// What we flag (one finding per focused block): every {@link TestBlock} whose
// `modifiers.only === true`. That single boolean — computed by the shared
// `getTestBlocks` helper — already unifies every spelling of focus:
//   * leaf focus:  it.only(...) / test.only(...) / fit(...)
//   * suite focus: describe.only(...) / fdescribe(...)
// so we do not have to re-recognise aliases or member chains here.
//
// PRECISION: trivially perfect. `modifiers.only` is unambiguous — there is no
// heuristic and no false-positive class to guard against. We simply locate the
// block's `call` node (via `getPosition`) and emit. If, defensively, we cannot
// resolve a position we stay silent rather than guess a line.
//
// Severity (warn by default): a committed `.only` is high-signal and very likely
// a mistake, but it is the scorer — not this detector — that decides the gate
// verdict, so we emit "warn" (or the caller's severityOverride) and let the
// scorer weigh it.
//
// This module is a Detector: pure, synchronous, no IO, no AST mutation, no
// reading of other files. It walks ONLY the HEAD ast via the shared helpers.
// ============================================================================

import type {
  Detector,
  DetectorMeta,
  DetectorRunOptions,
  Finding,
  TestFileContext,
} from "../types.js";

import { getLineSnippet, getPosition, getTestBlocks } from "./shared.js";
import type { TestBlock } from "./shared.js";

const meta: DetectorMeta = {
  id: "focused-test",
  title: "Focused test",
  description:
    "A focused test (it.only/fit/describe.only) silently skips the rest of the suite in CI.",
  defaultSeverity: "warn",
  requiresBase: false,
};

function run(ctx: TestFileContext, options: DetectorRunOptions): Finding[] {
  const findings: Finding[] = [];
  const severity = options.severityOverride ?? meta.defaultSeverity;

  for (const block of getTestBlocks(ctx.sourceFile)) {
    // The ONLY condition for this rule. `getTestBlocks` already folds every
    // focus spelling (it.only / test.only / fit / describe.only / fdescribe)
    // into this one boolean, so a single check covers leaf and suite focus.
    if (!block.modifiers.only) continue;

    // Report at the test/suite call itself so the caret lands on the `it.only`
    // / `describe.only` invocation.
    const position = getPosition(block.call);
    if (position === undefined) continue; // can't locate it -> stay silent.

    const construct = describeConstruct(block);

    const finding: Finding = {
      ruleId: "focused-test",
      severity,
      file: ctx.filePath,
      line: position.line,
      message: buildMessage(construct, block),
    };

    if (position.column !== undefined) finding.column = position.column;

    const snippet = getLineSnippet(block.call);
    if (snippet !== undefined && snippet.length > 0) finding.snippet = snippet;

    const testName = testNameOf(block);
    if (testName !== undefined) finding.testName = testName;

    findings.push(finding);
  }

  return findings;
}

/**
 * Human-facing name of the focusing construct, e.g. `describe.only` / `it.only`
 * / `test.only`. We report the canonical `.only` spelling regardless of whether
 * the author wrote the member form (`it.only`) or an alias (`fit`/`fdescribe`),
 * because that is the construct the reader must remove.
 */
function describeConstruct(block: TestBlock): string {
  return `${block.kind}.only`;
}

/**
 * Resolve the `testName` from a block's title path, when available. Mirrors the
 * convention used by the other detectors: prefer the full describe>it path
 * (joining real segments with " > "), falling back to the bare title. Only emit
 * a name when at least one real (non-placeholder) segment exists.
 */
function testNameOf(block: TestBlock): string | undefined {
  const path = block.titlePath.filter((seg) => seg !== "<dynamic>");
  if (path.length > 0) return path.join(" > ");
  return block.title;
}

/**
 * One clear sentence naming the construct and warning that the rest of the file
 * will not run in CI. Includes the block title when we have one so the author
 * can find the offending block quickly.
 */
function buildMessage(construct: string, block: TestBlock): string {
  const named = block.title !== undefined ? ` ("${block.title}")` : "";
  return `Focused test \`${construct}\`${named} skips every non-focused test in this file; the rest of the suite will not run in CI.`;
}

export const detector: Detector = { meta, run };
