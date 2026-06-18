// ============================================================================
// test/detectors/focusedTest.test.ts
//
// Unit spec for the "focused-test" detector (src/detectors/focusedTest.ts).
//
// Acceptance criteria under test:
//   AC1: each focusing construct produces exactly one finding —
//        it.only / fit / test.only (leaf focus) and describe.only / fdescribe
//        (suite focus) — at severity "warn".
//   AC2: a file with NO .only / focus alias produces zero findings.
//   AC3: severity defaults to "warn"; passing { severityOverride: "fail" }
//        (or "info") stamps the finding accordingly.
//   AC4: finding.testName is populated from the block's title path.
//   Extra: the finding lands on the focused block's call line, names the
//        construct, and multiple focuses each yield their own finding.
//
// The detector is read-only and synchronous; we drive it with inline source via
// the shared makeContext helper.
// ============================================================================

import { describe, expect, it } from "vitest";
import { detector } from "../../src/detectors/focusedTest.js";
import { makeContext } from "../helpers/context.js";

/** Run the detector over inline source with the given options. */
function runOn(src: string, options: Parameters<typeof detector.run>[1] = {}) {
  return detector.run(makeContext(src), options);
}

const RULE_ID = "focused-test" as const;

describe("focused-test detector", () => {
  describe("metadata", () => {
    it("exposes the frozen id, default severity and base requirement", () => {
      expect(detector.meta.id).toBe("focused-test");
      expect(detector.meta.defaultSeverity).toBe("warn");
      expect(detector.meta.requiresBase).toBe(false);
    });
  });

  // --- AC1: each focusing construct produces a finding -----------------------
  describe("AC1: flags every focus construct (leaf + suite)", () => {
    it("flags it.only", () => {
      const src = `
        import { expect, it } from "vitest";
        it.only("runs in isolation", () => {
          expect(compute()).toBe(1);
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.ruleId).toBe(RULE_ID);
      expect(finding.severity).toBe("warn");
      // Reports against the it.only(...) call line (3rd line here).
      expect(finding.line).toBe(3);
      expect(finding.testName).toBe("runs in isolation");
      expect(finding.message).toContain("it.only");
    });

    it("flags fit (the it.only alias)", () => {
      const src = `
        import { expect } from "vitest";
        fit("focused via alias", () => {
          expect(compute()).toBe(1);
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.ruleId).toBe(RULE_ID);
      expect(finding.severity).toBe("warn");
      expect(finding.testName).toBe("focused via alias");
      // The canonical `.only` spelling is reported even though the source used `fit`.
      expect(finding.message).toContain("it.only");
    });

    it("flags test.only", () => {
      const src = `
        import { expect, test } from "vitest";
        test.only("only this one", () => {
          expect(compute()).toBe(1);
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.ruleId).toBe(RULE_ID);
      expect(finding.severity).toBe("warn");
      expect(finding.testName).toBe("only this one");
      expect(finding.message).toContain("test.only");
    });

    it("flags describe.only (suite focus)", () => {
      const src = `
        import { describe, expect, it } from "vitest";
        describe.only("focused suite", () => {
          it("a", () => {
            expect(1).toBe(1);
          });
          it("b", () => {
            expect(2).toBe(2);
          });
        });
      `;
      const findings = runOn(src);

      // Only the describe.only is focused; its inner it() blocks are NOT
      // themselves `.only`, so exactly one finding (for the suite).
      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.ruleId).toBe(RULE_ID);
      expect(finding.severity).toBe("warn");
      expect(finding.testName).toBe("focused suite");
      expect(finding.message).toContain("describe.only");
    });

    it("flags fdescribe (the describe.only alias)", () => {
      const src = `
        import { expect, it } from "vitest";
        fdescribe("focused suite via alias", () => {
          it("a", () => {
            expect(1).toBe(1);
          });
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.ruleId).toBe(RULE_ID);
      expect(finding.severity).toBe("warn");
      expect(finding.testName).toBe("focused suite via alias");
      expect(finding.message).toContain("describe.only");
    });
  });

  // --- AC2: no focus => no findings ------------------------------------------
  describe("AC2: a file with no focus produces zero findings", () => {
    it("emits nothing for ordinary it()/describe() with no .only", () => {
      const src = `
        import { describe, expect, it } from "vitest";
        describe("group", () => {
          it("plain one", () => {
            expect(compute()).toBe(1);
          });
          it("plain two", () => {
            expect(other()).toBe(2);
          });
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("does not confuse .skip / .todo with .only", () => {
      const src = `
        import { describe, expect, it } from "vitest";
        describe("group", () => {
          it.skip("skipped", () => {
            expect(1).toBe(1);
          });
          it.todo("todo");
          xit("x-skipped", () => {
            expect(2).toBe(2);
          });
        });
      `;
      expect(runOn(src)).toHaveLength(0);
    });

    it("returns a stable empty array for a file with no test blocks", () => {
      const src = `
        export function compute() {
          return 1 + 1;
        }
      `;
      expect(runOn(src)).toEqual([]);
    });
  });

  // --- AC3: severity default + override --------------------------------------
  describe("AC3: severity defaults to warn and honours severityOverride", () => {
    const focusedSrc = `
      import { expect, it } from "vitest";
      it.only("focused", () => {
        expect(value()).toBe(1);
      });
    `;

    it("defaults to warn when no override is given", () => {
      const findings = runOn(focusedSrc);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe("warn");
    });

    it("stamps findings 'fail' when severityOverride is 'fail'", () => {
      const findings = runOn(focusedSrc, { severityOverride: "fail" });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe("fail");
      // Override changes ONLY the severity — the rest of the finding is intact.
      expect(findings[0]!.ruleId).toBe(RULE_ID);
      expect(findings[0]!.testName).toBe("focused");
    });

    it("honours an 'info' override too", () => {
      const findings = runOn(focusedSrc, { severityOverride: "info" });
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe("info");
    });
  });

  // --- AC4: testName is populated --------------------------------------------
  describe("AC4: finding.testName is populated from the title path", () => {
    it("uses the bare leaf title for a top-level focused test", () => {
      const src = `
        import { expect, it } from "vitest";
        it.only("a clear name", () => {
          expect(1).toBe(1);
        });
      `;
      const findings = runOn(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.testName).toBe("a clear name");
    });

    it("joins the describe>it path for a focused leaf inside a suite", () => {
      const src = `
        import { describe, expect, it } from "vitest";
        describe("Outer", () => {
          describe("Inner", () => {
            it.only("does the thing", () => {
              expect(1).toBe(1);
            });
          });
        });
      `;
      const findings = runOn(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.testName).toBe("Outer > Inner > does the thing");
    });
  });

  // --- structural / multi-block behaviour ------------------------------------
  describe("structure", () => {
    it("emits one finding per focused block, leaf and suite together", () => {
      const src = `
        import { describe, expect, it, test } from "vitest";
        it.only("leaf focus", () => {
          expect(1).toBe(1);
        });
        describe.only("suite focus", () => {
          it("inner", () => {
            expect(2).toBe(2);
          });
        });
        test.only("another leaf", () => {
          expect(3).toBe(3);
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(3);
      const names = findings.map((f) => f.testName);
      // suite-focus's inner it() is plain, so the suite name is the path prefix
      // only on the focused describe itself, not the leaf.
      expect(names).toEqual(["leaf focus", "suite focus", "another leaf"]);
    });

    it("flags a focused leaf nested under a NON-focused describe (one finding for the leaf)", () => {
      const src = `
        import { describe, expect, it } from "vitest";
        describe("plain group", () => {
          it.only("the only focused one", () => {
            expect(1).toBe(1);
          });
          it("sibling that won't run", () => {
            expect(2).toBe(2);
          });
        });
      `;
      const findings = runOn(src);

      expect(findings).toHaveLength(1);
      expect(findings[0]!.testName).toBe("plain group > the only focused one");
    });
  });
});
