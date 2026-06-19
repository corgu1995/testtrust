// ============================================================================
// test/git/diff.test.ts
//
// Spec for the diff-mode "which changed files are tests?" gate in
// src/git/diff.ts. Two layers:
//
//   (A) isTestFilePath(path) — the pure predicate listChangedTestFiles() filters
//       with. Driven entirely by inline strings (no disk, no git): fast and
//       fully deterministic. This is where the bulk of the edge cases live.
//
//   (B) listChangedTestFiles(base, cwd) — a thin end-to-end check on a throwaway
//       temp git repo, proving the predicate is actually wired into the diff
//       walk: a changed `__tests__/foo.ts` (Jest's directory convention, no
//       `.test`/`.spec` suffix) is surfaced, a changed non-test source file is
//       not, and a deleted test is dropped. Self-skips if git is unavailable.
//
// Regression under test: Jest treats every file under a `__tests__/` directory
// as a test even without a `.test`/`.spec` suffix (e.g. immer's
// `__tests__/base.ts`). Diff mode used to filter on the `.test/spec.` suffix
// alone, so those files were silently skipped. The predicate now ALSO accepts
// any JS/TS file under a `__tests__`/`__test__` path *segment*, while still
// excluding `.d.ts` declarations and matching a real segment (not a substring
// like `my__tests__file.ts`).
//
// Portability: the repo is built with path.join and every git call gets an
// explicit cwd, mirroring test/integration/analyze.test.ts, so it runs on
// Windows and POSIX alike. git emits forward-slash paths on every OS, so the
// predicate (and these expectations) are written against POSIX paths.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isTestFilePath, listChangedTestFiles } from "../../src/git/diff.js";

// ----------------------------------------------------------------------------
// (A) isTestFilePath — the pure predicate
// ----------------------------------------------------------------------------

