import { assert } from "chai";
import { affectedNames, TaskError, toTasks } from "../../src/core/tasks";
import type { TagRef } from "../../src/core/types";

const t = (name: string, type: 0 | 1 = 0, itemCount = 1): TagRef => ({
  name,
  type,
  itemCount,
});

describe("toTasks", function () {
  it("folds both types of one name into a single rename task", function () {
    const all = [t("Foo", 0), t("Foo", 1)];
    const tasks = toTasks(
      [
        { kind: "rename", from: all[0], to: "foo" },
        { kind: "rename", from: all[1], to: "foo" },
      ],
      all,
    );
    assert.deepEqual(tasks, [{ kind: "rename", from: "Foo", to: "foo" }]);
  });

  it("refuses a rename that covers only some types of a name", function () {
    const all = [t("Foo", 0), t("Foo", 1)];
    assert.throws(
      () => toTasks([{ kind: "rename", from: all[0], to: "foo" }], all),
      TaskError,
      /all of its types/,
    );
  });

  it("refuses one name renamed to two targets", function () {
    const all = [t("Foo", 0), t("Foo", 1)];
    assert.throws(
      () =>
        toTasks(
          [
            { kind: "rename", from: all[0], to: "a" },
            { kind: "rename", from: all[1], to: "b" },
          ],
          all,
        ),
      TaskError,
      /both/,
    );
  });

  it("remove is 'all' when every type is covered, else only the given types", function () {
    const all = [t("x", 0), t("x", 1), t("y", 1)];
    const tasks = toTasks(
      [
        { kind: "remove", tag: all[0] },
        { kind: "remove", tag: all[1] },
        { kind: "remove", tag: all[2] },
      ],
      all,
    );
    assert.deepEqual(tasks, [
      { kind: "remove", name: "x", types: "all" },
      { kind: "remove", name: "y", types: "all" },
    ]);
    const partial = toTasks([{ kind: "remove", tag: all[1] }], all);
    assert.deepEqual(partial, [{ kind: "remove", name: "x", types: [1] }]);
  });

  it("orders renames, then retypes, then removes, and lists affected names once", function () {
    const all = [t("a"), t("b"), t("c", 1), t("d")];
    const tasks = toTasks(
      [
        { kind: "remove", tag: all[3] },
        { kind: "retype", tag: all[2], toType: 0 },
        { kind: "rename", from: all[0], to: "b" },
      ],
      all,
    );
    assert.deepEqual(
      tasks.map((x) => x.kind),
      ["rename", "retype", "remove"],
    );
    assert.deepEqual(affectedNames(tasks).sort(), ["a", "b", "c", "d"]);
  });

  it("cleans the rename target (NFC + trim)", function () {
    const all = [t("a")];
    const [task] = toTasks(
      [{ kind: "rename", from: all[0], to: "  é  " }],
      all,
    );
    assert.deepEqual(task, { kind: "rename", from: "a", to: "é" });
  });
});
