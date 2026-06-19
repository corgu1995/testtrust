// ============================================================================
// test/core/config.test.ts
// Spec for the project config-file loader (src/core/config.ts).
//
// loadConfig(cwd) discovers, in order, `.testtrustrc.json`, `.testtrustrc`, then
// the `"testtrust"` key of `package.json`, and returns the persisted PARTIAL of
// CLI options (TesttrustConfig). These tests pin three things:
//
//   (1) Discovery + precedence: rc.json > rc > package.json; first existing
//       file wins; a present-but-broken rc does NOT fall through to package.json.
//   (2) The no-throw / total guarantee: missing file => {}, invalid JSON => {},
//       garbage payloads (arrays, strings, null) => {}.
//   (3) Shape coercion: known well-typed fields survive; unknown keys, bad
//       enum members, and wrong-typed values are silently dropped.
//
// Fixtures are written to a throwaway dir under node:os tmpdir via node:fs, one
// per test, and torn down after — mirroring test/git/diff.test.ts so this runs
// on Windows and POSIX alike.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig, type TesttrustConfig } from "../../src/core/config.js";

// ----------------------------------------------------------------------------
// Per-test temp dir lifecycle
// ----------------------------------------------------------------------------

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "testtrust-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a file (string or JSON-able value) into the current temp dir. */
async function write(name: string, contents: string | unknown): Promise<void> {
  const text =
    typeof contents === "string" ? contents : JSON.stringify(contents, null, 2);
  await writeFile(path.join(dir, name), text, "utf8");
}

// ============================================================================
// .testtrustrc.json (primary source)
// ============================================================================
describe("loadConfig() — .testtrustrc.json", () => {
  it("loads { failUnder, disable } from a .testtrustrc.json", async () => {
    await write(".testtrustrc.json", {
      failUnder: 80,
      disable: ["trivial-assertion"],
    });

    const cfg = loadConfig(dir);
    expect(cfg).toEqual<TesttrustConfig>({
      failUnder: 80,
      disable: ["trivial-assertion"],
    });
  });

  it("loads format, baseRef, and per-rule overrides", async () => {
    await write(".testtrustrc.json", {
      format: "markdown",
      baseRef: "origin/main",
      rules: {
        tautology: { enabled: true, severity: "fail" },
        "assertion-free": { enabled: false },
      },
    });

    expect(loadConfig(dir)).toEqual<TesttrustConfig>({
      format: "markdown",
      baseRef: "origin/main",
      rules: {
        tautology: { enabled: true, severity: "fail" },
        "assertion-free": { enabled: false },
      },
    });
  });
});

// ============================================================================
// .testtrustrc (extensionless, still JSON)
// ============================================================================
describe("loadConfig() — .testtrustrc (no extension)", () => {
  it("parses an extensionless .testtrustrc as JSON when no .json sibling exists", async () => {
    await write(".testtrustrc", { failUnder: 42, format: "json" });

    expect(loadConfig(dir)).toEqual<TesttrustConfig>({
      failUnder: 42,
      format: "json",
    });
  });
});

// ============================================================================
// package.json "testtrust" key (lowest-priority source)
// ============================================================================
describe('loadConfig() — package.json "testtrust" key', () => {
  it('loads from package.json {"testtrust": {...}} when no rc file is present', async () => {
    await write("package.json", {
      name: "demo",
      version: "1.0.0",
      testtrust: { format: "json" },
    });

    expect(loadConfig(dir)).toEqual<TesttrustConfig>({ format: "json" });
  });

  it("returns {} when package.json exists but has no testtrust key", async () => {
    await write("package.json", { name: "demo", version: "1.0.0" });
    expect(loadConfig(dir)).toEqual({});
  });
});

// ============================================================================
// Precedence between sources
// ============================================================================
describe("loadConfig() — precedence", () => {
  it("prefers .testtrustrc.json over a package.json testtrust key", async () => {
    await write(".testtrustrc.json", { failUnder: 90 });
    await write("package.json", {
      name: "demo",
      testtrust: { failUnder: 10, format: "json" },
    });

    // The rc file wins entirely; package.json is not merged in.
    expect(loadConfig(dir)).toEqual<TesttrustConfig>({ failUnder: 90 });
  });

  it("prefers .testtrustrc.json over a plain .testtrustrc", async () => {
    await write(".testtrustrc.json", { format: "json" });
    await write(".testtrustrc", { format: "markdown" });

    expect(loadConfig(dir)).toEqual<TesttrustConfig>({ format: "json" });
  });

  it("prefers .testtrustrc over package.json when no .json rc exists", async () => {
    await write(".testtrustrc", { failUnder: 55 });
    await write("package.json", { testtrust: { failUnder: 5 } });

    expect(loadConfig(dir)).toEqual<TesttrustConfig>({ failUnder: 55 });
  });

  it("does NOT fall through to package.json when the rc file is present but invalid", async () => {
    await write(".testtrustrc.json", "{ this is not valid json ");
    await write("package.json", { testtrust: { failUnder: 70 } });

    // rc exists, so it is authoritative — a broken rc resolves to {}, it does
    // not silently defer to package.json.
    expect(loadConfig(dir)).toEqual({});
  });
});