describe("isTestFilePath()", () => {
  describe("Jest `__tests__/` directory convention (the regression)", () => {
    // A file under a __tests__ segment is a test even with NO .test/.spec suffix.
    const underTestsDir = [
      "src/__tests__/base.ts", // immer-style fixture (the motivating case)
      "pkg/__tests__/x/y.tsx", // nested below the __tests__ dir, JSX
      "__tests__/bar/baz.tsx", // __tests__ at the very start of the path
      "__tests__/foo.ts", // top-level, single file
      "a/b/__tests__/c.js", // deep, plain .js
      "lib/__tests__/util.mjs", // ESM extension
      "lib/__tests__/util.cts", // CJS + TS extension
      "src/__test__/base.ts", // singular `__test__` variant is also accepted
    ];
    it.each(underTestsDir)("recognizes %s as a test file", (p) => {
      expect(isTestFilePath(p)).toBe(true);
    });
  });

  describe("conventional *.test.* / *.spec.* names still recognized", () => {
    const conventional = [
      "foo.test.ts", // the canonical case called out by the task
      "src/foo.spec.ts",
      "a/b/c.test.tsx",
      "x.spec.jsx",
      "y.test.mjs",
      "z.spec.cts",
      "deep/nested/thing.test.js",
    ];
    it.each(conventional)("recognizes %s as a test file", (p) => {
      expect(isTestFilePath(p)).toBe(true);
    });
  });

  describe("non-tests are rejected", () => {
    const notTests = [
      "src/util.ts", // plain source (explicit task case): NOT a test
      "src/index.ts",
      "README.md",
      "package.json",
      "foo.ts",
      "src/components/Button.tsx", // a component, not a test
      "test/helpers/context.ts", // a `test/` dir is NOT `__tests__/`
    ];
    it.each(notTests)("does not recognize %s", (p) => {
      expect(isTestFilePath(p)).toBe(false);
    });
  });

  describe("`__tests__` must be a path SEGMENT, not a substring", () => {
    // The bug to avoid: a regex that matches `__tests__` anywhere as a substring
    // would wrongly flag these. None contains a real `__tests__/` directory.
    const substringDecoys = [
      "src/my__tests__file.ts", // `__tests__` embedded in a filename
      "src/foo__tests__.ts", // trailing, still embedded
      "x__test__y/z.ts", // embedded in a dir name, not the whole segment
      "a/prefix__tests__/b.ts", // segment is `prefix__tests__`, not `__tests__`
      "a/__tests__suffix/b.ts", // segment is `__tests__suffix`, not `__tests__`
    ];
    it.each(substringDecoys)("does not recognize %s", (p) => {
      expect(isTestFilePath(p)).toBe(false);
    });
  });

  describe("type-declaration files are excluded (even under `__tests__/`)", () => {
    const declarations = [
      "__tests__/types.d.ts", // the explicit task case
      "src/__tests__/global.d.ts", // nested under __tests__
      "src/foo.d.ts", // ordinary declaration, not under __tests__
      "src/__tests__/env.d.mts", // ESM declaration variant
      "src/__tests__/env.d.cts", // CJS declaration variant
    ];
    it.each(declarations)("does not recognize %s", (p) => {
      expect(isTestFilePath(p)).toBe(false);
    });

    it("excludes a `.d.ts` even when it ALSO carries a `.test`/`.spec` marker", () => {
      // `foo.test.d.ts` is a declaration file for a test module, still nothing
      // runnable to grade — the .d.ts exclusion must win over the suffix match.
      expect(isTestFilePath("src/foo.test.d.ts")).toBe(false);
      expect(isTestFilePath("src/foo.spec.d.ts")).toBe(false);
    });
  });

  it("requires a JS/TS extension under `__tests__/` (skips snapshots/fixtures)", () => {
    // Non-code artifacts that legitimately live under __tests__ are not gradeable
    // test *files*; the predicate keys off the JS/TS extension.
    expect(isTestFilePath("src/__tests__/__snapshots__/base.ts.snap")).toBe(false);
    expect(isTestFilePath("src/__tests__/fixture.json")).toBe(false);
    expect(isTestFilePath("src/__tests__/data.txt")).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// (B) listChangedTestFiles — end-to-end wiring on a real temp git repo
// ----------------------------------------------------------------------------

/**
 * Run a git subprocess in `cwd`. execFileSync (no shell) passes refs/paths as a
 * literal argv with no quoting surface, identical on Windows and POSIX. Throws
 * on non-zero exit, which fails the test loudly — exactly what we want for setup
 * steps. (Mirrors the helper in test/integration/analyze.test.ts.)
 */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
}

/** Probe whether a usable `git` exists, so this block can self-skip if not. */
function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeGit = hasGit() ? describe : describe.skip;

describeGit("listChangedTestFiles() — diff walk picks up `__tests__/` files", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "testtrust-diff-tests-dir-"));

    // Deterministic, isolated repo: fixed identity, no signing, default branch
    // "main" so HEAD~1 is well-defined after two commits.
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "tester@testtrust.invalid"]);
    git(repo, ["config", "user.name", "Testtrust CI"]);
    git(repo, ["config", "commit.gpgsign", "false"]);

    // ---- Commit 1 (the base): seed files that LATER change. ----
    // A __tests__ fixture that will be modified (so it shows as "M", proving the
    // suffix-less Jest convention is matched), plus a conventional test that will
    // be DELETED (so we can assert deletions are dropped).
    const baseTestsFixture = path.join(repo, "src", "__tests__", "foo.ts");
    const baseDoomedTest = path.join(repo, "src", "old.test.ts");
    const baseDecl = path.join(repo, "src", "__tests__", "types.d.ts");
    await mkdir(path.dirname(baseTestsFixture), { recursive: true });
    await writeFile(baseTestsFixture, "export const before = 1;\n", "utf8");
    await writeFile(baseDoomedTest, "it('x', () => { expect(1).toBe(1); });\n", "utf8");
    await writeFile(baseDecl, "export declare const t: number;\n", "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base: seed __tests__ fixture, a test, a decl"]);

    // ---- Commit 2 (HEAD): the changes we expect to surface. ----
    //   * src/__tests__/foo.ts        : MODIFIED  -> should appear (no suffix!)
    //   * src/__tests__/x/y.tsx       : ADDED      -> should appear (nested, JSX)
    //   * src/util.ts                 : ADDED      -> NOT a test, must be absent
    //   * src/__tests__/types.d.ts    : MODIFIED   -> .d.ts, must be absent
    //   * src/old.test.ts             : DELETED    -> deletion, must be dropped
    await writeFile(baseTestsFixture, "export const after = 2;\n", "utf8");

    const addedNested = path.join(repo, "src", "__tests__", "x", "y.tsx");
    await mkdir(path.dirname(addedNested), { recursive: true });
    await writeFile(addedNested, "export const y = () => null;\n", "utf8");

    await writeFile(path.join(repo, "src", "util.ts"), "export const u = 3;\n", "utf8");
    await writeFile(baseDecl, "export declare const t: string;\n", "utf8"); // touch the .d.ts
    await rm(baseDoomedTest, { force: true }); // delete the conventional test

    git(repo, ["add", "-A"]); // -A so the deletion is staged too
    git(repo, ["commit", "-m", "head: change fixture, add nested test + source, delete a test"]);
  });

  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("surfaces suffix-less `__tests__/` files and excludes non-tests, decls, and deletions", async () => {
    const changed = await listChangedTestFiles("HEAD~1", repo);
    const byPath = new Map(changed.map((c) => [c.path, c.status]));
    const paths = [...byPath.keys()].sort();

    // EXACTLY the two test files under __tests__/ are reported, with the right
    // status codes. git emits forward slashes on every OS, so we assert POSIX.
    expect(paths).toEqual(["src/__tests__/foo.ts", "src/__tests__/x/y.tsx"]);
    expect(byPath.get("src/__tests__/foo.ts")).toMatch(/^M/); // modified fixture
    expect(byPath.get("src/__tests__/x/y.tsx")).toMatch(/^A/); // added nested test

    // Negative space, spelled out so a future regression is unmistakable:
    expect(byPath.has("src/util.ts")).toBe(false); // plain source: not a test
    expect(byPath.has("src/__tests__/types.d.ts")).toBe(false); // .d.ts excluded
    expect(byPath.has("src/old.test.ts")).toBe(false); // deletion dropped
  });
});
