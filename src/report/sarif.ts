// ============================================================================
// src/report/sarif.ts
// The SARIF 2.1.0 reporter. Serializes a finished {@link Report} into a Static
// Analysis Results Interchange Format log so testtrust findings surface INLINE
// in GitHub code-scanning / PR annotations (upload via the
// `github/codeql-action/upload-sarif` step).
//
// CONTRACT: pure and deterministic, exactly like {@link renderJson}. Given the
// same Report it ALWAYS returns the byte-identical string — no Date, no IO, no
// randomness, no input mutation. We rebuild every level as a fresh plain object
// with an EXPLICIT, fixed key order so two deeply-equal Reports never serialize
// to different bytes (JSON.stringify emits keys in own-enumeration order, which
// we do not trust). This is a REPORTER, not a detector: it never inspects an
// AST or recomputes a score; it only reshapes what the detectors + scorer
// decided into the SARIF schema.
//
// Spec shape produced:
//   { version:"2.1.0", $schema:<sarif schema url>, runs:[ {
//       tool:{ driver:{ name, informationUri, version, rules:[…] } },
//       results:[…] } ] }
//
//   - runs[0].tool.driver.rules: one reportingDescriptor per DISTINCT ruleId
//     present across the findings — { id, name, shortDescription:{text} } — in
//     first-seen order so the rules array is stable and free of duplicates.
//   - runs[0].results: one result per finding —
//       { ruleId,
//         level: (fail->"error", warn->"warning", info->"note"),
//         message:{ text },
//         locations:[ { physicalLocation:{
//           artifactLocation:{ uri }, region:{ startLine, startColumn? } } } ] }.
//
// exactOptionalPropertyTypes: `startColumn` is OMITTED entirely when a finding
// has no column (rather than emitted as `null`/`undefined`), mirroring how
// json.ts drops absent optional fields.
//
// SARIF 1-based line/column convention matches Finding's 1-based line/column,
// so values pass through unchanged.
// ============================================================================
import type { Finding, Report, RuleId, Severity } from "../types.js";

/** Indentation passed to JSON.stringify: two spaces, matching json.ts. */
const JSON_INDENT = 2;

/** The driver `name` advertised in every SARIF log (the analysis tool id). */
const TOOL_NAME = "testtrust";

/** The driver `informationUri` — where consumers can read about the tool. */
const TOOL_INFORMATION_URI = "https://github.com/corgu1995/testtrust";

/** SARIF 2.1.0 version string, per the spec's required `version` property. */
const SARIF_VERSION = "2.1.0";

/** Canonical `$schema` for SARIF 2.1.0 (the OASIS-published JSON Schema). */
const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";

/**
 * Map a wire-format {@link Severity} to a SARIF result `level`.
 *
 * SARIF levels are a fixed enum; we use the three that line up with our
 * severities: fail -> "error", warn -> "warning", info -> "note". (The other
 * SARIF levels "none"/unset are unused.)
 */
const LEVEL_BY_SEVERITY: Record<Severity, "error" | "warning" | "note"> = {
  fail: "error",
  warn: "warning",
  info: "note",
};

/**
 * Derive a SARIF rule `name` (an opaque, stable identifier shown by some
 * viewers) from a {@link RuleId}. We PascalCase the kebab-case id, e.g.
 * "assertion-free" -> "AssertionFree", so it is deterministic and needs no
 * lookup into the detector registry (keeping this reporter pure + dependency
 * free).
 */
function ruleName(ruleId: RuleId): string {
  return ruleId
    .split("-")
    .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join("");
}

/**
 * Derive the human-readable `shortDescription.text` for a rule from its
 * {@link RuleId}: kebab-case -> Sentence case, e.g. "assertion-free" ->
 * "Assertion free". Findings only carry a `ruleId` (no title), so we synthesize
 * a readable label deterministically rather than depending on DetectorMeta.
 */
function ruleShortDescription(ruleId: RuleId): string {
  const spaced = ruleId.replace(/-/g, " ");
  return spaced.length === 0 ? spaced : spaced[0]!.toUpperCase() + spaced.slice(1);
}

/**
 * Build one SARIF `reportingDescriptor` per DISTINCT ruleId, in first-seen
 * order across `findings`. De-duplication uses a Set so the rules array carries
 * each id exactly once; first-seen ordering keeps output stable and independent
 * of how the findings were assembled.
 */
function buildRules(findings: readonly Finding[]): Array<Record<string, unknown>> {
  const seen = new Set<RuleId>();
  const rules: Array<Record<string, unknown>> = [];
  for (const finding of findings) {
    if (seen.has(finding.ruleId)) continue;
    seen.add(finding.ruleId);
    rules.push({
      id: finding.ruleId,
      name: ruleName(finding.ruleId),
      shortDescription: { text: ruleShortDescription(finding.ruleId) },
    });
  }
  return rules;
}

/**
 * Build the SARIF `region` for a finding with a fixed key order:
 * startLine, then startColumn ONLY when the finding has a column.
 *
 * Under exactOptionalPropertyTypes we never insert a `startColumn` key for an
 * absent column (no `null`, no `undefined`) — the key is simply omitted.
 */
function buildRegion(finding: Finding): Record<string, unknown> {
  const region: Record<string, unknown> = { startLine: finding.line };
  if (finding.column !== undefined) region.startColumn = finding.column;
  return region;
}

/**
 * Build one SARIF `result` from a {@link Finding}, with every nested object in
 * a fixed key order so serialization is deterministic.
 *
 * Shape: { ruleId, level, message:{text}, locations:[{ physicalLocation:{
 * artifactLocation:{uri}, region } }] }. The `file` is passed through verbatim
 * as the artifact `uri` (the analyzer already normalises paths), and `message`
 * is wrapped per SARIF's `{ text }` message object.
 */
function buildResult(finding: Finding): Record<string, unknown> {
  return {
    ruleId: finding.ruleId,
    level: LEVEL_BY_SEVERITY[finding.severity],
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: finding.file },
          region: buildRegion(finding),
        },
      },
    ],
  };
}

/**
 * Render a {@link Report} as a stable, pretty-printed (2-space) SARIF 2.1.0 log.
 *
 * Guarantees:
 *  - Valid SARIF 2.1.0: `version` is "2.1.0", `$schema` is set, exactly one
 *    `runs` entry whose driver name is "testtrust".
 *  - `runs[0].tool.driver.rules` holds one reportingDescriptor per DISTINCT
 *    ruleId present (first-seen order); zero findings -> empty rules + empty
 *    results, still a valid log.
 *  - Deterministic: equal Reports (regardless of how their objects were built)
 *    produce byte-identical output, via explicit fixed key order at every level.
 *  - `region.startColumn` is omitted when a finding has no column
 *    (exactOptionalPropertyTypes-safe), never emitted as `null`.
 *
 * Pure: does not read IO, the clock, or randomness, and never mutates `report`.
 *
 * @param report the finished report from the analyzer.
 * @returns the SARIF log as a pretty-printed JSON string (no trailing newline;
 *          the CLI decides how to write it).
 */
export function renderSarif(report: Report): string {
  const sarifLog = {
    version: SARIF_VERSION,
    $schema: SARIF_SCHEMA,
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            informationUri: TOOL_INFORMATION_URI,
            version: report.version,
            rules: buildRules(report.findings),
          },
        },
        results: report.findings.map(buildResult),
      },
    ],
  };

  return JSON.stringify(sarifLog, null, JSON_INDENT);
}
