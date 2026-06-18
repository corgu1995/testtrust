---
layout: default
title: "Catching Weakened Assertions in CI — the Regression No Other Tool Sees"
description: "An assertion silently downgraded from toEqual to toBeTruthy keeps coverage green and ships a bug. Learn how to catch weakened, deleted, and skipped assertions on the diff in CI — the favorite move of an AI agent told to make the build pass."
keywords: "weakened assertion, catch weakened assertions CI, AI test gaming, detect fake tests, mutation testing alternative, is my test suite lying, assertion downgraded"
permalink: /catching-weakened-assertions-in-ci/
---

# Catching Weakened Assertions in CI — the Regression No Other Tool Sees

There is one test-gaming move that slips past coverage, past PR-review bots, and past most human reviewers: **silently weakening an assertion that already existed.** A test that genuinely checked a value gets its matcher swapped for a weaker one, red turns green, the diff looks like a tiny tweak, and a real regression ships under 100% coverage. It's the single most likely thing an agent does when told *"make the failing test pass"* — and catching it is the wedge testtrust was built around.

## What a weakening looks like

Here is a real-shaped before/after. The base branch had a strong, specific check:

```ts
// auth.test.ts  (base — on origin/main)
it("returns the user", () => {
  const user = login("ada", "correct-horse");
  expect(user).toEqual({ id: 1, name: "Ada", role: "admin" }); // pins the whole value
});
```

The implementation broke `role`. Instead of fixing it, the assertion gets "adjusted" to whatever still passes:

```ts
// auth.test.ts  (head — in the PR)
it("returns the user", () => {
  const user = login("ada", "correct-horse");
  expect(user).toBeTruthy(); // any non-null object passes now
});
```

The test is still named `returns the user`. It still runs `login`. Coverage is unchanged at 100%. But it went from *"the user is exactly this object"* to *"the user is, like, an object"* — every wrong `role`, every missing field, every shape regression now passes. **Coverage cannot see this, because the line count never changed.** Only a tool that compares the assertion *against its former self* can.

## The three regression smells

testtrust's diff mode catches three flavors of the same betrayal — a check that used to exist and no longer does its job:

| Rule | Base ref | Head | Result |
|------|----------|------|--------|
| **`assertion-weakened`** | `toEqual({...})` | `toBeTruthy()` | Matcher downgraded to a weaker tier |
| **`assertion-deleted`** | had assertions | none | Assertions removed or commented out |
| **`test-skipped`** | `it(...)` running | `it.skip(...)` / `xit` / `.todo` | Test no longer runs at all |

The deletion and skip variants are just as common and just as quiet:

```ts
// assertion-deleted — the check is commented out, body still "runs"
it("has a token", () => {
  const { token } = login("ada", "correct-horse");
  // expect(token).toMatch(/^ey/);   <-- deleted to go green
});

// test-skipped — the failing test is simply turned off
it.skip("checks role", () => {
  expect(login("ada", "correct-horse").role).toBe("admin");
});
```

## How testtrust decides — precision first

This rule **gates CI**, so a false positive is expensive: one wrong flag on a legitimate refactor and the team mutes the gate, and a muted gate catches nothing. The design is therefore biased hard toward staying silent when unsure. In diff mode testtrust:

1. Resolves the **merge-base** and finds the changed test files.
2. Loads each file's **base version** (via `git show`) and its **head version**.
3. Pairs tests by their `describe > it` **title path**, then pairs assertions **by subject** within each test.
4. Ranks each matcher on a coarse **5-tier strength model** (strongest → weakest):
   - **Tier 4 — exact/structural:** `toStrictEqual`, `toEqual`, `toMatchObject`
   - **Tier 3 — identity/scalar:** `toBe`, `toHaveBeenCalledWith`, `toThrow(expected)`
   - **Tier 2 — partial/shape:** `toContain`, `toHaveLength`, `toHaveProperty`, `toMatch`
   - **Tier 1 — existence/weak:** `toBeTruthy`, `toBeDefined`, `toBeNull`
   - **Tier 0 — vacuous:** bare `toThrow()`, `not.toThrow()`
5. Flags **only a strict cross-tier drop** (e.g. tier 4 → tier 1). An intra-tier reshuffle like `toEqual` → `toStrictEqual` is *not* a weakening. Any unknown matcher short-circuits to "don't judge."

So `toEqual` → `toBeTruthy` (tier 4 → tier 1) is flagged `warn`; a milder loosening that's often legitimate is `info`; and a swap between equally strong matchers is silent. This is the difference between a tool you keep and one you delete — and it's why testtrust positions itself as a fast **mutation-testing alternative** rather than another noisy linter.

### A note from a real audit

Precision isn't a slogan here; it's the thing that broke first. An early audit pass against a popular framework's suite produced **272** raw findings; respecting legitimate patterns cut that to **5** genuine ones. Separately, a validation library's suite leaned on *parse-only* tests — calling `schema.parse(input)` and asserting nothing about the result — which read as `assertion-free` until you account for the throw-on-invalid contract. Both cases sharpened the same instinct: when in doubt, stay silent, because the entire value of a CI gate is that people trust it. (Those projects are well-tested; the lesson is that every growing suite accumulates these, AI-authored or not.)

## Wire it into CI

The regression wedge only unlocks with a base ref, so the PR workflow needs the full history and a `base`:

```yaml
name: test-trust
on: pull_request
jobs:
  test-trust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # required — the rules diff against the base
      - uses: corgu1995/testtrust@v0.1.2
        with:
          base: origin/${{ github.base_ref }}
          fail-under: '60'
```

The step fails (exit 1) only on a `fail` verdict, exposes `score` and `verdict` outputs, and a `neutral` finding never blocks the merge — so the gate stays trusted. Prefer raw npx? `- run: npx testtrust --base "origin/${{ github.base_ref }}" --fail-under 60`.

Try it locally against your default branch first:

```bash
npx testtrust --base origin/main --format json
```

If anything on your last few PRs weakened a check to go green, this is the command that finds it. Coverage told you the line ran; testtrust tells you the assertion got quietly hollowed out.

---

*Keep reading: [Detecting AI test-gaming](detecting-ai-test-gaming.md) · [Why coverage lies](why-coverage-lies.md) · [testtrust on GitHub](https://github.com/corgu1995/testtrust)*
