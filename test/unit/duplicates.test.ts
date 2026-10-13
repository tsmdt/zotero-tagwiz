import { assert } from "chai";
import {
  findDuplicateGroups,
  findFuzzyPairs,
  pickCanonical,
} from "../../src/core/duplicates";
import { duplicateKey } from "../../src/core/normalize";
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
const names = (g: { members: TagRef[] }) => g.members.map((m) => m.name).sort();

describe("duplicates", function () {
  describe("duplicateKey", function () {
    it("never collapses distinct punctuation", function () {
      const keys = new Set(
        ["C++", "C#", "C"].map((n) => duplicateKey(n, "normalized")),
      );
      assert.equal(keys.size, 3);
    });

    it("keeps separator-only names apart", function () {
      assert.notEqual(
        duplicateKey("-", "normalized"),
        duplicateKey("_", "normalized"),
      );
    });

    it("case tier lowercases İ to a plain i, as case conversion does", function () {
      assert.equal(
        duplicateKey("İstanbul", "case"),
        duplicateKey("istanbul", "case"),
      );
    });

    it("normalized tier treats separators, camelCase and diacritics alike", function () {
      const k = duplicateKey("machine learning", "normalized");
      for (const n of [
        "Machine-Learning",
        "machine_learning",
        "machineLearning",
        "Machine  Learning",
      ]) {
        assert.equal(duplicateKey(n, "normalized"), k, n);
      }
      assert.equal(
        duplicateKey("Café", "normalized"),
        duplicateKey("cafe", "normalized"),
      );
    });

    it("folds accents on Latin and Greek letters", function () {
      for (const [a, b] of [
        ["résumé", "resume"],
        ["Ångström", "angstrom"],
        ["Ελλάδα", "ελλαδα"],
        ["ﬁlm", "film"],
      ]) {
        assert.equal(
          duplicateKey(a, "normalized"),
          duplicateKey(b, "normalized"),
          `${a} / ${b}`,
        );
      }
    });

    it("keeps marks that tell letters apart in other scripts", function () {
      for (const [a, b] of [
        ["がき", "かき"], // Japanese dakuten
        ["किताब", "कताब"], // Devanagari vowel sign
        ["мой", "мои"], // Cyrillic short i
      ]) {
        assert.notEqual(
          duplicateKey(a, "normalized"),
          duplicateKey(b, "normalized"),
          `${a} / ${b}`,
        );
      }
      assert.lengthOf(
        findDuplicateGroups([t("がき"), t("かき")], "normalized"),
        0,
      );
    });

    it("still matches composed and decomposed forms of other scripts", function () {
      assert.equal(
        duplicateKey("が", "normalized"),
        duplicateKey("が", "normalized"),
      );
    });
  });

  describe("findDuplicateGroups", function () {
    it("exact tier only finds same-name different-type entries", function () {
      const tags = [t("Foo", 2), t("Foo", 1, { type: 1 }), t("foo", 5)];
      const groups = findDuplicateGroups(tags, "exact");
      assert.lengthOf(groups, 1);
      assert.deepEqual(names(groups[0]), ["Foo", "Foo"]);
    });

    it("tiers are cumulative and report the lowest matching tier", function () {
      const tags = [t("Foo", 2), t("foo", 5), t("f-o-o"), t("solo")];
      const caseGroups = findDuplicateGroups(tags, "case");
      assert.lengthOf(caseGroups, 1);
      assert.equal(caseGroups[0].matchedBy, "case");
      const norm = findDuplicateGroups(
        [t("a b"), t("a-b"), t("a_b")],
        "normalized",
      );
      assert.lengthOf(norm, 1);
      assert.equal(norm[0].matchedBy, "normalized");
      assert.lengthOf(norm[0].members, 3);
    });

    it("never returns single-member groups", function () {
      assert.lengthOf(findDuplicateGroups([t("a"), t("b")], "normalized"), 0);
    });

    it("suggests the most used tag, then colored, then manual", function () {
      assert.equal(pickCanonical([t("foo", 1), t("Foo", 9)]).name, "Foo");
      assert.equal(
        pickCanonical([t("a", 3), t("A", 3, { color: "#f00" })]).name,
        "A",
      );
      assert.equal(
        pickCanonical([t("x", 3, { type: 1 }), t("x", 3, { type: 0 })]).type,
        0,
      );
    });

    it("keeps the manual variant of the winning name even if it is used less", function () {
      const pick = pickCanonical([
        t("x", 9, { type: 1 }),
        t("x", 3, { type: 0 }),
        t("X", 5),
      ]);
      assert.equal(pick.name, "x");
      assert.equal(pick.type, 0);
    });

    it("counts both types of a name together", function () {
      const pick = pickCanonical([
        t("foo", 5),
        t("foo", 5, { type: 1 }),
        t("Foo", 6),
      ]);
      assert.equal(pick.name, "foo");
      assert.equal(pick.type, 0);
    });

    it("may still pick an automatic tag when its name has no manual variant", function () {
      const pick = pickCanonical([t("ML", 9, { type: 1 }), t("ml", 2)]);
      assert.equal(pick.name, "ML");
      assert.equal(pick.type, 1);
    });
  });

  describe("fuzzy suggestions", function () {
    it("finds typos and plurals, skips short names and real duplicates", function () {
      const pairs = findFuzzyPairs([
        t("algorithm"),
        t("algorithms"),
        t("bayesian"),
        t("bayesain"),
        t("cat"),
        t("cats"),
        t("same"),
        t("Same"),
      ]);
      const labels = pairs
        .map((p) => `${p.a.name}~${p.b.name}:${p.reason}`)
        .sort();
      assert.deepEqual(labels, ["algorithm~algorithms:plural"]);
    });

    it("lists a pair once when a name has both types", function () {
      const pairs = findFuzzyPairs([
        t("neuron"),
        t("neuron", 1, { type: 1 }),
        t("neurons"),
      ]);
      assert.lengthOf(pairs, 1);
      assert.equal(pairs[0].reason, "plural");
    });

    it("lists a pair once when a name has case variants", function () {
      const pairs = findFuzzyPairs([t("Neuron", 5), t("neuron"), t("neurons")]);
      assert.deepEqual(
        pairs.map((p) => [p.a.name, p.b.name].sort()),
        [["Neuron", "neurons"]],
      );
    });

    it("finds substitutions, insertions and deletions, not other first letters", function () {
      const pairs = findFuzzyPairs([
        t("colour"),
        t("colout"), // substitution
        t("colur"), // deletion
        t("kolour"), // other first letter
        t("bayes rule", 9),
        t("bayes rules", 9),
      ]);
      const labels = pairs.map((p) => [p.a.name, p.b.name].sort().join("~"));
      assert.deepEqual(labels.slice(1).sort(), [
        "colour~colout",
        "colour~colur",
      ]);
      // Most-used first.
      assert.equal(labels[0], "bayes rule~bayes rules");
    });
  });
});
