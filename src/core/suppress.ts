// ============================================================================
// src/core/suppress.ts
// Inline suppression parser. Lets test authors silence specific findings with
// source comments — same ergonomics as eslint-disable — so a deliberate,
// reviewed exception doesn't keep tripping the gate.
//
// Supported directives (// line-comment or /* block-comment */ form):
//   testtrust-disable-next-line                 -> ALL rules on the NEXT line
//   testtrust-disable-next-line rule-a, rule-b  -> only those rules, next line
//   testtrust-disable-line                      -> ALL rules on the SAME line
//   testtrust-disable-line rule-a               -> only that rule, same line
//
// CONTRACT: pure, no IO, no AST. Given the file's source text it returns an
// index that answers isSuppressed(line, ruleId) in O(1). Unknown rule names are
// recorded verbatim (never throws); a directive on the last line with no source
// line after it is a harmless no-op. Lines are 1-based to match Finding.line.
// ============================================================================
import type { RuleId } from "../types.js";

/**
 * Per-target-line suppression: either every rule ("all") or an explicit set of
 * RuleIds. We collapse to "all" the moment any unscoped directive targets a line
 * so a later scoped directive can't accidentally narrow it.
 */
type LineSuppression = "all" | Set<RuleId>;

/** Queryable result of parsing a source file's suppression directives. */
export interface SuppressionIndex {
  /** True when a finding at this 1-based line for this rule is suppressed. */
  isSuppressed(line: number, ruleId: RuleId): boolean;
}

/**
 * Matches a suppression directive anywhere on a line, in either comment form.
 *
 *   group 1: the kind — "next-line" | "line"
 *   group 2: everything after the directive up to end-of-line or the closing
 *            `*​/` of a block comment — the raw rule-list tail. We capture
 *            loosely here and let `parseRuleList` extract only the rule tokens,
 *            so trailing prose (e.g. `// testtrust-disable-line  <- why`) can't
 *            masquerade as rule names.
 *
 * Deliberately tolerant: the directive need not be alone on its line.
 */
const DIRECTIVE_RE =
  /(?:\/\/|\/\*)\s*testtrust-disable-(next-line|line)\b([^\n]*?)(?:\*\/|$)/;

/**
 * Shape of a RuleId token: lowercase kebab-case (matches every value in the
 * RuleId union, e.g. "assertion-weakened"). We use this to tell a (possibly
 * unknown) rule name apart from trailing prose like "<-" or "TARGET".
 */
const RULE_TOKEN_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Parse a rule list like "rule-a, rule-b   rule-c" into RuleIds. Separators are
 * any mix of commas and whitespace. An empty / whitespace-only tail yields an
 * empty array, which the caller treats as "all rules".
 *
 * Tokens are taken only while they are SHAPED like a RuleId (lowercase
 * kebab-case). The first token that isn't — e.g. the "<-" / "why" of a trailing
 * note after a `//` directive — ends the list and the remainder is ignored.
 * This is intentionally lenient about *which* rule names appear: an unknown but
 * validly-shaped name (e.g. "not-a-real-rule") is still recorded — it simply
 * never matches a real finding, which is the desired no-throw behavior.
 */
export function parseRuleList(raw: string): RuleId[] {
  const out: RuleId[] = [];
  for (const tok of raw.split(/[\s,]+/)) {
    if (tok.length === 0) continue; // leading/trailing separator
    if (!RULE_TOKEN_RE.test(tok)) break; // start of trailing prose — stop
    out.push(tok as RuleId);
  }
  return out;
}

/**
 * Record a suppression for `targetLine`. Passing an empty `rules` array (an
 * unscoped directive) marks the line as "all"; otherwise the named rules are
 * unioned into the line's set (unless it's already "all").
 */
function addSuppression(
  map: Map<number, LineSuppression>,
  targetLine: number,
  rules: RuleId[],
): void {
  if (rules.length === 0) {
    map.set(targetLine, "all");
    return;
  }
  const existing = map.get(targetLine);
  if (existing === "all") return; // already broadest possible
  const set = existing ?? new Set<RuleId>();
  for (const r of rules) set.add(r);
  map.set(targetLine, set);
}

/**
 * Scan `sourceText` line by line, collect every suppression directive, and
 * return a SuppressionIndex. Splitting on "\n" keeps 1-based line numbers in
 * lockstep with editors and with Finding.line regardless of CRLF (a trailing
 * "\r" lives harmlessly at end-of-line and never affects the directive match).
 */
export function buildSuppressions(sourceText: string): SuppressionIndex {
  const byLine = new Map<number, LineSuppression>();
  const lines = sourceText.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? "";
    const match = DIRECTIVE_RE.exec(text);
    if (!match) continue;

    const kind = match[1]; // "next-line" | "line"
    const rules = parseRuleList(match[2] ?? "");
    const commentLine = i + 1; // 1-based line the comment sits on

    if (kind === "next-line") {
      const targetLine = commentLine + 1;
      // A directive on the final line targets a line that doesn't exist — no-op.
      if (targetLine > lines.length) continue;
      addSuppression(byLine, targetLine, rules);
    } else {
      addSuppression(byLine, commentLine, rules);
    }
  }

  return {
    isSuppressed(line: number, ruleId: RuleId): boolean {
      const entry = byLine.get(line);
      if (entry === undefined) return false;
      if (entry === "all") return true;
      return entry.has(ruleId);
    },
  };
}
