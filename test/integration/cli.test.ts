// ============================================================================
// test/integration/cli.test.ts
//
// END-TO-END tests for the CLI GLUE that lives only in src/cli.ts and is not
// reachable through analyze(): config-file precedence, the --format sarif
// dispatch, and the --update-baseline / --baseline flag plumbing (including
// exit codes). Everything below the flag layer — detectors, scorer, the
// baseline store, the SARIF reporter — has its own unit/integration coverage;
// here we prove the wiring that turns argv + a config file into the right
// CliOptions and the right process exit code.
//
// We invoke the REAL cli entrypoint the same way `npm run dev` does: node +
// tsx against src/cli.ts. That keeps the test build-independent (no reliance on
// a fresh dist/) and exercises the exact source under test. spawnSync gives us
// status + stdout + stderr without throwing on a non-zero exit, which is itself
// part of the contract (fail -> 1, usage error -> 2).
//
// Each test runs in its own throwaway temp dir (its own cwd), so a config file
// or baseline written by one test can never leak into another.
// ============================================================================

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const TSX = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");

// tsx + ts-morph cold start makes a single invocation take a couple seconds;
// give each spawning test generous headroom over vitest's 5s default.
const SPAWN_TIMEOUT_MS = 30_000;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the testtrust CLI (via tsx) in `cwd`; never throws on non-zero exit. */
function runCli(args: string[], cwd: string): CliResult {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// One tautology + one confident assertion-free test: two warn-level smells, so
// the default-threshold verdict is "neutral" (exit 0) but a strict threshold
// flips it to "fail" (exit 1) — exactly what the baseline tests need to flip back.
const FIXTURE = [
  "describe('arithmetic', () => {",
  "  it('is internally consistent', () => {",
  "    const result = 2 + 2;",
  "    expect(result).toBe(result);",
  "  });",
  "",
  "  it('runs but verifies nothing', () => {",
  "    const value = 41 + 1;",
  "    void value;",
  "  });",
  "});",
  "",
].join("\n");

const dirs: string[] = [];
async function fixture(extra: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "testtrust-cli-"));
  dirs.push(dir);
  await writeFile(path.join(dir, "sample.test.ts"), FIXTURE, "utf8");
  for (const [name, content] of Object.entries(extra)) {
    await writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("cli — --format sarif", () => {
  it(
    "emits a valid SARIF 2.1.0 log on stdout with one result per finding",
    async () => {
      const dir = await fixture();
      const res = runCli(["sample.test.ts", "--format", "sarif"], dir);

      // Warn-level smells at the default threshold => neutral => clean exit.
      expect(res.status).toBe(0);

      const log = JSON.parse(res.stdout) as {
        version: string;
        $schema: string;
        runs: Array<{
          tool: { driver: { name: string; version: string; rules: Array<{ id: string }> } };
          results: Array<{ ruleId: string; level: string; message: { text: string } }>;
        }>;
      };

      expect(log.version).toBe("2.1.0");
      expect(log.$schema).toContain("sarif-schema-2.1.0");

      const driver = log.runs[0]!.tool.driver;
      expect(driver.name).toBe("testtrust");
      expect(driver.version).toMatch(/\d+\.\d+\.\d+/);

      const ruleIds = driver.rules.map((r) => r.id).sort();
      expect(ruleIds).toContain("assertion-free");
      expect(ruleIds).toContain("tautology");

      const results = log.runs[0]!.results;
      expect(results.length).toBeGreaterThanOrEqual(2);
      // Both fixture smells are warn-level => SARIF "warning".
      expect(results.every((r) => r.level === "warning")).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "rejects an unknown --format with a usage error (exit 2) that lists sarif",
    async () => {
      const dir = await fixture();
      const res = runCli(["sample.test.ts", "--format", "xml"], dir);

      expect(res.status).toBe(2);
      expect(res.stderr).toContain("sarif");
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("cli — baseline round-trip", () => {
  it(
    "--update-baseline writes the store and exits 0 without gating",
    async () => {
      const dir = await fixture();
      const res = runCli(["sample.test.ts", "--update-baseline"], dir);

      expect(res.status).toBe(0);
      expect(res.stderr).toContain("wrote");

      const blPath = path.join(dir, ".testtrust-baseline.json");
      expect(existsSync(blPath)).toBe(true);
      const stored = JSON.parse(readFileSync(blPath, "utf8")) as { version: number; keys: string[] };
      expect(stored.keys.length).toBeGreaterThanOrEqual(2);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "a baseline flips a strict-threshold fail back to a clean pass",
    async () => {
      const dir = await fixture();

      // Without a baseline, --fail-under 100 hard-fails (exit 1).
      const failing = runCli(["sample.test.ts", "--fail-under", "100", "--format", "json"], dir);
      expect(failing.status).toBe(1);
      expect((JSON.parse(failing.stdout) as { score: { verdict: string } }).score.verdict).toBe("fail");

      // Snapshot the findings into a baseline.
      expect(runCli(["sample.test.ts", "--update-baseline"], dir).status).toBe(0);

      // With the baseline (positional first so the optional [file] isn't consumed),
      // every finding is grandfathered => perfect score => pass => exit 0.
      const passing = runCli(
        ["sample.test.ts", "--fail-under", "100", "--baseline", "--format", "json"],
        dir,
      );
      expect(passing.status).toBe(0);
      const report = JSON.parse(passing.stdout) as {
        score: { score: number; verdict: string };
        findings: unknown[];
      };
      expect(report.findings).toHaveLength(0);
      expect(report.score.score).toBe(100);
      expect(report.score.verdict).toBe("pass");
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("cli — config file precedence", () => {
  it(
    "applies .testtrustrc.json when the matching flag is left at its default",
    async () => {
      // Config raises the gate to 100; with no --fail-under flag the two warn
      // smells now sink the score below 100 => verdict fail => exit 1.
      const dir = await fixture({ ".testtrustrc.json": JSON.stringify({ failUnder: 100 }) });
      const res = runCli(["sample.test.ts", "--format", "json"], dir);

      expect(res.status).toBe(1);
      expect((JSON.parse(res.stdout) as { score: { verdict: string } }).score.verdict).toBe("fail");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "an explicit flag overrides the config value (flags win)",
    async () => {
      // Same config (failUnder 100), but an explicit --fail-under 0 must win,
      // so the gate is lenient again => neutral => exit 0.
      const dir = await fixture({ ".testtrustrc.json": JSON.stringify({ failUnder: 100 }) });
      const res = runCli(["sample.test.ts", "--fail-under", "0", "--format", "json"], dir);

      expect(res.status).toBe(0);
      expect((JSON.parse(res.stdout) as { score: { verdict: string } }).score.verdict).toBe("neutral");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "config.format drives output when --format is omitted",
    async () => {
      // No --format flag: the config's "json" should select the JSON reporter,
      // so stdout parses as the JSON report rather than the human text table.
      const dir = await fixture({ ".testtrustrc.json": JSON.stringify({ format: "json" }) });
      const res = runCli(["sample.test.ts"], dir);

      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout) as { score: unknown; findings: unknown[] };
      expect(parsed).toHaveProperty("score");
      expect(Array.isArray(parsed.findings)).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );
});
