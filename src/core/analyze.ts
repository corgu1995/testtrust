import path from "node:path";
import { glob } from "tinyglobby";
import type { CliOptions, DetectorRunOptions, Finding, Report, RuleId, Severity } from "../types.js";
import { createProject, buildContexts, type BuildContextInput } from "./ast.js";
import { ALL_DETECTORS, DETECTOR_RULE_IDS } from "./registry.js";
import { score } from "./scorer.js";
import { resolveBase, listChangedTestFiles, readBaseBlob } from "../git/diff.js";
import { getVersion } from "../util/version.js";
import { buildSuppressions, type SuppressionIndex } from "./suppress.js";
import { loadBaseline, isBaselined } from "./baseline.js";

/** Thrown when a files-mode scan resolves to zero files (likely a misconfigured
 *  path/glob). The CLI maps this to a usage error rather than a vacuous pass. */
export class EmptyScanError extends Error {}

/** A rule is enabled unless explicitly disabled in CliOptions.rules. */
function isRuleEnabled(options: CliOptions, ruleId: RuleId): boolean {
  return options.rules[ruleId]?.enabled !== false;
}

/** Present findings with cwd-relative, forward-slash paths (stable across OSes). */
function toDisplayPath(cwd: string, file: string): string {
  const rel = path.isAbsolute(file) ? path.relative(cwd, file) : file;
  const norm = rel.split(path.sep).join("/");
  return norm === "" ? "." : norm;
}

/**
 * Orchestrator. Resolves inputs (explicit files OR a git diff), loads each test
 * file (plus its base-branch version in diff mode), runs the enabled detectors,
 * applies per-rule severity overrides, scores, and assembles the Report.
 */
export async function analyze(options: CliOptions): Promise<Report> {
  const cwd = path.resolve(options.cwd);
  const inputs: BuildContextInput[] = [];
  let baseRef: string | null = null;

  if (options.mode === "diff") {
    const base = await resolveBase(options.baseRef, cwd);
    baseRef = options.baseRef;
    const changed = await listChangedTestFiles(base, cwd);
    const filterSet =
      options.files.length > 0
        ? new Set(options.files.map((f) => path.resolve(cwd, f)))
        : null;
    for (const c of changed) {
      const abs = path.resolve(cwd, c.path);
      if (filterSet && !filterSet.has(abs)) continue;
      const baseText = await readBaseBlob(base, c.path, cwd);
      inputs.push(
        baseText === null
          ? { filePath: abs, isChanged: true }
          : { filePath: abs, baseText, isChanged: true },
      );
    }
  } else if (options.files.length > 0) {
    const matches = await glob(options.files, { cwd, absolute: true, dot: false });
    for (const m of matches) inputs.push({ filePath: m, isChanged: false });
  }

  if (options.mode === "files" && inputs.length === 0) {
    throw new EmptyScanError(
      "no test files matched — check the file paths/globs you passed.",
    );
  }

  const project = createProject();
  const contexts = buildContexts(project, inputs);
  const hasAnyBase = contexts.some((c) => c.baseSourceFile !== undefined);

  // Per-file inline-suppression indexes (`// testtrust-disable-next-line ...`).
  const suppressions = new Map<string, SuppressionIndex>();
  for (const ctx of contexts) {
    suppressions.set(ctx.filePath, buildSuppressions(ctx.getText()));
  }

  // Run detectors (one responsibility each); skip disabled rules and base-requiring
  // detectors when there is no base to compare against.
  const collected: Finding[] = [];
  for (const detector of ALL_DETECTORS) {
    const ruleIds = DETECTOR_RULE_IDS.get(detector) ?? [detector.meta.id];
    if (!ruleIds.some((r) => isRuleEnabled(options, r))) continue;
    if (detector.meta.requiresBase && (options.mode !== "diff" || !hasAnyBase)) continue;
    // Honor the Detector contract: pass the resolved severity override for
    // single-rule detectors. The multi-rule regression detector keeps its
    // per-rule overrides applied centrally below.
    let runOpts: DetectorRunOptions = {};
    if (ruleIds.length === 1) {
      const only = ruleIds[0];
      const sev = only ? options.rules[only]?.severity : undefined;
      if (sev) runOpts = { severityOverride: sev };
    }
    for (const ctx of contexts) {
      for (const finding of detector.run(ctx, runOpts)) collected.push(finding);
    }
  }

  // Drop findings for disabled sub-rules; apply per-rule severity overrides; relativize paths.
  const findings: Finding[] = [];
  for (const f of collected) {
    if (!isRuleEnabled(options, f.ruleId)) continue;
    if (suppressions.get(f.file)?.isSuppressed(f.line, f.ruleId)) continue;
    const sevOverride: Severity | undefined = options.rules[f.ruleId]?.severity;
    const finding: Finding = { ...f, file: toDisplayPath(cwd, f.file) };
    if (sevOverride) finding.severity = sevOverride;
    findings.push(finding);
  }
  findings.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  );

  // Baseline: grandfather pre-existing findings — gate (and report) only NEW ones.
  let gated = findings;
  if (options.baselinePath) {
    const baseline = loadBaseline(options.baselinePath);
    if (baseline) gated = findings.filter((f) => !isBaselined(f, baseline));
  }

  const scoreResult = score({
    findings: gated,
    filesAnalyzed: contexts.length,
    failThreshold: options.failThreshold,
  });

  return {
    version: getVersion(),
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    baseRef,
    filesAnalyzed: contexts.length,
    score: scoreResult,
    findings: gated,
  };
}
