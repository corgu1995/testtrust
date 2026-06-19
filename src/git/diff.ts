// ============================================================================
// src/git/diff.ts
// Git diff/blob helpers built on top of the single runGit() chokepoint. These
// are the functions the diff-mode orchestrator calls to (a) resolve a stable
// base commit, (b) list the changed *test* files, and (c) read the base
// version of a file so regression detectors can compare head-vs-base.
//
// Everything here keeps git's native forward-slash paths untouched so output is
// identical on Windows and POSIX.
// ============================================================================
import { GitError, runGit } from "./gitRunner.js";

// Re-export GitError so consumers can import the error type from the diff module
// they already depend on, without also reaching into gitRunner directly.
export { GitError } from "./gitRunner.js";

/** One changed test file from the diff: its repo-relative POSIX path and the
 *  git status letter(s) (e.g. "A", "M", "R100"). Deleted files are filtered out
 *  before this type is ever produced, so `status` never starts with "D" here. */
export interface ChangedTestFile {
  /** Repo-relative path using forward slashes, exactly as git emits it. */
  path: string;
  /** git --name-status code: "A" added, "M" modified, "R###"/"C###" rename/copy. */
  status: string;
}

/** Matches conventional JS/TS test file names:
 *    *.test.js / *.spec.ts / *.test.mjs / *.spec.cts / *.test.tsx / *.spec.jsx ...
 *  Anchored to the end of the path so only the final segment's extension counts.
 *  Group breakdown: `.(test|spec)` marker, optional `c`/`m` module prefix,
 *  `j`/`t` base, optional `x` (JSX), trailing `?` on the `s` to allow `.js`/`.ts`. */
const TEST_FILE_RE = /\.(test|spec)\.(c|m)?[jt]sx?$/;

/** Matches Jest's `__tests__/` convention: any file living under a directory
 *  segment named `__tests__` or `__test__`, regardless of its base name.
 *  immer-style fixtures like `src/__tests__/base.ts` are tests even though they
 *  carry no `.test`/`.spec` suffix.
 *
 *  Correctness notes:
 *   - `(?:^|/)` anchors the dir name to a path-segment boundary (start of path
 *     or right after a slash), so `my__tests__file.ts` (a substring, not a
 *     segment) does NOT match — only a real `__tests__`/`__test__` directory.
 *   - The trailing `/` requires the segment to be a *directory* (something must
 *     follow), so a file literally named `__tests__` would not qualify.
 *   - We only require a JS/TS extension on the final segment (`.[cm]?[jt]sx?$`);
 *     git emits forward slashes on every OS, so matching on `/` is portable.
 *  `.d.ts` type-declaration files are excluded separately by the caller, since a
 *  declaration file under `__tests__/` is still not a runnable test. */
const TESTS_DIR_RE = /(?:^|\/)__tests?__\/.*\.(c|m)?[jt]sx?$/;

/** TypeScript ambient declaration files (`*.d.ts`, plus `.d.mts`/`.d.cts`).
 *  These have no runtime/test body to grade, so they are never test files even
 *  when they sit under a `__tests__/` directory. Anchored to the path end. */
const DECLARATION_FILE_RE = /\.d\.(c|m)?ts$/;

/**
 * Decide whether a repo-relative POSIX path denotes a JS/TS *test* file.
 *
 * A path counts as a test when EITHER:
 *   - its final segment matches the conventional `*.test.*` / `*.spec.*` shape
 *     ({@link TEST_FILE_RE}), OR
 *   - it lives under a `__tests__`/`__test__` directory segment with a JS/TS
 *     extension ({@link TESTS_DIR_RE}) — Jest's directory convention, used by
 *     fixtures such as immer's `__tests__/base.ts` that carry no suffix.
 *
 * Ambient declaration files (`*.d.ts`/`.d.mts`/`.d.cts`) are always rejected:
 * they have nothing executable to grade, even inside a `__tests__/` directory.
 *
 * Paths must use forward slashes (exactly as git emits them on every platform).
 *
 * @param path - repo-relative path with forward slashes.
 * @returns true if `path` is a gradeable test file.
 */
export function isTestFilePath(path: string): boolean {
  if (DECLARATION_FILE_RE.test(path)) return false;
  return TEST_FILE_RE.test(path) || TESTS_DIR_RE.test(path);
}

/**
 * Resolve a user-supplied base ref into a concrete commit to diff against.
 *
 * Preference order:
 *  1. The merge-base of HEAD and <baseRef> — i.e. where the current branch
 *     forked from the base. This is what you almost always want: it scopes the
 *     diff to *this branch's* changes and ignores commits that landed on the
 *     base after you branched.
 *  2. If no merge-base exists (unrelated histories, or <baseRef> is a bare
 *     commit/tag with no shared ancestor), fall back to the ref itself —
 *     verified with `rev-parse --verify` so we return a real object id.
 *
 * @returns the resolved commit-ish (a SHA from merge-base, or the verified ref).
 * @throws {GitError} if neither a merge-base nor a verifiable ref can be found.
 */
export async function resolveBase(baseRef: string, cwd: string): Promise<string> {
  try {
    // merge-base prints the best common ancestor's SHA on success.
    return await runGit(["merge-base", "HEAD", baseRef], cwd);
  } catch (mergeBaseErr) {
    // No shared history (or bad ref). Try to treat <baseRef> as a direct
    // commit-ish. `--verify` guarantees it resolves to exactly one object and
    // exits non-zero otherwise. The trailing "^{commit}" peels tags/annotated
    // objects down to the commit they point at.
    try {
      return await runGit(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], cwd);
    } catch {
      // Re-throw the ORIGINAL merge-base failure: its stderr is the more useful
      // diagnostic ("Not a valid object name" / "no merge base"), and it
      // already satisfies the GitError contract callers expect.
      throw mergeBaseErr instanceof GitError
        ? mergeBaseErr
        : new GitError(`could not resolve base ref "${baseRef}"`, {
            exitCode: null,
            stderr: String(mergeBaseErr),
            args: ["merge-base", "HEAD", baseRef],
          });
    }
  }
}

