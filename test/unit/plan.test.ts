import { assert } from "chai";
import { findDuplicateGroups } from "../../src/core/duplicates";
import {
  buildCasePlan,
  buildDuplicatePlan,
  buildRemovePlan,
  buildUnifyPlan,
  includedOps,
  validateTagName,
} from "../../src/core/plan";
import type { TagRef } from "../../src/core/types";

const t = (
  name: string,
  itemCount = 1,
  extra: Partial<TagRef> = {},
): TagRef => ({
  name,
  type: 0,
  itemCount,
  ...extra,
});

describe("plan", function () {
  describe("validateTagName", function () {
    it("rejects empty and too long, accepts normal", function () {
      assert.equal(validateTagName("  "), "empty");
      assert.equal(validateTagName("x".repeat(256)), "too-long");
      assert.isNull(validateTagName("x".repeat(255)));
    });
  });

  describe("buildCasePlan", function () {
    it("skips tags already in the requested style", function () {
      const all = [t("foo"), t("Bar")];
      const plan = buildCasePlan(all, { style: "lower" }, all);
      assert.lengthOf(plan.rows, 1);
    });

    it("flags merges into an existing untouched tag (case-only rename)", function () {
      const all = [t("Foo"), t("foo")];
      const plan = buildCasePlan([all[0]], { style: "lower" }, all);
      assert.isTrue(plan.rows[0].merges);
      assert.isUndefined(plan.rows[0].error);
    });

    it("never merges a '_' workflow tag into its bare name", function () {
      const all = [t("_todo", 40), t("todo", 3)];
      for (const style of ["snake", "kebab", "camel"] as const) {
        assert.lengthOf(buildCasePlan([all[0]], { style }, all).rows, 0, style);
      }
    });

    it("flags two sources collapsing to one name", function () {
      const all = [t("Foo"), t("FOO")];
      const plan = buildCasePlan(
        all,
        { style: "lower", keepAcronyms: false },
        all,
      );
      assert.isTrue(plan.rows.every((r) => r.merges));
    });

    it("does not flag a merge for one name that exists as manual and automatic", function () {
      const all = [t("foo bar", 3), t("foo bar", 9, { type: 1 })];
      const plan = buildCasePlan(all, { style: "title" }, all);
      assert.lengthOf(plan.rows, 2);
      assert.isTrue(plan.rows.every((r) => !r.merges));
    });

    it("blocks empty results", function () {
      const all = [t("---")];
      const plan = buildCasePlan(all, { style: "camel" }, all);
      assert.equal(plan.rows[0].error, "empty");
      assert.isFalse(plan.rows[0].included);
      assert.lengthOf(includedOps(plan), 0);
    });

    it("unify skips the source equal to the target, so no rename chain arises", function () {
      const all = [t("a"), t("b"), t("c")];
      const plan = buildUnifyPlan([all[0], all[1]], "b", all);
      assert.lengthOf(plan.rows, 1);
      assert.isUndefined(plan.rows[0].error);
    });
  });

  describe("buildUnifyPlan", function () {
    it("renames all sources except the one equal to target; all merge", function () {
      const all = [t("ml"), t("ML"), t("machine learning", 10)];
      const plan = buildUnifyPlan(all, "machine learning", all);
      assert.lengthOf(plan.rows, 2);
      assert.isTrue(plan.rows.every((r) => r.merges));
    });

    it("renaming one tag to a new name is not a merge", function () {
      const all = [t("foo", 3), t("bar")];
      const single = buildUnifyPlan([all[0]], "brand new", all);
      assert.lengthOf(single.rows, 1);
      assert.isFalse(single.rows[0].merges);
      const both = buildUnifyPlan(all, "brand new", all);
      assert.isTrue(both.rows.every((r) => r.merges));
    });

    it("rejects an empty target", function () {
      const all = [t("a"), t("b")];
      const plan = buildUnifyPlan(all, "   ", all);
      assert.isTrue(plan.rows.every((r) => r.error === "empty" && !r.included));
    });
  });

  describe("buildRemovePlan", function () {
    it("warns when a colored tag is removed", function () {
      const all = [t("x", 1, { color: "#f00", position: 0 }), t("y")];
      const plan = buildRemovePlan(all, all);
      assert.deepEqual(plan.rows[0].warnings, ["loses-color"]);
      assert.deepEqual(plan.rows[1].warnings, []);
    });
  });

  describe("buildDuplicatePlan", function () {
    it("merges variants into the canonical and retypes same-name entries", function () {
      const all = [t("Foo", 5), t("foo", 1), t("Foo", 2, { type: 1 })];
      const groups = findDuplicateGroups(all, "case");
      assert.lengthOf(groups, 1);
      const plan = buildDuplicatePlan(groups, all);
      const kinds = plan.rows.map((r) => r.op.kind).sort();
      assert.deepEqual(kinds, ["rename", "retype"]);
      const rename = plan.rows.find((r) => r.op.kind === "rename")!;
      assert.isTrue(rename.merges);
      assert.equal((rename.op as { to: string }).to, "Foo");
    });

    it("never turns manual tags automatic by default", function () {
      const all = [t("x", 3), t("x", 9, { type: 1 })];
      const groups = findDuplicateGroups(all, "exact");
      const plan = buildDuplicatePlan(groups, all);
      assert.lengthOf(plan.rows, 1);
      assert.deepEqual(plan.rows[0].op, {
        kind: "retype",
        tag: all[1],
        toType: 0,
      });
    });

    it("keeps the manual variant when the user picks the automatic one", function () {
      const all = [t("foo", 5), t("foo", 1, { type: 1 }), t("Foo", 2)];
      const groups = findDuplicateGroups(all, "case");
      const plan = buildDuplicatePlan(
        groups,
        all,
        new Map([[groups[0], all[1]]]),
      );
      const ops = includedOps(plan);
      assert.deepEqual(ops.map((op) => op.kind).sort(), ["rename", "retype"]);
      const retype = ops.find((op) => op.kind === "retype")!;
      assert.deepEqual(retype, { kind: "retype", tag: all[1], toType: 0 });
    });

    it("honours the user's canonical choice", function () {
      const all = [t("Foo", 5), t("foo", 1)];
      const groups = findDuplicateGroups(all, "case");
      const plan = buildDuplicatePlan(
        groups,
        all,
        new Map([[groups[0], all[1]]]),
      );
      const op = plan.rows[0].op as { kind: "rename"; to: string };
      assert.equal(op.to, "foo");
    });
  });
});
