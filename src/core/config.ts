// ============================================================================
// src/core/config.ts
// Project-level config-file loader. Lets a repo persist a subset of CLI options
// (fail threshold, format, base ref, per-rule overrides, disabled rules) so the
// same gate runs locally and in CI without re-passing flags every time.
//
// Discovery order (first hit wins, the rest are ignored):
//   1. <cwd>/.testtrustrc.json   (JSON)
//   2. <cwd>/.testtrustrc        (JSON — same parser, no extension)
//   3. <cwd>/package.json        ->  the "testtrust" key
//
// CONTRACT: best-effort and TOTAL. loadConfig() NEVER throws and logs NOTHING —
// a missing file, unreadable file, malformed JSON, or a non-object/garbage
// payload all collapse to {}. Only the known TesttrustConfig shape is coerced;
// unknown keys and wrong-typed values are dropped silently. The result is a
// PARTIAL config: the CLI layers it as `defaults < config < explicit flags`
// (flags win). This module's sole job is LOAD + VALIDATE + RETURN; it performs
// no merging and reads no CLI state. Synchronous on purpose (one-shot at
// startup) using node:fs + node:path.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import type { OutputFormat, RuleConfig, RuleId, Severity } from "../types.js";

/**
 * The persisted, file-backed subset of CliOptions. Every field is optional —
 * absent means "no opinion, fall back to the CLI default / explicit flag".
 * Field names intentionally mirror the user-facing CLI flags (e.g. `failUnder`
 * = `--fail-under`, `baseRef` = `--base`) rather than the internal CliOptions
 * names, so the config file reads the way the command line does.
 */
export interface TesttrustConfig {
  /** Score (0-100) at/under which the verdict is "fail". CLI: --fail-under. */
  failUnder?: number;
  /** Output format. CLI: --format. */
  format?: OutputFormat;
  /** Base git ref to diff against (enables diff mode). CLI: --base. */
  baseRef?: string;
  /** Per-rule enable/severity overrides, keyed by RuleId. CLI: --rule. */
  rules?: Partial<Record<RuleId, RuleConfig>>;
  /** Rules to switch off entirely. CLI: --disable. */
  disable?: RuleId[];
}

// ----------------------------------------------------------------------------
// Known-value tables (kept in lockstep with src/types.ts). Used to reject
// unknown / misspelled enum members instead of trusting the file blindly.
// ----------------------------------------------------------------------------

const RULE_IDS: ReadonlySet<RuleId> = new Set<RuleId>([
  "assertion-free",
  "snapshot-only",
  "tautology",
  "over-mocking-sut",
  "trivial-assertion",
  "focused-test",
  "assertion-weakened",
  "assertion-deleted",
  "test-skipped",
]);

const FORMATS: ReadonlySet<OutputFormat> = new Set<OutputFormat>([
  "human",
  "json",
  "markdown",
]);

const SEVERITIES: ReadonlySet<Severity> = new Set<Severity>([
  "fail",
  "warn",
  "info",
]);

/** Config filenames probed in <cwd>, in precedence order, before package.json. */
const RC_FILENAMES: readonly string[] = [".testtrustrc.json", ".testtrustrc"];

// ----------------------------------------------------------------------------
// Small typed guards. Each accepts `unknown` and narrows, so a hand-edited file
// with the wrong type for a field drops just that field (never throws).
// ----------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isRuleId(v: unknown): v is RuleId {
  return typeof v === "string" && RULE_IDS.has(v as RuleId);
}

function isOutputFormat(v: unknown): v is OutputFormat {
  return typeof v === "string" && FORMATS.has(v as OutputFormat);
}

function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && SEVERITIES.has(v as Severity);
}

/**
 * `failUnder` must be a real, finite integer in [0, 100] — the same bound the
 * CLI enforces on --fail-under. Non-numbers, NaN, fractions, and out-of-range
 * values are rejected (field dropped). Booleans are excluded explicitly because
 * `typeof true === "boolean"` already fails the number check — but we keep the
 * guard strict for clarity.
 */
function coerceFailUnder(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isInteger(v)) return undefined;
  if (v < 0 || v > 100) return undefined;
  return v;
}

