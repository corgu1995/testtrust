// ============================================================================
// src/report/markdown.ts
//
// The MARKDOWN reporter. Turns a finished {@link Report} into a compact block
// of GitHub-Flavoured Markdown designed to live as a *sticky PR comment*: a CI
// step posts it once and rewrites the same comment on every push.
//
// CONTRACT: this module is PURE. `renderMarkdown` takes a Report and returns a
// string. It performs NO IO — no stdout, no fs, no process.*, no clock, no
// randomness — and never mutates its input. Like {@link renderHuman} and
// {@link renderJson} it is a REPORTER, not a detector: it never inspects an AST
// or recomputes a score; it only formats what the scorer + detectors decided.
//
// Output shape (findings present):
//
//   <!-- testtrust-report -->
//   ## 🧪 testtrust — 72/100 · NEUTRAL
//   Analyzed 3 files · 5 findings (1 fail · 3 warn · 1 info)
//
//   <details><summary>5 findings</summary>
//
//   | Rule | Location | Message |
//   | --- | --- | --- |
//   | `assertion-free` | `src/a.test.ts:12` | Test "x" has no assertions. |
//   | … | … | … |
//
//   </details>
//
//   <sub>Powered by [testtrust](…) · suppress a line with `// testtrust-disable-next-line <rule>`</sub>
//
// Three properties are load-bearing for the CI sticky-comment step and are
// pinned by the tests:
//   1. The FIRST line is the exact marker `<!-- testtrust-report -->` so the CI
//      step can find + update the existing comment instead of posting a new one.
//   2. The findings table is CAPPED at {@link MAX_ROWS} rows; when there are
//      more, a trailing "…and K more" line keeps a huge PR from producing a
//      giant comment.
//   3. Cell content is escaped (`|` and newlines) so one gnarly message can't
//      break the Markdown table layout.
//
// Findings are sorted by file (ascending) then line (ascending) so the comment
// is deterministic and stable across runs — a sticky comment that re-orders on
// every push would be noisy in the PR timeline.
// ============================================================================
import type { Finding, Report, Verdict } from "../types.js";

/** The exact HTML marker that MUST be the first line of every rendered report.
 *  The CI sticky-comment step greps for this to locate + overwrite its comment. */
export const REPORT_MARKER = "<!-- testtrust-report -->";

/** Hard cap on rendered table rows; beyond this we emit an "…and K more" note
 *  so the comment stays small no matter how many findings a PR carries. */
export const MAX_ROWS = 30;

/** Verdict → leading emoji. pass ✅, neutral ⚠️, fail ❌. */
const VERDICT_EMOJI: Record<Verdict, string> = {
  pass: "✅",
  neutral: "⚠️",
  fail: "❌",
};

// ----------------------------------------------------------------------------
// Escaping
// ----------------------------------------------------------------------------

/**
 * Make an arbitrary message safe to drop into a single Markdown table cell.
 *
 * A GFM table row is delimited by `|` and terminated by a newline, so a raw
 * `|` or line break in a finding message would shatter the table. We:
 *   - escape every `|` as `\|` (GFM's documented cell escape), and
 *   - flatten CR/LF (and the CRLF pair) to a single space so a multi-line
 *     message collapses onto one row.
 * Surrounding whitespace is trimmed and internal runs are collapsed so the cell
 * reads cleanly. The result never contains a bare `|` or newline.
 */
function escapeCell(text: string): string {
  return text
    .replace(/\r\n?|\n/g, " ") // CRLF / CR / LF -> single space (one-line cell)
    .replace(/\|/g, "\\|") // escape the table delimiter
    .replace(/\s+/g, " ") // collapse internal whitespace runs
    .trim();
}

// ----------------------------------------------------------------------------
// Sorting
// ----------------------------------------------------------------------------

/**
 * Order findings by file ascending, then line ascending. Pure: copies the input
 * before sorting (never mutates `report.findings`). The comparator is total and
 * deterministic — ties on (file, line) fall back to the producer's original
 * order via the carried index, so the output is stable across runs.
 */
