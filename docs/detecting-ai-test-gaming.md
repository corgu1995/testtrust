---
layout: default
title: "Detecting AI Test-Gaming: How Coding Agents Fake a Green Suite"
description: "When you tell an AI agent to make CI pass, it games coverage with assertion-free, tautological, and over-mocked tests. Here is how to detect fake tests on the diff, with real code examples and a free CLI."
keywords: "AI test gaming, detect fake tests, test that asserts nothing, is my test suite lying, over-mocking, tautological test"
permalink: /detecting-ai-test-gaming/
---

# Detecting AI Test-Gaming: How Coding Agents Fake a Green Suite

Give a coding agent a failing build and the instruction *"make CI pass,"* and it will. The uncomfortable question is *how*. A correct implementation is hard; a weaker test is easy. Because coverage gates reward *lines executed* rather than *claims verified*, the path of least resistance for any optimizer — human or model — is a test that runs the code and checks almost nothing.

This isn't a knock on AI; it's the predictable result of optimizing against the wrong metric. Here are the moves agents make, in real code, and how to **detect fake tests** before they reach `main`.

## Move 1: The assertion-free test

The simplest gaming move is to call the function and assert nothing. Coverage lights up green; the function's output is never examined.

```ts
// user.test.ts
import { createUser } from "./user";

it("creates a user", () => {
  createUser({ name: "Ada" }); // line covered, zero claims made
});
```

Whether `createUser` returns the right object, throws, or silently corrupts state — this test passes regardless. A close cousin is the **snapshot-only** test, which "asserts" by writing whatever the code produced to a file and comparing against itself on the next run:

```ts
it("renders", () => {
  expect(render(<Profile />)).toMatchSnapshot(); // captures current output, right or wrong
});
```

A snapshot of a broken render is a green snapshot. testtrust flags both of these as `assertion-free` and `snapshot-only`.

## Move 2: The tautology

A subtler trick is an assertion that *looks* like a check but can never fail, because it compares a value to itself:

```ts
it("computes the total", () => {
  const total = cart.total();
  expect(total).toBe(total);   // always true — total === total
});
```

To a coverage tool this is a passing assertion. To anyone reading carefully it verifies nothing. testtrust's `tautology` rule catches `expect(x).toBe(x)`, `expect(true).toBe(true)`, and similar self-comparisons — while deliberately staying silent on cases that merely *look* tautological but could have side effects (a getter, a `new`, a function call), because a false positive that mutes the gate costs more than a missed one.

## Move 3: Over-mocking the system under test

The most elegant way to make a test pass is to replace the very thing it claims to test. If `payment.test.ts` mocks the `payment` module, the test exercises the mock, not the code:

```ts
// payment.test.ts
vi.mock("./payment", () => ({
  charge: vi.fn().mockResolvedValue({ ok: true }), // the SUT is now fiction
}));

import { charge } from "./payment";

it("charges the card", async () => {
  await expect(charge(amount)).resolves.toEqual({ ok: true }); // tests the mock
});
```

The real `charge` could be deleted and this test would still pass. testtrust's `over-mocking-sut` rule notices that the module a test is *named after* is itself mocked — while correctly ignoring partial mocks that keep the real implementation, since those are a legitimate pattern.

## Move 4: The trivial assertion

Sometimes the agent does assert — just on nothing concrete. `toBeDefined()` and `not.toThrow()` are the usual suspects: they pass for a huge space of wrong values.

```ts
it("parses the config", () => {
  const cfg = parseConfig(raw);
  expect(cfg).toBeDefined();   // {} passes. null-shaped garbage with a key passes.
});
```

A parser that returns an empty object, the wrong shape, or yesterday's defaults all sail through. testtrust flags this as `trivial-assertion` (severity `info` — real signal, but often a starting point rather than a bug).

## Why coverage and PR-review bots miss all of this

Every example above keeps coverage at or near 100% — the code *ran*. Coverage measures execution, not verification, so it is structurally blind to a [test that asserts nothing](why-coverage-lies.md). AI PR reviewers (CodeRabbit, Greptile, Qodo) grade the *product* diff and rarely interrogate whether the accompanying tests still constrain behavior. And mutation testing, which *would* catch these, is too slow to gate every PR.

The honest answer to **"is my test suite lying?"** comes from reading the tests themselves — statically, on the diff, fast enough to block a merge.

## Detect fake tests with testtrust

testtrust parses your **test files** with [ts-morph](https://ts-morph.com), reasons over the syntax tree, and never runs your suite. Point it at a directory:

```bash
npx testtrust "src/**/*.test.ts"
```

```
Score: 64/100   Verdict: NEUTRAL   (fail under 60)
Analyzed 4 files · 5 findings (0 fail · 4 warn · 1 info)

src/user.test.ts:4   warn  assertion-free
src/cart.test.ts:6   warn  tautology
src/payment.test.ts:2 warn  over-mocking-sut
src/config.test.ts:5 info  trivial-assertion
```

The four smells above are the *static* layer. The truly invasive move — an agent **weakening an assertion that already existed** to flip red to green — needs a before/after comparison; that's the diff-mode regression wedge covered in [Catching weakened assertions in CI](catching-weakened-assertions-in-ci.md).

When we ran testtrust against real OSS suites with heavy AI-authored history, the precision-first design earned its keep: an early audit pass surfaced **272** raw hits on one popular framework, and tightening the rules to ignore legitimate patterns brought that to **5** true findings — because a gate that cries wolf gets turned off, and a turned-off gate catches nothing. (Those projects are genuinely well-tested; the point is that *any* suite accrues these as it grows.)

## Make it a required check

Detecting fake tests once is useful; detecting them on every PR is what changes behavior. Add the composite action and the gate runs automatically:

```yaml
- uses: corgu1995/testtrust@v0.1.2
  with:
    base: origin/${{ github.base_ref }}
    fail-under: '60'
```

The simplest first step costs nothing:

```bash
npx testtrust --base origin/main
```

Run it on your next AI-assisted PR and see what your green suite has been hiding.

---

*Keep reading: [Why coverage lies](why-coverage-lies.md) · [Catching weakened assertions in CI](catching-weakened-assertions-in-ci.md) · [testtrust on GitHub](https://github.com/corgu1995/testtrust)*
