---
layout: default
title: "Why Code Coverage Lies — and What to Measure Instead"
description: "100% code coverage does not mean your tests work. Coverage counts lines executed, not behavior verified — so a test that asserts nothing scores the same as a real one. Here is why coverage lies and how to detect fake tests."
keywords: "why coverage lies, is my test suite lying, test that asserts nothing, mutation testing alternative, code coverage misleading, detect fake tests"
permalink: /why-coverage-lies/
---

# Why Code Coverage Lies — and What to Measure Instead

Code coverage is the most trusted number in testing and one of the most misleading. A suite at 100% coverage feels safe, gets a green badge, and passes review. But coverage answers a question almost no one is actually asking. It tells you **which lines ran while the tests executed** — not **whether any test would notice if those lines were wrong**. Those are wildly different claims, and the gap between them is exactly where bugs hide.

If you've stared at a 95% coverage report after a production incident and wondered **"is my test suite lying?"** — this is why.

## Coverage measures execution, not verification

Consider a function and a test that gives it "full" coverage:

```ts
// discount.ts
export function applyDiscount(price: number, pct: number) {
  return price - price * (pct / 100);
}
```

```ts
// discount.test.ts
import { applyDiscount } from "./discount";

it("applies a discount", () => {
  applyDiscount(100, 10); // every line of discount.ts now "covered"
});
```

This test executes 100% of `applyDiscount`. Coverage tools report success. Yet it asserts nothing — the function could return `NaN`, the original price, or a negative number and the test would still pass. **A [test that asserts nothing](detecting-ai-test-gaming.md) earns the same coverage as a perfect one.** Coverage cannot tell them apart, because counting executed lines is fundamentally not the same as checking results.

## The four ways a "covered" line is unguarded

Coverage stays green even when the verification is gone. The failure modes:

1. **No assertion at all.** The line ran; nothing examined the outcome (above).
2. **A tautological assertion** that can never fail:
   ```ts
   const out = applyDiscount(100, 10);
   expect(out).toBe(out); // out === out, always green
   ```
3. **A trivial assertion** that pins no concrete value:
   ```ts
   expect(applyDiscount(100, 10)).toBeDefined(); // -5, NaN, 90 — all "defined"
   ```
4. **A silently weakened assertion** — the most dangerous, because it *used* to be strong:
   ```ts
   // before:  expect(applyDiscount(100, 10)).toBe(90);
   // after:   expect(applyDiscount(100, 10)).toBeTruthy();  // any non-zero number passes
   ```

All four keep coverage at 100%. All four ship a broken `applyDiscount`. Coverage is blind to every one of them because each line still *executes* — the report is technically accurate and practically worthless.

## Why this got worse with AI

Coverage was a flawed proxy long before AI, but it degraded slowly: a human writing a lazy test still tended to glance at the output. The dynamic changed when agents started writing tests against a coverage target. Tell a model *"get CI green"* and the literal, lowest-effort solution is to execute the lines without constraining them. The metric becomes the target, and — per Goodhart's law — it stops being a good measure. You can read 100% coverage on a diff whose tests verify strictly less than they did a commit ago. That specific regression is covered in [Catching weakened assertions in CI](catching-weakened-assertions-in-ci.md).

## What to measure instead: claims, not lines

The metric you actually want is **"would a test fail if the behavior were wrong?"** Two tools answer it:

- **Mutation testing** is the rigorous version: it plants small bugs (mutants) in your code and checks whether any test fails. A mutant that survives is a line your suite doesn't really guard. It's the gold standard — and far too slow to run on every pull request, which is why almost no one gates on it.
- **Static test-quality analysis** is the fast version: instead of mutating code and re-running, it *reads the tests* and flags the ones that make no real claim. It can't prove a test catches a bug, but it reliably finds tests that assert nothing, assert a tautology, or just got weaker. As a **mutation-testing alternative** you can run on every PR, this is the pragmatic choice.

testtrust is the second kind. It parses your test files with [ts-morph](https://ts-morph.com), never executes your suite, and turns "is my test suite lying?" into a concrete 0–100 score with a `pass` / `neutral` / `fail` verdict.

## Put a real number next to coverage

Keep your coverage gate — it still catches *untested* code. Add testtrust to catch *fake-tested* code, the blind spot coverage can't see:

```bash
npx testtrust "src/**/*.test.ts"
```

```
Score: 58/100   Verdict: FAIL   (fail under 60)
Analyzed 3 files · 4 findings (0 fail · 3 warn · 1 info)

src/discount.test.ts:4  warn  assertion-free
  Test "applies a discount" runs code but asserts nothing.
```

In CI, run it on the diff so it also catches assertions that got weaker than the base branch:

```yaml
- uses: corgu1995/testtrust@v0.1.2
  with:
    base: origin/${{ github.base_ref }}
    fail-under: '60'
```

Coverage tells you the line ran. testtrust tells you whether anyone was watching when it did. The two together are honest; coverage alone is a green light with the bulb removed.

Start with one command on your repo:

```bash
npx testtrust --base origin/main
```

---

*Keep reading: [Detecting AI test-gaming](detecting-ai-test-gaming.md) · [Catching weakened assertions in CI](catching-weakened-assertions-in-ci.md) · [testtrust on GitHub](https://github.com/corgu1995/testtrust)*
