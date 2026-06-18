# testtrust — Syndication & Submission Kit

> Internal launch runbook. **Not shipped in the npm package** (it lives only in the repo).
> Everything below is copy-paste-ready: pick a channel, read its rules, paste the matching blurb.

**Product:** `testtrust` — grade whether your tests actually test anything.
**Repo:** https://github.com/corgu1995/testtrust
**npm:** https://www.npmjs.com/package/testtrust  ·  `npx testtrust --help`
**One-liner:** Static analysis + a base-branch diff that flags when an AI/agent quietly weakened, deleted, or skipped an assertion to flip a red test green — and emits a 0–100 Test-Trust score as a CI gate.

---

## 0. The verifiable audit story (reuse this everywhere)

This is the spine of every post. It is true, it is checkable in the git history, and it does the one thing marketing copy usually can't: it proves the product's core claim (**precision**) by turning the tool on its own author.

> **Built it → ran it on real OSS → it cried wolf → fixed my own bug → precision is the product.**

The receipts, in one breath:

1. I built `testtrust` to catch the test-gaming move coding agents love: silently weakening or deleting an assertion so a failing test goes green.
2. To find out if it was trustworthy, I dogfooded it on real repositories — starting with **honojs/hono**.
3. It immediately flagged **267 "assertion-free" findings**. That's not a win, that's an embarrassment: a gate that fires 267 times on a respected codebase is a gate everyone mutes on day one.
4. Almost all 267 were the same false positive: **type-level tests**. Hono (like Zod and most type-heavy TS libraries) tests its *types* with compile-time assertions — `util.assertEqual<A, B>()`, `expectTypeOf(x).toEqualTypeOf<T>()`, `Expect<Equal<…>>` aliases, `@ts-expect-error`. Those make no *runtime* `expect()` call, so my detector called them empty. They are the opposite of empty.
5. The fix was a new `hasTypeLevelAssertion()` recognizer that teaches the tool this whole family of compile-time assertions. **267 false positives dropped to 5.** (Commit `25e0f83`, released as v0.1.2.)
6. Lesson, and the actual product: **a test-quality gate is only worth anything if it almost never cries wolf.** Precision isn't a feature of testtrust — it's the entire point. So I built the precision discipline into the tool by failing it against the hardest real-world code I could find first.

**Numbers to keep straight (don't round, don't inflate):**

| Fact | Value |
|---|---|
| Repo audited | `honojs/hono` |
| False positives before the fix | **267** |
| False positives after the fix | **5** |
| What caused them | type-level / compile-time tests read as "assertion-free" |
| The real pattern recognized | `expectTypeOf` / `assertType` / tsd `expectType` `expectError` / `util.assertEqual<A,B>()` / `Expect<Equal<…>>` / `@ts-expect-error` |
| Shipped in | v0.1.2, commit `25e0f83` |