/**
 * Coerce one entry of the `rules` map. A valid RuleConfig is `{ enabled:
 * boolean, severity?: Severity }`. We require `enabled` to be a real boolean
 * (matching the frozen RuleConfig contract) and only carry `severity` when it
 * names a known Severity. Anything else yields undefined → that rule is skipped.
 */
function coerceRuleConfig(v: unknown): RuleConfig | undefined {
  if (!isPlainObject(v)) return undefined;
  if (typeof v.enabled !== "boolean") return undefined;
  // exactOptionalPropertyTypes: only attach `severity` when actually present.
  if (isSeverity(v.severity)) {
    return { enabled: v.enabled, severity: v.severity };
  }
  return { enabled: v.enabled };
}

/** Coerce the whole `rules` object, dropping unknown rule ids and bad entries. */
function coerceRules(v: unknown): Partial<Record<RuleId, RuleConfig>> | undefined {
  if (!isPlainObject(v)) return undefined;
  const out: Partial<Record<RuleId, RuleConfig>> = {};
  let any = false;
  for (const [key, raw] of Object.entries(v)) {
    if (!isRuleId(key)) continue; // ignore unknown / misspelled rule names
    const cfg = coerceRuleConfig(raw);
    if (cfg === undefined) continue;
    out[key] = cfg;
    any = true;
  }
  return any ? out : undefined;
}

/** Coerce `disable` to a deduped array of known RuleIds (drops bad entries). */
function coerceDisable(v: unknown): RuleId[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<RuleId>();
  for (const item of v) {
    if (isRuleId(item)) seen.add(item);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/**
 * Project an arbitrary parsed JSON value onto the TesttrustConfig shape. Returns
 * a fresh object containing only the recognized, well-typed fields. A
 * non-object input (array, string, number, null) yields {}.
 *
 * exactOptionalPropertyTypes is on, so each optional field is assigned only when
 * it actually validated — we never write `failUnder: undefined`.
 */
function normalizeConfig(raw: unknown): TesttrustConfig {
  if (!isPlainObject(raw)) return {};
  const out: TesttrustConfig = {};

  const failUnder = coerceFailUnder(raw.failUnder);
  if (failUnder !== undefined) out.failUnder = failUnder;

  if (isOutputFormat(raw.format)) out.format = raw.format;

  if (typeof raw.baseRef === "string" && raw.baseRef.length > 0) {
    out.baseRef = raw.baseRef;
  }

  const rules = coerceRules(raw.rules);
  if (rules !== undefined) out.rules = rules;

  const disable = coerceDisable(raw.disable);
  if (disable !== undefined) out.disable = disable;

  return out;
}

/**
 * Read + JSON.parse a file, returning the parsed value or undefined on ANY
 * failure (missing file, permission error, directory, invalid JSON). This is
 * the single choke point for the no-throw guarantee: every fs/JSON error is
 * swallowed here.
 */
function readJsonFile(filePath: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined; // ENOENT, EISDIR, EACCES, ...
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined; // malformed JSON
  }
}

/**
 * Load the project's testtrust config from `cwd`.
 *
 * Resolution: `.testtrustrc.json`, then `.testtrustrc`, then the `"testtrust"`
 * key of `package.json` — the FIRST file that EXISTS wins, even if it is empty
 * or invalid (in which case the result is {}); we do not fall through from a
 * present-but-broken rc file to package.json. Always returns a (possibly empty)
 * partial config and never throws.
 */
export function loadConfig(cwd: string): TesttrustConfig {
  const root = path.resolve(cwd);

  for (const name of RC_FILENAMES) {
    const candidate = path.join(root, name);
    if (!fs.existsSync(candidate)) continue;
    // File exists: its parse result is authoritative — a broken rc still
    // resolves to {} rather than silently falling back to package.json.
    return normalizeConfig(readJsonFile(candidate));
  }

  // No rc file — look for a "testtrust" key inside package.json.
  const pkgPath = path.join(root, "package.json");
  const pkg = readJsonFile(pkgPath);
  if (isPlainObject(pkg) && "testtrust" in pkg) {
    return normalizeConfig(pkg.testtrust);
  }

  return {};
}
