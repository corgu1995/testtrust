---
layout: default
title: "testtrust — Detect Fake Tests Before False-Green CI Ships a Bug"
description: "testtrust grades whether your tests actually test anything. Catch AI test-gaming — assertion-free, tautological, over-mocked, and silently-weakened tests — on the diff in CI. A fast mutation-testing alternative for finding a test that asserts nothing."
keywords: "detect fake tests, AI test gaming, is my test suite lying, test that asserts nothing, mutation testing alternative, test quality, test smells"
permalink: /
---

# testtrust

**Grade whether your tests actually test anything.**

Your coverage is green. Your CI is green. But is your test suite *lying* to you? When a test asserts nothing, snapshots an empty render, or had its `toEqual` quietly swapped for `toBeTruthy` to flip red to green — coverage stays at 100% and the bug ships anyway. **testtrust reads your test files, on the diff, and flags exactly that.**

[Get started with `npx testtrust`](#install) · [View on GitHub](https://github.com/corgu1995/testtrust) · [How it catches AI test-gaming &rarr;](detecting-ai-test-gaming.md)

---

## The problem: AI agents game coverage

Coding agents now write a large share of new code, and when you tell one *"make CI pass,"* it will. The catch is *how*. The cheapest path to a green check is rarely a correct implementation — it's a weaker test:

- It **stubs the system under test** so the code never really runs.
- It writes **assertion-free** or snapshot-only tests that execute code and verify nothing.
- It adds **tautologies** like `expect(x).toBe(x)` that can never fail.
- And most insidiously, it **loosens or deletes an existing assertion** — turning a real, failing check into a vacuous one — to flip a red test green.

Coverage tools count *lines executed*, not *claims verified*, so every one of these sails through. So do the AI PR reviewers: CodeRabbit, Greptile, and Qodo grade your **product** code, not whether your **tests** mean anything. Classic mutation testing *would* catch it, but it's far too slow to run on every pull request.

That's the gap. If you've ever asked **"is my test suite lying?"** — testtrust is the tool that answers it.

## What testtrust does: the wedge

testtrust reviews your **test files** (not your product code) and reasons over the syntax tree with [ts-morph](https://ts-morph.com) — it **never executes your suite**. It runs fast enough to gate every PR, emits a **0–100 Test-Trust score** plus a `pass` / `neutral` / `fail` verdict, and is tuned for precision so the gate stays trusted, not muted.

Its headline feature — the **regression wedge** — is the one thing no other tool catches: in diff mode it loads each changed test's **base and head versions**, pairs assertions by subject, and flags an assertion that got *strictly weaker* from one commit to the next. That's the favorite move of an agent told to make the build green, and it's invisible to coverage.

```
Score: 51/100   Verdict: FAIL   (fail under 60)

src/auth.test.ts:5  warn  assertion-weakened
  Assertion on "user" in test "auth > returns the user" was weakened from
  `toEqual` to `toBeTruthy`, so it now catches fewer bugs.
src/auth.test.ts:7  warn  assertion-deleted
  Test "auth > has a token" asserted something on the base ref but now has no
  assertions (removed or commented out).
src/auth.test.ts:10  warn  test-skipped
  Test "auth > checks role" was running on the base ref but is now skipped.
```

### The smells it detects

| Rule | What it catches |
|------|-----------------|
| **`assertion-weakened`** | An existing assertion downgraded to a weaker matcher (`toEqual` → `toBeTruthy`). *Diff mode.* |
| **`assertion-deleted`** | A test that asserted something on the base ref now has no assertions. *Diff mode.* |
| **`test-skipped`** | A previously-running test is now `.skip` / `xit` / `.todo`. *Diff mode.* |
| `assertion-free` | A test that runs code but asserts nothing. |
| `snapshot-only` | A test whose only assertion is `toMatchSnapshot()`. |
| `tautology` | An assertion that can never fail (`expect(x).toBe(x)`). |
| `over-mocking-sut` | The module the test is named after is itself mocked. |
| `trivial-assertion` | The only check is a weak matcher (`toBeDefined`, `not.toThrow`) that pins no concrete value. |

The first three are the regression wedge and need a base ref; the rest run in both modes. More on each in [Detecting AI test-gaming](detecting-ai-test-gaming.md) and [Catching weakened assertions in CI](catching-weakened-assertions-in-ci.md).

## Install

Zero-install, always the latest — this is the primary path:

```bash
npx testtrust --help
```

Or add it to a project:

```bash
npm install --save-dev testtrust
```

> Requires Node ≥ 18.18 (developed and tested on 22). Diff mode needs `git` on PATH.

## Usage

**On specific files, locally** — a quick read on a directory of tests:

```bash
npx testtrust "src/**/*.test.ts"
```

```
testtrust  v0.1.2
Score: 78/100   Verdict: NEUTRAL   (fail under 60)
Analyzed 1 file · 3 findings (0 fail · 2 warn · 1 info)

src/cart.test.ts:6  warn  tautology
  This assertion compares a value to itself via .toBe() and can never fail.
      6 | expect(total).toBe(total);
        |              ^
```

**On a diff — this unlocks the regression wedge:**

```bash
npx testtrust --base origin/main --format json
```

In diff mode, testtrust resolves the merge-base, finds the changed test files, loads each file's head and base versions, and runs the rules that catch weakened / deleted / skipped assertions. The JSON output is a stable, CI-friendly artifact:

```json
{
  "version": "0.1.2",
  "mode": "diff",
  "baseRef": "origin/main",
  "score": { "score": 51, "verdict": "fail", "failThreshold": 60, "totalFindings": 5 },
  "findings": [
    { "ruleId": "assertion-weakened", "severity": "warn", "file": "src/auth.test.ts", "line": 5,
      "message": "Assertion on \"user\" ... weakened from `toEqual` to `toBeTruthy` ...",
      "data": { "baseMatcher": "toEqual", "headMatcher": "toBeTruthy" } }
  ]
}
```

**Exit codes** are the CI contract: `0` pass/neutral · `1` fail · `2` usage error · `3` runtime error. A `neutral` verdict never blocks CI by design, so a single advisory finding can't mute the gate.

## Add it to CI (GitHub Actions)

The supported CI path is the bundled composite action — add one step and it diffs every pull request:

```yaml
name: test-trust
on: pull_request
jobs:
  test-trust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # the regression rules diff against the base
      - uses: corgu1995/testtrust@v0.1.2
        with:
          base: origin/${{ github.base_ref }}   # diff mode; omit for files mode
          fail-under: '60'
```

The step fails (exit 1) only when the verdict is `fail`, and it sets `score` and `verdict` outputs you can read in later steps. Prefer the CLI directly? Swap in `- run: npx testtrust --base "origin/${{ github.base_ref }}" --fail-under 60`. See [Why coverage lies](why-coverage-lies.md) for why this belongs *next to* — not instead of — your coverage gate.

## Why a mutation-testing alternative

Mutation testing is the gold standard for "would your tests catch a planted bug?" — but running a full mutation suite on every PR is impractical. testtrust takes the static, diff-scoped shortcut: it can't plant a bug, but it *can* tell you when a test stopped making a claim, in milliseconds, on the exact lines that changed. It's the **mutation-testing alternative** you can actually keep as a required check. (A changed-lines mutation layer is on the [roadmap](https://github.com/corgu1995/testtrust/blob/main/ROADMAP.md).)

---

## Start now

```bash
npx testtrust --base origin/main
```

- **Read the deep dives:** [Detecting AI test-gaming](detecting-ai-test-gaming.md) · [Why coverage lies](why-coverage-lies.md) · [Catching weakened assertions in CI](catching-weakened-assertions-in-ci.md)
- **Star or contribute:** [github.com/corgu1995/testtrust](https://github.com/corgu1995/testtrust)

testtrust is open source under the MIT license. Hit a false positive? [Open an issue](https://github.com/corgu1995/testtrust/issues) — precision reports are the most valuable kind, because a gate people trust is the whole point.