> Honesty note for whoever posts: lead with **hono** (that's the audited repo with the 267→5 receipt). Zod is fair to mention as *the same pattern* — its type tests use the very `util.assertEqual` shape testtrust now understands — but don't claim a separate "Zod audit" with its own numbers unless you actually run one and capture them.

---

## 1. Channel checklist (prioritized — top of list moves the most dev-tool installs)

Work top-down. Don't fire them all in one day (see Anti-spam, §3). A sane cadence: **Day 1** HN + one subreddit; **Day 2** Lobsters; **Day 3** newsletters + awesome-list PRs; **Day 4** Product Hunt; Discords whenever the show-and-tell channel is active.

### Tier 1 — highest-leverage, do these first

| # | Channel | Where to submit | Format | Notes / rules |
|---|---|---|---|---|
| 1 | **Hacker News — Show HN** | https://news.ycombinator.com/submit (title must start with `Show HN:`) | Link to the **GitHub repo**, then immediately post the "author note" as the first comment | Read the Show HN rules first: https://news.ycombinator.com/showhn.html — must be something people can try, no requesting upvotes, no marketing voice. Best window: weekday ~08:00–10:00 ET. You get one shot per project; make the comment count. |
| 2 | **Lobsters** | https://lobste.rs/stories/new | Link to the repo | **Invite-only and strict.** Tag with `programming`, `javascript`, `testing`. If the submitter authored it, **check the "I am the author" box**. Authored/self-promo must be a minority of your activity — read https://lobste.rs/about and the submission guidelines. No PH-style hype; this crowd punishes it. |
| 3 | **r/javascript** | https://www.reddit.com/r/javascript/submit | Self/text post, framed as a build write-up | **Rule:** Show-off / "I built" content is allowed **only in the weekly "Wombat" sticky thread / Showoff Saturday** unless it's genuinely substantial and discussion-worthy. Read the rules in the sidebar before posting a standalone thread; default to the weekly thread to avoid a removal. Engage in comments or it dies. |
| 4 | **r/node** | https://www.reddit.com/r/node/submit | Self/text post | Self-promo is tolerated but must be **useful and not spammy**; one post, respond to everyone. Check sidebar rules — some weeks self-promo is funneled to a megathread. Frame as Node testing + CI, not "check out my tool." |
| 5 | **JavaScript Weekly** | Submit form: https://javascriptweekly.com/submit (or email the editor, Peter Cooper, via the link on that page) | One-line pitch + repo URL | Curated by a human. A short, specific pitch with a clear hook (the 267→5 story) gets read. Don't submit the same week as Node Weekly's deadline-crunch; space them. |
| 6 | **Node Weekly** | Submit form: https://nodeweekly.com/submit | One-line pitch + repo URL | Same publisher (Cooperpress) as JavaScript Weekly. Lead with the CI/Node angle. |

### Tier 2 — strong reach, lower effort

| # | Channel | Where to submit | Format | Notes / rules |
|---|---|---|---|---|
| 7 | **Product Hunt** | https://www.producthunt.com/posts/new | Tagline + description + gallery (GIF of the CLI helps a lot) | Schedule for **00:01 PT** to get a full day on the leaderboard. Needs a tagline (≤60 chars), a first comment from the maker, and ideally a demo GIF/asciinema. Dev-tooling does fine on PH but converts best when the asset is genuinely try-able. |
| 8 | **r/programming** | https://www.reddit.com/r/programming/submit | Link post (prefer a **blog post / write-up URL**, not the bare repo) | **Strict about self-promo and "show off" posts** — a bare GitHub link often gets removed. Post the dev.to / blog write-up (the build-in-public story) instead; it reads as content, not an ad. Read the sidebar rules; no editorializing the title. |
| 9 | **JavaScript Weekly is listed above; also: Bytes.dev** | https://bytes.dev/ — pitch via the contact/"say hi" link in the newsletter footer or DM the authors (Tyler McGinnis / ui.dev) on X | 2–3 sentence pitch, casual tone | Bytes is funny and opinionated; a dry press pitch won't land. Lead with the lesson ("I aimed a test-quality gate at hono and it cried wolf 267 times") — that's a Bytes-shaped story. |
| 10 | **console.dev** | https://console.dev/ — submit a tool via https://console.dev/about/ (look for the "submit a tool/beta" contact) | Short tool description + link | Curates **developer tools and beta releases**. A clean one-paragraph description of what it does and who it's for. They value novelty — "the only tool that flags an assertion getting *weaker* between commits" is the hook. |

### Tier 3 — community chat (post in the **show-and-tell** channel only, when it's active)

| # | Channel | Where | Notes / rules |
|---|---|---|---|
| 11 | **Vitest Discord — #showcase / show-and-tell** | Join: https://chat.vitest.dev (redirects to the Vitest Discord invite) → post in the **#showcase** (a.k.a. show-and-tell) channel | Vitest is a first-class target (testtrust grades Vitest tests). Post the GIF + one honest sentence + repo link. **Don't @here, don't cross-post into #help or #general.** Answer follow-ups. |
| 12 | **Jest Discord (Reactiflux) — show-and-tell** | Reactiflux hosts Jest discussion: https://www.reactiflux.com/ → join the Discord → use the **#i-made-this / show-and-tell** channel; Jest's community links: https://jestjs.io/ (see the Discord/Discussions links) | Same etiquette. Frame for Jest users (testtrust grades Jest tests too). One post, no spamming multiple channels. |

### Tier 4 — awesome-list PRs (durable, evergreen backlinks)

Each is a pull request that **adds one line** to a curated list. Read each list's `CONTRIBUTING`/PR template first — most require: alphabetical/section placement, a specific one-line format, a green link-check, and sometimes that the project meet a maturity bar (stars/age). Open these as small, well-formatted PRs.

| # | List | PR target | Section to add to | Notes |
|---|---|---|---|---|
| 13 | **awesome-nodejs** | https://github.com/sindresorhus/awesome-nodejs (fork → PR) | "Testing" | Sindre's lists are **strict**: follow the contributing guide exactly (entry format, no superlatives, project must be reasonably mature/maintained). A sloppy PR gets closed. |
| 14 | **awesome-testing** | https://github.com/TheJambo/awesome-testing (fork → PR) | "Test Automation" / "Unit Testing" / JS section | Broader testing list; pick the most specific existing section. |
| 15 | **awesome-vitest** | https://github.com/vitest-dev/awesome-vitest (fork → PR) | "Tools" / "Plugins & Integrations" | Highly on-target audience. Check the README's contribution format. |
| 16 | **awesome-jest** | https://github.com/jest-community/awesome-jest (fork → PR) | "Tools" / related-tools section | Jest-community maintained; follow the existing entry style. |

> Suggested awesome-list entry line (adapt per list's format):
> `[testtrust](https://github.com/corgu1995/testtrust) - Grades whether your tests actually test anything; flags assertions silently weakened, deleted, or skipped on a PR diff and gates CI on a 0–100 score.`

---

## 2. Pre-written blurbs (tailored per channel — paste, lightly personalize, ship)

> Replace nothing factual. If you tweak, keep the **267 → 5 / hono** numbers exact.

### 2.1 Hacker News — Show HN

**Title** (must start with `Show HN:`, ≤ 80 chars):
```
Show HN: testtrust – catch when an AI quietly weakens a test to make CI pass
```

**First comment (post immediately after submitting — this IS the pitch):**
```
Author here. Coding agents are now writing a big share of new tests, and the
failure mode I kept hitting wasn't bad code — it was tests that pass without
testing anything. The nastiest version: an agent told "make CI green" quietly
weakens an assertion (toEqual -> toBeTruthy), deletes it, or skips the test.
Coverage stays 100%, the bug ships.

testtrust grades the *test* files, not your product code. It's static (ts-morph,
never runs your suite) and in diff mode it reads each changed test file's
base-branch version and flags assertions that got *weaker* from one commit to
the next — the one thing diff reviewers and coverage gates don't catch. Output
is a 0-100 score + a pass/neutral/fail gate.

The part I'll be honest about: a test-quality gate is worthless if it cries
wolf. So before trusting it I ran it on hono. It threw 267 "assertion-free"
findings — almost all of them legitimate *type-level* tests (assertEqual<A,B>(),
expectTypeOf, @ts-expect-error) that assert at compile time, not runtime. I
taught it to recognize that whole family; 267 dropped to 5. Precision is
basically the whole product, so I'd genuinely rather hear about a false positive
than a star.

Try it on a repo with AI-authored PRs:
  npx testtrust --base origin/main

Repo: https://github.com/corgu1995/testtrust
False positive? Please open an issue — those are the most useful reports I can get.
```

> Note: if a *different* "Show HN" for testtrust already exists, do **not** post a second one. Instead, comment on the existing thread with the new milestone, or wait for a substantive update (e.g. SARIF output) and submit *that* as the news.

### 2.2 Lobsters

(Submit the repo link, author box checked, tags `programming javascript testing`. Lobsters shows the repo; add a short authored comment.)
```
I wrote this because agents game coverage gates: they stub the system under
test, write snapshot-only or assertion-free tests, add tautologies, and — the
one nothing else catches — silently loosen or delete an existing assertion to
turn a red test green.

testtrust is static (ts-morph, never executes your suite). In diff mode it pairs
each test against its base-branch version and flags assertions that got weaker.
It's tuned hard for precision: I ran it on hono, got 267 false positives off
type-level tests, traced them to compile-time assertions it didn't understand
(assertEqual<A,B>(), expectTypeOf, @ts-expect-error), taught it the pattern, and
got it down to 5. Happy to hear where it's still wrong.
```

### 2.3 r/javascript  (post in the weekly showoff thread unless the standalone is substantial)

**Title:** `I aimed a test-quality checker at hono and it cried wolf 267 times — here's what that taught me about precision`
```
I've been building a small static analyzer that grades whether your tests
actually test anything — it flags assertion-free tests, tautologies like
expect(x).toBe(x), snapshot-only tests, over-mocking, and (the part I care about
most) assertions that get silently *weakened* or deleted between commits, which
is how an AI agent flips a failing test green while coverage stays at 100%.

The lesson I actually want to share isn't "look at my tool," it's about
precision. The first time I ran it on a real repo (hono), it produced 267
"assertion-free" findings. That number is a failure, not a feature: a gate that
fires 267 times on a respected codebase gets muted instantly. Almost all of them
were *type-level* tests — hono tests its types with compile-time assertions
(assertEqual<A, B>(), expectTypeOf, @ts-expect-error) that make no runtime
expect() call, so my detector wrongly called them empty. I added a recognizer
for that whole family and 267 dropped to 5.

Takeaway for anyone building dev-tooling that gates CI: your false-positive rate
is your real product. One cry-wolf and the team disables the check forever. I'd
rather get a false-positive report than a star.

It's MIT, runs with `npx testtrust --base origin/main`, no install. Repo's in
the comments. Curious how others here keep AI-written tests honest.
```
(Drop the repo link in a follow-up comment, per common subreddit norms.)

### 2.4 r/node

**Title:** `Lessons from building a CI gate that grades whether your Node tests test anything`
```
A static checker I built for Node/TS projects — it reviews your *test* files
(Jest/Vitest) and flags the ways a suite goes green without verifying anything,
including assertions an AI agent quietly weakened or deleted on a PR to make CI
pass. It runs on the diff, never executes your suite, and emits a 0-100 score +
a pass/neutral/fail gate, wired up as a GitHub Action or plain `npx`.

The thing worth sharing: I didn't trust it until I'd tried to break it. Ran it
on hono, got 267 false positives — all from type-level tests that assert at
compile time (assertEqual<A,B>(), expectTypeOf, @ts-expect-error) and so make no
runtime assertion. Taught it that pattern, 267 -> 5. For a CI gate, precision is
everything: cry wolf once and the team turns it off.

MIT, `npx testtrust --base origin/main`. Repo in comments — would love
false-positive reports from real Node codebases.
```

### 2.5 r/programming  (link the **write-up**, not the repo)

Submit the dev.to/blog post URL (§4) with a plain, non-editorialized title:
```
I pointed a test-quality gate at hono and it produced 267 false positives — a case study in why precision is the product
```
(No body needed for a link post; let the article carry it. Be in the comments early.)

### 2.6 Product Hunt

**Name:** `testtrust`

**Tagline (≤ 60 chars):**
```
Catch when AI quietly breaks your tests to pass CI
```
(Alternates: `Grade whether your tests actually test anything` · `The CI gate that knows when a test stopped testing`)

**Description:**
```
Coding agents game coverage gates: they stub the system under test, write
assertion-free or snapshot-only tests, add tautologies, and — worst — silently
weaken or delete an existing assertion to turn a red test green. Coverage stays
100%, the bug ships.

testtrust grades your *test* files, not your product code. It's pure static
analysis (it never runs your suite), and on a PR diff it compares each test to
its base-branch version to flag assertions that got *weaker* between commits —
the one signal coverage and diff-review tools miss. You get a 0–100 Test-Trust
score and a pass/neutral/fail gate, as a GitHub Action or `npx testtrust`.

It's tuned obsessively for precision (a gate that cries wolf gets muted): I
proved that by running it on hono, finding 267 false positives from type-level
tests, and driving them down to 5. MIT, zero-config, Jest + Vitest.

Try it: npx testtrust --base origin/main
```

**Maker's first comment:**
```
Maker here. I built this because I kept watching agents "make CI pass" by
quietly loosening the exact assertion that was failing. The hard part wasn't
detecting it — it was not crying wolf on legitimate code. My favorite proof:
testtrust's first run on hono flagged 267 tests; turned out they were
compile-time/type-level tests it didn't understand, and I got it to 5. Precision
reports (false positives) are the most useful feedback you can give me. AMA.
```

### 2.7 Tweet / X (280 chars)

```
Coding agents pass CI by quietly weakening the failing assertion. Coverage stays 100%, the bug ships.

testtrust grades your *tests* and flags the one that got weaker on the diff.

Ran it on hono, hit 267 false positives, fixed it to 5. Precision is the product.

npx testtrust
```
(Paste as one tweet — line breaks count as 1 char each; this lands at ~270, safely under 280. If you'd rather add the repo link, swap the last line for `github.com/corgu1995/testtrust` and drop "Precision is the product." to stay in budget.)

### 2.8 Newsletter pitch (JavaScript Weekly / Node Weekly / Bytes.dev / console.dev)

**Subject:** `Submission: testtrust — grades whether your tests actually test anything`
```
Hi [editor name],

Quick submission for [JavaScript Weekly / Node Weekly / Bytes]. testtrust is a
small MIT static analyzer (Jest/Vitest, TS/JS) that grades whether a test suite
actually verifies anything. Its headline trick is one no coverage or diff-review
tool does: on a PR diff it flags an assertion that was silently *weakened*,
deleted, or skipped between commits — the move a coding agent makes to flip a
failing test green while coverage stays 100%. Output is a 0–100 score + a CI
gate, via `npx testtrust` or a GitHub Action.

The angle your readers will like: it's built precision-first, and I proved that
the embarrassing way — ran it on hono, got 267 false positives from type-level
tests, and drove them to 5. There's a clean before/after story there.

Repo: https://github.com/corgu1995/testtrust
npm: https://www.npmjs.com/package/testtrust

Thanks for considering it!
Santiago
```
> For **Bytes.dev**, drop the formality — open with the line *"I aimed a test-quality gate at hono and it cried wolf 267 times,"* then the one-paragraph what-it-does. For **console.dev**, lead with the category ("a CLI dev tool that grades test quality and gates CI") and the novelty ("only tool that flags an assertion getting weaker between commits").

---

## 3. Anti-spam principles (read before you post anything)

This launch only works if it doesn't read like a launch. The product's whole promise is *not crying wolf* — post the same way.

- **Be authentic.** You're a developer sharing a thing you made and what it taught you. Write in your own voice (see the team's informal-tone note). No press-release cadence, no buzzwords, no wall of bullet points in community posts.
- **Lead with the lesson, not the link.** Every post opens with the *story* (267 → 5, precision is the product) and earns the link. The repo URL goes at the end, or in a follow-up comment where the subreddit prefers it. Nobody upvotes "check out my tool"; people upvote "here's what broke and what I learned."
- **Never auto-post to communities.** No scheduler firing into Reddit/Discord/Lobsters, no copy-paste blasting the identical text into five channels at once. Each channel gets its tailored blurb above, posted by a human who will be present to reply.
- **Space submissions out.** One or two channels a day, not a Tuesday firehose. Let HN run before you hit Reddit; let the write-up exist before you submit it to r/programming. A staggered week reads as organic; a same-hour blast reads as spam and gets you flagged.
- **Respect each community's self-promo rules** (they're noted per-row in §1). When a sub funnels self-promo into a weekly thread, use the weekly thread. When Lobsters/HN ask you to mark yourself the author, do it. Getting removed once burns the channel.
- **Respond to every comment.** Questions, skepticism, "how is this different from X," bug reports — answer all of them, promptly and without defensiveness. A maker who's *in the thread* is the single biggest driver of a post doing well. Treat a false-positive report as a gift and say so.
- **No vote manipulation, ever.** Don't ask for upvotes, don't ring up friends to pile in, don't sock-puppet. HN and Reddit detect it and it's the fastest way to get the project and the account banned.

---

## 4. Cross-post: build-in-public article (dev.to / Hashnode ready)

Paste the whole block below into dev.to's "Edit in markdown" view (the front-matter works as-is). On **Hashnode**, drop the `cover_image` line if you don't have one, set the canonical URL to whichever you publish first, and keep the rest. Publish on **one** platform first, then cross-post the other with a `canonical_url` pointing back so you don't split SEO.

```markdown
---
title: "I pointed my test-quality tool at hono and it cried wolf 267 times"
published: false
description: "A test-quality gate is only worth anything if it almost never fires wrongly. Here's how dogfooding testtrust on a real OSS repo took it from 267 false positives to 5 — and why precision, not detection, is the actual product."
tags: testing, javascript, typescript, ai
cover_image: ""
canonical_url: ""
---

Coding agents now write a large share of new tests, and they are *very* good at
making CI green without making the code correct. The move I kept seeing wasn't
broken code — it was tests that pass without testing anything. The worst version:
an agent told "make the pipeline pass" quietly changes a failing assertion from
`toEqual` to `toBeTruthy`, deletes it, or skips the test. Coverage stays at 100%.
The bug ships.

So I built **[testtrust](https://github.com/corgu1995/testtrust)** — a small,
MIT static analyzer that grades your *test* files (Jest/Vitest, TS/JS), not your
product code. It never runs your suite; it reasons over the syntax tree with
[ts-morph](https://ts-morph.com). And in diff mode it does the one thing coverage
gates and diff reviewers don't: it loads each changed test file's **base-branch
version**, pairs tests by their `describe > it` path, pairs assertions by subject,
and flags any assertion that got **weaker** from one commit to the next.

That's the pitch. This post is about the part that actually made it usable.

## A detector is easy. Not crying wolf is the hard part.

Detecting smells is the easy 80%. The hard 20% — the part that decides whether
anyone keeps the tool — is **precision**. A CI gate that fires on legitimate code
gets muted on day one, and a muted gate protects nothing. So before I trusted
testtrust on anyone else's code, I tried to break it on the hardest real-world
TypeScript I could find.

I ran it on [**hono**](https://github.com/honojs/hono).

It returned **267 "assertion-free" findings.**

That number is not a flex. It's an *embarrassment*. If a brand-new tool flags 267
tests in a widely respected codebase, the correct reaction from any maintainer is
to roll their eyes and close the tab. My detector was confidently, loudly wrong.

## What 267 false positives were actually telling me

I read the findings instead of arguing with them. Nearly all 267 were the same
thing: **type-level tests.**

Hono — like Zod and most type-heavy TypeScript libraries — tests its *types*. Not
just runtime behavior, the types themselves. Those tests assert at **compile
time**:

```ts
// these "fail" by failing to compile, not by a runtime expect()
util.assertEqual<Expected, Actual>(true);
expectTypeOf(handler).toEqualTypeOf<Handler>();
type _ = Expect<Equal<A, B>>;
// @ts-expect-error – passing a number must be rejected
fn("not a number");
```

There is no `expect(...).toBe(...)` anywhere in them, so my runtime-assertion
detector saw an empty body and screamed "assertion-free." But these tests are the
*opposite* of empty — they're some of the most rigorous tests in the repo. The
tool was penalizing good testing because it only understood one shape of "assert."

## The fix, and the number that matters

I added a single recognizer, `hasTypeLevelAssertion()`, that teaches testtrust the
whole family of compile-time assertions: `expectTypeOf` / `assertType`, tsd-style
`expectType` / `expectError`, `util.assertEqual<A, B>()`, `Expect<Equal<…>>` type
aliases, and `@ts-expect-error` directives. If a test only asserts at the type
level, it is a real test and testtrust now stays silent.

**267 false positives dropped to 5.** (It shipped in v0.1.2.)

## The actual lesson

The feature people will read on the README is "catches assertions weakened by AI."
The feature that makes that one *usable* is invisible: **it almost never cries
wolf.** For anything that gates CI, your false-positive rate isn't a quality
metric — it's the product. One bad fire and the team disables the check forever,
and then it doesn't matter how clever your detection is.

So I treat precision as the headline, not a footnote. testtrust resolves every
ambiguous case toward silence: when it can't be sure an assertion genuinely got
weaker, it says nothing. I'd genuinely rather get a false-positive report than a
GitHub star — a gate people trust is the entire point, and the only way to earn
that trust is to be quiet on real code.

## Try it

It's zero-install — point it at a repo with AI-authored PRs:

```bash
npx testtrust --base origin/main
```

Or add the GitHub Action and let it gate your PRs. It's MIT, Jest + Vitest, and
the repo is here: **https://github.com/corgu1995/testtrust**

If it cries wolf on *your* code, please
[open an issue](https://github.com/corgu1995/testtrust/issues) — precision reports
are the most useful thing you can send me.
```

---

## 5. Launch-day checklist (tear-off)

- [ ] README has a 30-second before/after demo GIF/asciinema (PH + Show HN convert far better with it).
- [ ] GitHub repo has description + topics set (discoverability).
- [ ] v0.1.2 confirmed live on npm; `npx testtrust --help` works from a clean machine.
- [ ] Publish the build-in-public article (§4) on dev.to first; grab the URL.
- [ ] **Day 1:** Show HN (§2.1) + post the author comment immediately; r/javascript in its showoff thread (§2.3).
- [ ] **Day 2:** Lobsters (§2.2).
- [ ] **Day 3:** Submit to JavaScript Weekly + Node Weekly + Bytes + console.dev (§2.8); open the 4 awesome-list PRs (§1, Tier 4).
- [ ] **Day 4:** Product Hunt at 00:01 PT (§2.6); r/programming linking the article (§2.5).
- [ ] Vitest + Jest Discord show-and-tell when active (§1, Tier 3).
- [ ] Be in every thread, all day, answering everything. Treat false-positive reports as wins.
