// ============================================================================
// scripts/pulse.mjs
//
// Weekly "Test-Quality Pulse" content engine.
//
// This is NOT a leaderboard and NOT a name-and-shame audit. It produces a
// short, respectful, EDUCATIONAL note about test quality in the AI era,
// backed by AGGREGATE numbers from a small curated set of well-known OSS
// repos. No repo is ever named in a negative light; individual findings are
// anonymized; good engineering is credited; known false-positive shapes are
// disclosed up front.
//
// What it does, in order:
//   1. DOGFOOD: run the freshly-built CLI on testtrust's own `test/**` files.
//      testtrust must come back clean on itself (exit 0). If it does not, we
//      bail loudly rather than publish a post that fails its own standard.
//   2. SCAN: shallow-clone a few popular repos into a temp dir and run
//      testtrust in files-mode on each, collecting AGGREGATE counts only
//      (per-repo: files analyzed, whether any rule tripped, counts by rule).
//      One short, fully-anonymized snippet is kept purely to illustrate a
//      pattern — never to point at a project.
//   3. WRITE: render `pulse/latest.md` and a dated `pulse/YYYY-MM-DD.md`.
//
// Runtime: plain JS, Node ESM, run by `node scripts/pulse.mjs`. It is NOT part
// of the TypeScript build. Only Node builtins are used. Every repo is wrapped
// in try/catch so one bad clone or scan can never sink the run.
// ============================================================================

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");
const PULSE_DIR = path.join(REPO_ROOT, "pulse");

// --- Tunables -----------------------------------------------------------------

// Shallow clone depth. We do not need full history for files-mode, but a little
// depth keeps the clone resilient if the default branch tip is in flux.
const CLONE_DEPTH = 80;

// Per-clone / per-scan wall-clock budget so a wedged network call or a huge
// repo can't hang the weekly job.
const CLONE_TIMEOUT_MS = 120_000;
const SCAN_TIMEOUT_MS = 180_000;

// Curated, deliberately SMALL list of popular, well-engineered OSS repos. These
// are chosen because they are widely respected — the whole point is to say
// "even great teams have test files a linter would flag, and that's normal."
// Keep this list short and uncontroversial.
const REPOS = [
  // Curated to repos that use Jest/Vitest-style `expect()` assertions — the
  // styles testtrust actually parses. Ava (`t.is()`) and Mocha (bare `assert`)
  // styles are NOT recognized, so those repos would inflate false positives;
  // deliberately excluded. These five were spot-checked to scan cleanly.
  { name: "honojs/hono", url: "https://github.com/honojs/hono.git" },
  { name: "colinhacks/zod", url: "https://github.com/colinhacks/zod.git" },
  { name: "unjs/h3", url: "https://github.com/unjs/h3.git" },
  { name: "unjs/ofetch", url: "https://github.com/unjs/ofetch.git" },
  { name: "unjs/defu", url: "https://github.com/unjs/defu.git" },
];

// Test-file globs covering the JS + TS dialects testtrust can parse
// (.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts). Broad on purpose: a repo with zero
// matches simply produces an empty scan and is skipped.
const TEST_GLOBS = [
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.test.mjs",
  "**/*.test.cjs",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.js",
  "**/*.spec.ts",
  "**/test/**/*.js",
  "**/test/**/*.ts",
  "**/__tests__/**/*.js",
  "**/__tests__/**/*.ts",
];

// Human-friendly rule labels (kept in sync with the detectors' meta.title).
// Used only for the aggregate breakdown table.
const RULE_LABELS = {
  "assertion-free": "Assertion-free / snapshot-only test",
  "snapshot-only": "Snapshot-only test",
  tautology: "Tautological assertion",
  "over-mocking-sut": "Over-mocked subject under test",
  "trivial-assertion": "Trivial assertion",
  "focused-test": "Focused test (.only left in)",
  "assertion-weakened": "Assertion weakened",
  "assertion-deleted": "Assertion deleted",
  "test-skipped": "Test skipped",
};

// --- Small helpers ------------------------------------------------------------

function log(msg) {
  // Progress goes to stderr so it never pollutes any captured stdout.
  process.stderr.write(`[pulse] ${msg}\n`);
}

function pct(n, d) {
  if (!d) return "0%";
  return `${Math.round((n / d) * 100)}%`;
}