// ============================================================================
// No-throw / total guarantees
// ============================================================================
describe("loadConfig() — missing & invalid inputs never throw", () => {
  it("returns {} when no config file exists at all", () => {
    expect(loadConfig(dir)).toEqual({});
  });

  it("returns {} (no throw) for malformed JSON in .testtrustrc.json", async () => {
    await write(".testtrustrc.json", "{ failUnder: 80,, }"); // invalid JSON

    let cfg!: TesttrustConfig;
    expect(() => {
      cfg = loadConfig(dir);
    }).not.toThrow();
    expect(cfg).toEqual({});
  });

  it("returns {} for malformed JSON in package.json", async () => {
    await write("package.json", "{ not json at all ");
    expect(() => loadConfig(dir)).not.toThrow();
    expect(loadConfig(dir)).toEqual({});
  });

  it("returns {} when the JSON root is not an object (array / string / null)", async () => {
    for (const payload of ["[1,2,3]", '"a string"', "null", "42"]) {
      await write(".testtrustrc.json", payload);
      expect(loadConfig(dir)).toEqual({});
    }
  });

  it("returns {} for a non-existent cwd (path that does not resolve to a dir)", () => {
    const missing = path.join(dir, "does", "not", "exist");
    expect(() => loadConfig(missing)).not.toThrow();
    expect(loadConfig(missing)).toEqual({});
  });
});

// ============================================================================
// Shape coercion — unknown keys & bad values are dropped, not trusted
// ============================================================================
describe("loadConfig() — validation / coercion", () => {
  it("ignores unknown top-level keys", async () => {
    await write(".testtrustrc.json", {
      failUnder: 75,
      somethingElse: true,
      nested: { a: 1 },
    });

    expect(loadConfig(dir)).toEqual<TesttrustConfig>({ failUnder: 75 });
  });

  it("drops failUnder when it is not an integer in [0,100]", async () => {
    for (const bad of ["not-a-number", true, 12.5, -1, 101, NaN]) {
      await write(".testtrustrc.json", { failUnder: bad });
      expect(loadConfig(dir).failUnder).toBeUndefined();
    }
  });

  it("accepts the boundary failUnder values 0 and 100", async () => {
    await write(".testtrustrc.json", { failUnder: 0 });
    expect(loadConfig(dir).failUnder).toBe(0);

    await write(".testtrustrc.json", { failUnder: 100 });
    expect(loadConfig(dir).failUnder).toBe(100);
  });

  it("drops an unknown format value", async () => {
    await write(".testtrustrc.json", { format: "xml" });
    expect(loadConfig(dir).format).toBeUndefined();
  });

  it("drops an empty-string baseRef but keeps a real one", async () => {
    await write(".testtrustrc.json", { baseRef: "" });
    expect(loadConfig(dir).baseRef).toBeUndefined();

    await write(".testtrustrc.json", { baseRef: "HEAD~1" });
    expect(loadConfig(dir).baseRef).toBe("HEAD~1");
  });

  it("drops unknown rule ids and malformed rule entries from rules", async () => {
    await write(".testtrustrc.json", {
      rules: {
        tautology: { enabled: true },
        "not-a-real-rule": { enabled: false }, // unknown id -> dropped
        "assertion-free": { severity: "warn" }, // missing `enabled` -> dropped
        "focused-test": "nope", // not an object -> dropped
      },
    });

    expect(loadConfig(dir).rules).toEqual({ tautology: { enabled: true } });
  });

  it("keeps a rule's severity only when it names a known Severity", async () => {
    await write(".testtrustrc.json", {
      rules: {
        tautology: { enabled: true, severity: "warn" },
        "test-skipped": { enabled: true, severity: "loud" }, // bad sev -> stripped
      },
    });

    expect(loadConfig(dir).rules).toEqual({
      tautology: { enabled: true, severity: "warn" },
      "test-skipped": { enabled: true },
    });
  });

  it("filters disable[] to known RuleIds and dedupes", async () => {
    await write(".testtrustrc.json", {
      disable: [
        "trivial-assertion",
        "trivial-assertion", // duplicate
        "bogus-rule", // unknown
        123, // wrong type
      ],
    });

    expect(loadConfig(dir).disable).toEqual(["trivial-assertion"]);
  });

  it("drops disable entirely when it is not an array", async () => {
    await write(".testtrustrc.json", { disable: "trivial-assertion" });
    expect(loadConfig(dir).disable).toBeUndefined();
  });
});