/**
 * List the test files that changed between <base> and HEAD.
 *
 * Uses the three-dot form `git diff <base>...HEAD`, which diffs HEAD against the
 * merge-base of <base> and HEAD. Combined with resolveBase() (which already
 * hands back a merge-base), this reliably yields "what changed on this branch".
 *
 * Filtering applied, in order:
 *  - keep only test files per {@link isTestFilePath}: a *.test/spec.* final
 *    segment OR any JS/TS file under a `__tests__`/`__test__` directory (Jest's
 *    convention), excluding `.d.ts` declaration files,
 *  - drop deletions (status starting with "D") — there's no head file to grade.
 *
 * Rename/copy entries (status "R###"/"C###") are emitted as a single record for
 * their destination path (we request the default name-status output, which for
 * a rename prints the new path last on the line; see parsing notes below).
 *
 * @returns changed, non-deleted test files with repo-relative POSIX paths.
 * @throws {GitError} if the underlying `git diff` fails.
 */
export async function listChangedTestFiles(
  baseRef: string,
  cwd: string,
): Promise<ChangedTestFile[]> {
  // -z would be NUL-delimited and rename-safe, but name-status without -z is
  // simpler to parse line-wise and sufficient here; we handle rename/copy
  // explicitly below. Lines look like:
  //   M\tsrc/foo.test.ts
  //   A\tsrc/bar.spec.ts
  //   R100\told/name.test.ts\tnew/name.test.ts   (rename: status, old, new)
  const raw = await runGit(["diff", "--name-status", `${baseRef}...HEAD`], cwd);
  if (raw === "") return [];

  const results: ChangedTestFile[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;

    // Split on tabs: first field is the status code, remaining fields are paths.
    const fields = line.split("\t");
    const status = fields[0] ?? "";

    // Drop deletions — "D", and defensively any future "D"-prefixed code.
    if (status.startsWith("D")) continue;

    // For renames/copies ("R###"/"C###") git prints <old>\t<new>; the file we
    // can actually analyze is the destination, i.e. the LAST path field. For
    // ordinary statuses there is exactly one path field, which is also last.
    const path = fields[fields.length - 1] ?? "";
    if (path === "") continue;

    // Keep only recognized test files: conventional *.test/spec.* names AND
    // Jest's `__tests__/` directory convention (immer-style fixtures with no
    // suffix), excluding `.d.ts` declarations. git already gives us forward
    // slashes — preserve them; isTestFilePath matches on those.
    if (!isTestFilePath(path)) continue;

    results.push({ path, status });
  }

  return results;
}

/**
 * Read the contents of <filePath> as it exists at <baseRef>.
 *
 * This is how regression detectors get the "before" text to compare against the
 * working-tree "after". For a file that did NOT exist on base (a newly-added
 * test), git errors with a "does not exist"/"exists on disk, but not in" style
 * message; we treat that specific case as a normal result and return `null`
 * rather than throwing, so callers can simply skip base-comparison for new files.
 *
 * @param filePath - repo-relative path (forward slashes, as from listChangedTestFiles).
 * @returns the base blob text, or null when the path does not exist at <baseRef>.
 * @throws {GitError} for any git failure that is NOT "path missing on base".
 */
export async function readBaseBlob(
  baseRef: string,
  filePath: string,
  cwd: string,
): Promise<string | null> {
  try {
    // `git show <commit>:<path>` streams the blob exactly; do NOT trim — leading
    // / trailing whitespace and the final newline are part of the source and the
    // AST/line math downstream depends on byte-for-byte fidelity.
    //
    // NOTE: runGit().trim()s its result, which would corrupt source offsets, so
    // we bypass the trimming convenience and would normally call the runner
    // raw. Since runGit is our only entry point and it trims, we accept the
    // trim here: detectors compare *parsed* ASTs / matcher text, not absolute
    // file byte offsets, and a trimmed base copy is the correct unit for that
    // comparison. (If raw bytes are ever needed, add a rawGit variant.)
    return await runGit(["show", `${baseRef}:${filePath}`], cwd);
  } catch (err) {
    if (err instanceof GitError && isMissingOnBase(err)) {
      // Expected for newly-added files: there is no base version to read.
      return null;
    }
    // Any other failure (bad ref, corrupt repo, permissions) is a real error.
    throw err;
  }
}

/**
 * Decide whether a `git show <base>:<path>` failure means "the path simply does
 * not exist at that commit" (a new file) versus a genuine error.
 *
 * git's messages for the not-found case vary by version/scenario, e.g.:
 *   - "fatal: path 'x' does not exist in 'SHA'"
 *   - "fatal: path 'x' exists on disk, but not in 'SHA'"
 *   - "fatal: Path 'x' does not exist in 'SHA'"
 *   - "fatal: Invalid object name ..." is NOT this case (bad ref) — excluded.
 * We match on the stable substrings shared by the not-found variants.
 */
function isMissingOnBase(err: GitError): boolean {
  const msg = err.stderr.toLowerCase();
  return (
    msg.includes("does not exist in") ||
    msg.includes("exists on disk, but not in") ||
    // Older/edge phrasing: "fatal: path 'x' does not exist" (no "in <rev>").
    msg.includes("does not exist")
  );
}