function todayISO() {
  // YYYY-MM-DD in UTC — stable regardless of the runner's local timezone.
  return new Date().toISOString().slice(0, 10);
}

/**
 * Run the built CLI in files-mode and return the parsed JSON Report, or null.
 *
 * The CLI exits 0 (pass/neutral) or 1 (fail) with a JSON report on stdout, and
 * exits 2 (e.g. empty scan / usage) or 3 (internal error) with NO JSON. We
 * therefore parse stdout defensively and treat anything unparseable as "skip".
 */
function runCli(cwd, globs) {
  const res = spawnSync(process.execPath, [CLI, "--format", "json", "--quiet", "--cwd", cwd, ...globs], {
    cwd,
    encoding: "utf8",
    timeout: SCAN_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    // Inherit env but make output deterministic / unstyled.
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });

  // Exit code 2 with no stdout is the normal "no test files matched" case.
  const stdout = (res.stdout || "").trim();
  if (!stdout.startsWith("{")) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

// --- Step 1: dogfood ----------------------------------------------------------

/**
 * Run testtrust on its own test suite. Returns a small summary object. Throws
 * if the tool reports a failing verdict on itself — a published pulse must
 * never fail its own bar.
 */
function dogfood() {
  log("dogfooding testtrust on its own test/** ...");
  if (!fs.existsSync(CLI)) {
    throw new Error(`built CLI not found at ${CLI} — run "npm run build" first`);
  }

  const report = runCli(REPO_ROOT, ["test/**/*.test.ts"]);
  if (!report) {
    throw new Error("dogfood run produced no JSON report (build or CLI failure)");
  }

  const verdict = report.score?.verdict ?? "unknown";
  log(`dogfood: ${report.filesAnalyzed} files, score ${report.score?.score}, verdict ${verdict}`);

  // The trust signal: testtrust must stay clean on itself (exit 0 == not fail).
  if (verdict === "fail") {
    throw new Error(`testtrust failed its own test suite (verdict=fail) — refusing to publish a pulse`);
  }

  return {
    version: report.version,
    filesAnalyzed: report.filesAnalyzed,
    score: report.score?.score ?? null,
    verdict,
  };
}

// --- Step 2: scan curated repos ----------------------------------------------

/**
 * Shallow-clone one repo and scan it. Returns a per-repo result or null on any
 * failure (network, missing repo, empty scan, parse error). NEVER throws.
 */
function scanRepo(repo, tmpRoot) {
  const dest = path.join(tmpRoot, repo.name.replace(/[^a-zA-Z0-9_-]+/g, "_"));
  try {
    log(`cloning ${repo.name} (depth ${CLONE_DEPTH}) ...`);
    execFileSync(
      "git",
      [
        "clone",
        "--depth",
        String(CLONE_DEPTH),
        "--quiet",
        "--single-branch",
        "--no-tags",
        repo.url,
        dest,
      ],
      { stdio: ["ignore", "ignore", "ignore"], timeout: CLONE_TIMEOUT_MS },
    );
  } catch (err) {
    log(`  skip ${repo.name}: clone failed (${shortErr(err)})`);
    return null;
  }

  try {
    const report = runCli(dest, TEST_GLOBS);
    if (!report) {
      log(`  skip ${repo.name}: no test files matched / no report`);
      return null;
    }

    const counts = {};
    for (const b of report.score?.breakdown ?? []) {
      counts[b.ruleId] = (counts[b.ruleId] ?? 0) + b.count;
    }
    const totalFindings = report.score?.totalFindings ?? 0;

    log(
      `  ${repo.name}: ${report.filesAnalyzed} files, ${totalFindings} signal(s)` +
        (totalFindings ? ` across ${Object.keys(counts).length} rule(s)` : ""),
    );

    return {
      filesAnalyzed: report.filesAnalyzed ?? 0,
      totalFindings,
      tripped: totalFindings > 0,
      counts,
      // Keep at most one finding from this repo as a *candidate* illustrative
      // example. It is stripped of file/repo identity before it is ever used.
      sampleFinding: pickIllustrative(report.findings),
    };
  } catch (err) {
    log(`  skip ${repo.name}: scan error (${shortErr(err)})`);
    return null;
  }
}

/**
 * Choose at most one finding worth illustrating, preferring a clear, teachable
 * shape (a tautology or a trivial assertion) over the softer helper-delegation
 * signal. Returns an anonymized record { ruleId, message } or null.
 */
function pickIllustrative(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return null;
  const preferred = ["tautology", "trivial-assertion", "focused-test", "over-mocking-sut"];
  const byPref = findings.find((f) => preferred.includes(f.ruleId)) ?? findings[0];
  if (!byPref) return null;
  // Only carry rule id + the generic message. Never the file path, line, repo,
  // or source snippet — this is education, not attribution.
  return { ruleId: byPref.ruleId, message: byPref.message };
}

function shortErr(err) {
  const m = err && err.message ? err.message : String(err);
  return m.split("\n")[0].slice(0, 140);
}

// --- Step 3: render markdown --------------------------------------------------

function aggregate(results) {
  const scanned = results.length;
  const tripped = results.filter((r) => r.tripped).length;
  const filesAnalyzed = results.reduce((a, r) => a + r.filesAnalyzed, 0);
  const totalFindings = results.reduce((a, r) => a + r.totalFindings, 0);

  const byRule = {};
  for (const r of results) {
    for (const [ruleId, n] of Object.entries(r.counts)) {
      byRule[ruleId] = (byRule[ruleId] ?? 0) + n;
    }
  }

  // Pick one anonymized illustrative example across all repos, preferring the
  // most teachable rule available.
  const order = ["tautology", "trivial-assertion", "focused-test", "over-mocking-sut", "assertion-free"];
  let example = null;
  for (const ruleId of order) {
    const hit = results.find((r) => r.sampleFinding && r.sampleFinding.ruleId === ruleId);
    if (hit) {
      example = hit.sampleFinding;
      break;
    }
  }
  if (!example) {
    const hit = results.find((r) => r.sampleFinding);
    example = hit ? hit.sampleFinding : null;
  }

  return { scanned, tripped, filesAnalyzed, totalFindings, byRule, example };
}

function ruleTable(byRule) {
  const rows = Object.entries(byRule).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return "_No rules tripped across the scanned repositories this week._\n";
  const lines = ["| Signal | Aggregate count |", "| --- | ---: |"];
  for (const [ruleId, n] of rows) {
    lines.push(`| ${RULE_LABELS[ruleId] ?? ruleId} | ${n} |`);
  }
  return lines.join("\n") + "\n";
}

function renderMarkdown({ date, dog, agg }) {
  const repoCount = agg.scanned;
  const trippedPct = pct(agg.tripped, agg.scanned);

  const exampleBlock = agg.example
    ? [
        "Here is one anonymized, representative pattern from this week's scan. " +
          "We are **not** naming the project — it ships good software and this is " +
          "the kind of thing that accumulates in any healthy codebase over years. " +
          "We surface it only because it's a clean teaching example:",
        "",
        "> **Signal:** " + (RULE_LABELS[agg.example.ruleId] ?? agg.example.ruleId),
        ">",
        "> " + agg.example.message,
        "",
        "A test like this still *runs green*, which is exactly why it's easy to " +
          "miss in review. The fix is usually small: assert on the observable " +
          "behaviour the test claims to cover.",
      ].join("\n")
    : "_No illustrative example was collected this week (every scanned repo came back clean under our filters)._";

  return `# Test-Quality Pulse — ${date}

> A weekly, **educational** look at test quality in the age of AI-assisted
> coding. No leaderboards, no name-and-shame — just aggregate signal and one
> thing worth learning.

## Why this exists

AI coding assistants are remarkable at producing tests *fast*. They are also
remarkably good at producing tests that **look** thorough but quietly assert
nothing — a snapshot with no expectation, an \`expect(x).toBe(x)\` tautology, a
mock so complete the real code never runs, or a once-failing assertion that got
"fixed" by being deleted. These pass CI. They turn the build green. And they let
real bugs through, because a green check is doing no work.

This isn't a knock on AI, or on anyone. It's a new failure mode that classic
coverage numbers don't catch: **coverage tells you a line ran, not that anything
was checked.** The Pulse is our small, recurring attempt to make that failure
mode visible and teachable.

## This week, by the numbers

We scanned **${repoCount}** widely-used, well-engineered open-source repositories
in files-mode. Aggregate only — we count shapes, not blame:

- **${agg.scanned}** repositories scanned, **${agg.filesAnalyzed}** test files analyzed.
- **${trippedPct}** of scanned repos (${agg.tripped} of ${agg.scanned}) tripped **at least one** rule.
- **${agg.totalFindings}** total signals raised across all of them.

${ruleTable(agg.byRule)}
The headline isn't "these repos are bad." It's the opposite: these are some of
the most respected projects in the ecosystem, and even here a static check finds
test files worth a second look. If it's normal *here*, it's normal in your repo
too — and it's worth a glance before an AI-generated test slips a regression past
a green build.

## One pattern worth learning

${exampleBlock}

## How we measured this (and what we deliberately ignore)

Honest numbers need honest caveats:

- **Static analysis, files-mode.** Each repo is shallow-cloned and scanned with
  the public testtrust CLI (\`node dist/cli.js --format json <test-globs>\`). No
  diff/history is used, so the regression rules (weakened/deleted/skipped
  assertions) don't apply here — those need a base ref.
- **We filter the obvious false positives.** Type-level tests (e.g.
  \`expectTypeOf\` / \`tsd\`-style assertions that are checked by the compiler, not
  at runtime) are intentionally not flagged as assertion-free. The
  helper-delegation signal ("delegates to a helper we couldn't confirm asserts")
  is deliberately a soft *warn*, not a failure — a custom assertion helper is
  good engineering, and we'd rather under-claim than accuse.
- **Aggregate, anonymized, by design.** We report counts at the repository
  level and show a single example with its identity removed. We will never
  publish a ranked list of repos by "bad tests." That backfires, and it's not
  the point.
- **Reproducible.** The exact repo list and logic live in
  [\`scripts/pulse.mjs\`](../scripts/pulse.mjs). Run it yourself.

## Try it on your own code

testtrust grades whether your tests actually test anything, and it's built to
run on a pull-request **diff** — where AI-gamed tests actually land:

\`\`\`bash
# Grade the test files changed in your PR against the base branch
npx testtrust --base origin/main
\`\`\`

It catches assertion-free and tautological tests, over-mocked subjects, and —
in diff mode — assertions that were silently weakened, deleted, or skipped,
*before* a false-green CI run ships the bug.

---

<sub>Generated by testtrust's own Pulse engine. testtrust v${dog.version} ·
dogfood on its own suite this run: ${dog.filesAnalyzed} files,
score ${dog.score}, verdict **${dog.verdict}**. We hold ourselves to the same
bar we measure with.</sub>
`;
}

// --- Main ---------------------------------------------------------------------

function main() {
  // 1) Dogfood first. If we can't pass our own bar, we don't publish.
  const dog = dogfood();

  // 2) Scan curated repos into a throwaway temp dir.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "testtrust-pulse-"));
  log(`scanning ${REPOS.length} repos into ${tmpRoot}`);
  const results = [];
  for (const repo of REPOS) {
    const r = scanRepo(repo, tmpRoot);
    if (r) results.push(r);
  }

  // Best-effort cleanup of the temp clones.
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* non-fatal */
  }

  if (results.length === 0) {
    // Don't fail the job — just note it and leave existing pulse files in place.
    log("no repos scanned successfully this run; nothing to publish.");
    return;
  }

  // 3) Render and write both the rolling latest and a dated snapshot.
  const date = todayISO();
  const agg = aggregate(results);
  const md = renderMarkdown({ date, dog, agg });

  fs.mkdirSync(PULSE_DIR, { recursive: true });
  const latest = path.join(PULSE_DIR, "latest.md");
  const dated = path.join(PULSE_DIR, `${date}.md`);
  fs.writeFileSync(latest, md, "utf8");
  fs.writeFileSync(dated, md, "utf8");

  log(`wrote ${path.relative(REPO_ROOT, latest)} and ${path.relative(REPO_ROOT, dated)}`);
  log(
    `summary: ${agg.scanned} repos, ${agg.tripped} tripped a rule (${pct(agg.tripped, agg.scanned)}), ` +
      `${agg.totalFindings} total signals.`,
  );
}

try {
  main();
} catch (err) {
  // A hard failure here (e.g. dogfood failed) SHOULD fail the job, because it
  // means our own quality bar slipped — that's worth a red build.
  process.stderr.write(`[pulse] fatal: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
}
