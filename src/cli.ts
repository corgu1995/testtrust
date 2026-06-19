import process from "node:process";
import path from "node:path";
import { Command } from "commander";
import type { CliOptions, OutputFormat, RuleConfig, RuleId, Severity } from "./types.js";
import { analyze, EmptyScanError } from "./core/analyze.js";
import { renderHuman } from "./report/human.js";
import { renderJson } from "./report/json.js";
import { renderMarkdown } from "./report/markdown.js";
import { getVersion } from "./util/version.js";
import { createLogger } from "./util/log.js";
import { renderSarif } from "./report/sarif.js";
import { loadConfig } from "./core/config.js";
import { writeBaseline, resolveBaselinePath, DEFAULT_BASELINE_FILE } from "./core/baseline.js";

const ALL_RULE_IDS: readonly RuleId[] = [
  "assertion-free",
  "snapshot-only",
  "tautology",
  "over-mocking-sut",
  "trivial-assertion",
  "focused-test",
  "assertion-weakened",
  "assertion-deleted",
  "test-skipped",
];
const SEVERITIES: readonly Severity[] = ["fail", "warn", "info"];

function isRuleId(s: string): s is RuleId {
  return (ALL_RULE_IDS as readonly string[]).includes(s);
}
function isSeverity(s: string): s is Severity {
  return (SEVERITIES as readonly string[]).includes(s);
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

interface RawOpts {
  base?: string;
  format: string;
  failUnder: string;
  rule: string[];
  disable: string[];
  cwd?: string;
  color: boolean;
  quiet?: boolean;
  baseline?: string | boolean;
  updateBaseline?: string | boolean;
}

/** Resolve --rule (allowlist + optional :severity) and --disable into per-rule config. */
function resolveRules(
  rule: string[],
  disable: string[],
): { rules: Partial<Record<RuleId, RuleConfig>>; errors: string[] } {
  const errors: string[] = [];
  const rules: Partial<Record<RuleId, RuleConfig>> = {};

  if (rule.length > 0) {
    // --rule turns the listed rules into an allowlist: everything else off.
    for (const id of ALL_RULE_IDS) rules[id] = { enabled: false };
    for (const entry of rule) {
      const parts = entry.split(":");
      const idPart = parts[0] ?? "";
      const sevPart = parts[1];
      if (!isRuleId(idPart)) {
        errors.push(`unknown rule "${idPart}"`);
        continue;
      }
      const cfg: RuleConfig = { enabled: true };
      if (sevPart !== undefined) {
        if (!isSeverity(sevPart)) {
          errors.push(`invalid severity "${sevPart}" for rule "${idPart}" (use fail|warn|info)`);
          continue;
        }
        cfg.severity = sevPart;
      }
      rules[idPart] = cfg;
    }
  }

  for (const id of disable) {
    if (!isRuleId(id)) {
      errors.push(`unknown rule "${id}"`);
      continue;
    }
    const existing = rules[id];
    rules[id] = existing ? { ...existing, enabled: false } : { enabled: false };
  }

  return { rules, errors };
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("testtrust")
    .description("Grade whether your tests actually test anything.")
    .argument("[files...]", "test file globs/paths (files mode)")
    .option("-b, --base <ref>", "base git ref to diff against (enables diff mode)")
    .option("-f, --format <fmt>", "output format: human | json | markdown | sarif", "human")
    .option("--fail-under <n>", "score (0-100) at/under which the verdict is fail", "60")
    .option("--rule <id[:sev]>", "enable only the listed rule(s); repeatable", collect, [])
    .option("--disable <id>", "disable a rule; repeatable", collect, [])
    .option("--baseline [file]", "gate only findings absent from the baseline file (default .testtrust-baseline.json)")
    .option("--update-baseline [file]", "write the current findings to the baseline file, then exit")
    .option("--cwd <dir>", "project root (default: cwd)")
    .option("--no-color", "disable ANSI color output")
    .option("-q, --quiet", "suppress progress logging on stderr")
    .version(getVersion(), "-V, --version")
    .allowExcessArguments(true);

  program.parse(process.argv);
  const opts = program.opts() as RawOpts;
  const files = program.args;
  const logger = createLogger(opts.quiet ? { quiet: true } : {});
  const cwd = path.resolve(opts.cwd ?? process.cwd());

  // Config file (.testtrustrc.json | .testtrustrc | package.json "testtrust"),
  // applied UNDER explicit CLI flags — a flag the user actually passed always wins.
  const fileCfg = loadConfig(cwd);
  const usedDefault = (name: string): boolean =>
    program.getOptionValueSource(name) === "default";

  // --format (fall back to config only when the flag was left at its default)
  const formatStr =
    usedDefault("format") && fileCfg.format ? fileCfg.format : opts.format;
  const format: OutputFormat | null =
    formatStr === "json"
      ? "json"
      : formatStr === "markdown"
        ? "markdown"
        : formatStr === "sarif"
          ? "sarif"
          : formatStr === "human"
            ? "human"
            : null;
  if (format === null) {
    logger.warn(
      `error: invalid --format "${formatStr}" (expected "human", "json", "markdown", or "sarif")`,
    );
    process.exit(2);
  }

  // --fail-under (config value is pre-validated to an int 0-100 by loadConfig)
  const failUnderStr =
    usedDefault("failUnder") && fileCfg.failUnder !== undefined
      ? String(fileCfg.failUnder)
      : opts.failUnder;
  const failThreshold = Number.parseInt(failUnderStr, 10);
  if (Number.isNaN(failThreshold) || failThreshold < 0 || failThreshold > 100) {
    logger.warn("error: --fail-under must be an integer 0-100");
    process.exit(2);
  }

  // --base (a config baseRef enables diff mode, exactly like passing --base)
  const baseRef = opts.base ?? fileCfg.baseRef ?? "";
  const mode = baseRef ? "diff" : "files";

  // Rules: config disables/severities sit UNDER explicit --rule/--disable flags.
  const disableList = [...(fileCfg.disable ?? []), ...opts.disable];
  const { rules: flagRules, errors } = resolveRules(opts.rule, disableList);
  if (errors.length > 0) {
    for (const e of errors) logger.warn(`error: ${e}`);
    process.exit(2);
  }
  const rules: Partial<Record<RuleId, RuleConfig>> = {
    ...(fileCfg.rules ?? {}),
    ...flagRules,
  };

  const noColor = !opts.color || process.env.NO_COLOR !== undefined;

  if (mode === "files" && files.length === 0) {
    logger.warn("error: no input — pass test file paths/globs, or use --base <ref> for diff mode.");
    process.exit(2);
  }

  // Baseline: --update-baseline writes a snapshot then exits; --baseline gates
  // only findings absent from the store. (update wins if both are passed.)
  const resolveBl = (flag: string | boolean | undefined): string | undefined =>
    flag === undefined
      ? undefined
      : resolveBaselinePath(cwd, typeof flag === "string" ? flag : DEFAULT_BASELINE_FILE);
  const updatePath = resolveBl(opts.updateBaseline);
  const baselinePath = updatePath ? undefined : resolveBl(opts.baseline);

  const cliOptions: CliOptions = {
    mode,
    files,
    baseRef,
    cwd,
    format,
    failThreshold,
    rules,
    onlyChangedTests: true,
    noColor,
    quiet: opts.quiet === true,
    ...(baselinePath ? { baselinePath } : {}),
  };

  try {
    const report = await analyze(cliOptions);

    if (updatePath) {
      // Snapshot the full (un-gated) finding set and exit without gating.
      writeBaseline(updatePath, report.findings);
      logger.warn(
        `testtrust: wrote ${report.findings.length} finding(s) to ${path.relative(cwd, updatePath) || updatePath}`,
      );
      process.exit(0);
    }

    const output =
      format === "json"
        ? renderJson(report)
        : format === "markdown"
          ? renderMarkdown(report)
          : format === "sarif"
            ? renderSarif(report)
            : renderHuman(report, { noColor });
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    process.exit(report.score.verdict === "fail" ? 1 : 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`error: ${message}`);
    process.exit(err instanceof EmptyScanError ? 2 : 3);
  }
}

void main();