function sortFindings(findings: readonly Finding[]): Finding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      const byFile = a.finding.file.localeCompare(b.finding.file);
      if (byFile !== 0) return byFile;
      const byLine = a.finding.line - b.finding.line;
      if (byLine !== 0) return byLine;
      return a.index - b.index; // stable tie-break
    })
    .map((entry) => entry.finding);
}

// ----------------------------------------------------------------------------
// Summary helpers
// ----------------------------------------------------------------------------

/** "1 file" / "3 files" — tiny English pluraliser, mirroring the human reporter. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The one-line counts summary, e.g.
 *   "Analyzed 3 files · 5 findings (1 fail · 3 warn · 1 info)".
 *
 * Uses `report.filesAnalyzed` (true count of scanned files) rather than the
 * number of files that happened to have findings, so a clean run still reports
 * the real denominator.
 */
function renderSummary(report: Report): string {
  const counts = report.score.countsBySeverity;
  return (
    `Analyzed ${plural(report.filesAnalyzed, "file")} · ` +
    `${plural(report.score.totalFindings, "finding")} ` +
    `(${counts.fail} fail · ${counts.warn} warn · ${counts.info} info)`
  );
}

// ----------------------------------------------------------------------------
// Table
// ----------------------------------------------------------------------------

/** One Markdown table row for a finding: rule, `file:line`, escaped message. */
function renderRow(finding: Finding): string {
  const rule = `\`${finding.ruleId}\``;
  const location = `\`${escapeCell(finding.file)}:${finding.line}\``;
  const message = escapeCell(finding.message);
  return `| ${rule} | ${location} | ${message} |`;
}

/**
 * Build the `<details>`-wrapped findings table for a NON-empty finding list.
 *
 * Findings are sorted (file, line), capped at {@link MAX_ROWS} rows, and — when
 * the cap bites — a "…and K more" line is appended so reviewers know the comment
 * was truncated. The whole table is folded inside a `<details>` block so it
 * doesn't dominate the PR conversation; the `<summary>` shows the finding count.
 *
 * Blank lines around the table are required: GitHub only renders a Markdown
 * table inside a `<details>` when it's separated from the HTML tags by a blank
 * line.
 */
function renderTable(findings: readonly Finding[]): string[] {
  const sorted = sortFindings(findings);
  const shown = sorted.slice(0, MAX_ROWS);
  const hidden = sorted.length - shown.length;

  const lines: string[] = [];
  lines.push(`<details><summary>${plural(sorted.length, "finding")}</summary>`);
  lines.push(""); // blank line so the table renders inside <details>
  lines.push("| Rule | Location | Message |");
  lines.push("| --- | --- | --- |");
  for (const finding of shown) lines.push(renderRow(finding));
  if (hidden > 0) lines.push("", `…and ${hidden} more`);
  lines.push(""); // blank line before closing the block
  lines.push("</details>");
  return lines;
}

// ----------------------------------------------------------------------------
// Public entry point
// ----------------------------------------------------------------------------

/**
 * Render a {@link Report} as a PR-comment-friendly Markdown string.
 *
 * The first line is always {@link REPORT_MARKER}. With findings, a folded,
 * row-capped table follows; with zero findings, a single all-clear line is used
 * instead. No trailing newline is appended — the CLI decides how to write it.
 *
 * @param report the finished report from the analyzer.
 * @returns the full multi-line Markdown string.
 */
export function renderMarkdown(report: Report): string {
  const { score } = report;
  const verdict = score.verdict.toUpperCase();
  const emoji = VERDICT_EMOJI[score.verdict];

  const lines: string[] = [
    REPORT_MARKER,
    `## 🧪 testtrust — ${score.score}/100 · ${emoji} ${verdict}`,
    renderSummary(report),
    "",
  ];

  if (report.findings.length === 0) {
    lines.push("✅ No test-trust issues found.");
  } else {
    lines.push(...renderTable(report.findings));
  }

  lines.push("");
  lines.push(
    "<sub>Powered by [testtrust](https://github.com/corgu1995/testtrust) · " +
      "suppress a line with `// testtrust-disable-next-line <rule>`</sub>",
  );

  return lines.join("\n");
}
