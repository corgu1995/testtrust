# Roadmap

`testtrust` grades whether your tests actually test anything. **v0.1.0 is on npm
and GitHub today**: 9 detectors (including the diff-mode regression wedge that
catches assertions silently weakened / deleted / skipped), a 0–100 Test-Trust
score, human + JSON output, inline `// testtrust-disable-next-line` suppression,
and a composite GitHub Action.

From here the priority is **adoption, not features**. Near-term work is
distribution plus the smallest changes that remove adoption friction; later
phases are gated on real usage signal rather than built speculatively.

## Now
- [x] `npx testtrust` as the primary documented path
- [ ] GitHub Release for `v0.1.0`
- [ ] Repo description + topics for discoverability
- [x] Green CI (lint · typecheck · build · dogfood · tests)

## Phase 1 — Validate demand (next few weeks)
Goal: the first ~10 real users, and a few who keep it in CI.
- [ ] "Test-trust audits" of popular OSS repos with heavy AI-authored PRs, published as content
- [ ] Launch posts (Show HN, r/ExperiencedDevs, dev.to)
- [ ] A 30-second before/after demo (GIF / asciinema) in the README
- [ ] **Signal to watch:** do people install *and keep* it? Does anyone make it a required check?

## Phase 2 — Deepen the OSS product (driven by Phase-1 feedback)
- [ ] **SARIF output** → findings in GitHub code-scanning / PR annotations
- [ ] **Config file** (`.testtrustrc`) + **baseline/suppression store** so legacy repos adopt incrementally
- [ ] New detectors: floating-async-assertion (missing `await`), duplicate-test-title, empty-test-body, swallowed-error
- [ ] More frameworks: `node:test`, Mocha, Jasmine
- [ ] Monorepo / repo-root resolution in diff mode

## Phase 3 — Layer 2: mutation testing (the deep moat)
- [ ] A changed-lines [StrykerJS](https://stryker-mutator.io/) wrap → a real "would your tests
      catch a planted bug?" score folded into Test-Trust. Built only **after** Layer 1 has adoption,
      which proves both precision and demand.

## Phase 4 — Open-core (only if traction shows)
- [ ] Hosted gate: a GitHub App with per-org / per-agent test-trust history and org policy as a
      paid tier, on top of the free CLI.

---

Have an idea, or hit a **false positive**? [Open an issue](https://github.com/corgu1995/testtrust/issues) —
precision reports are especially welcome, since a gate people trust is the whole point.
