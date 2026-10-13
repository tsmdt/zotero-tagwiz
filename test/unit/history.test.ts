import { assert } from "chai";
import {
  affectedItemCount,
  editKindOf,
  formatDate,
  formatTime,
  historyAction,
  redoChain,
  undoChain,
} from "../../src/core/history";

const state = (name: string, items: Array<[number, 0 | 1]>) => ({
  name,
  items: items.map(([id, type]) => ({ id, type })),
});

/** History entries, newest first: "u" undone, "a" applied, "i" interrupted. */
const runs = (spec: string) =>
  [...spec].map((c, i) => ({
    id: `r${i}`,
    status: c === "u" ? "undone" : "done",
    interrupted: c === "i",
  }));
const ids = (entries: Array<{ id: string }>) => entries.map((e) => e.id);
/** r0 r1 undone (r0 newest), r2 r3 applied. */
const stack = runs("uuaa");

describe("history", function () {
  describe("undo and redo chains", function () {
    it("undoes the applied runs down to the target, newest first", function () {
      assert.deepEqual(ids(undoChain(stack, "r3")), ["r2", "r3"]);
      assert.deepEqual(ids(undoChain(stack, "r2")), ["r2"]);
      assert.deepEqual(undoChain(stack, "r0"), []);
      assert.deepEqual(undoChain(stack, "missing"), []);
    });

    it("redoes the undone runs up to the target, oldest first", function () {
      assert.deepEqual(ids(redoChain(stack, "r0")), ["r1", "r0"]);
      assert.deepEqual(ids(redoChain(stack, "r1")), ["r1"]);
      assert.deepEqual(redoChain(stack, "r2"), []);
      assert.deepEqual(redoChain(stack, "missing"), []);
    });

    it("does not redo past a run that has no after snapshot", function () {
      const entries = runs("uuua");
      entries[1].interrupted = true; // undone with force after a crash
      assert.deepEqual(ids(redoChain(entries, "r2")), ["r2"]);
      assert.deepEqual(redoChain(entries, "r1"), []);
      assert.deepEqual(redoChain(entries, "r0"), []);
    });

    it("does not redo a run overtaken by a newer applied run", function () {
      const entries = runs("aua");
      assert.deepEqual(redoChain(entries, "r1"), []);
      assert.deepEqual(ids(undoChain(entries, "r2")), ["r0", "r2"]);
    });

    it("names the action each run allows", function () {
      const entries = runs("uiua");
      entries[1].status = "undone";
      assert.deepEqual(
        entries.map((e) => historyAction(entries, e.id)),
        [undefined, undefined, "redo", "undo"],
      );
      assert.isUndefined(historyAction(entries, undefined));
    });
  });

  describe("random undo/redo sequences (model of the engine)", function () {
    /**
     * A library whose state is the list of edits applied to it, and the
     * engine's rules on top of the real chain helpers: undo needs the tags as
     * the run left them, redo as it found them (else the user forces it);
     * a kept run discards the undone ones and prunes to KEEP; a crash leaves
     * a run without `after` and skips both.
     */
    const KEEP = 10;
    interface Run {
      id: string;
      status: "done" | "undone";
      interrupted: boolean;
      before: string;
      after?: string;
    }

    /** Deterministic pseudo-random numbers (mulberry32). */
    function random(seed: number) {
      return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function simulate(seed: number, steps: number) {
      const rand = random(seed);
      const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)];
      let runs: Run[] = []; // newest first, like listHistory
      let state = "";
      let n = 0;
      let forced = 0;
      const step = (run: Run, to: "before" | "after") => {
        // The engine refuses this even when forced: there is no `after`.
        assert.isFalse(to === "after" && run.interrupted, "redid a crash");
        const expected = to === "before" ? run.after : run.before;
        // A refused run is forced, as when the user agrees in the dialog.
        if (expected === undefined || expected !== state) forced++;
        state = to === "before" ? run.before : run.after!;
        run.status = to === "before" ? "undone" : "done";
      };

      for (let i = 0; i < steps; i++) {
        const roll = rand();
        const undoable = runs.filter(
          (r) => historyAction(runs, r.id) === "undo",
        );
        const redoable = runs.filter(
          (r) => historyAction(runs, r.id) === "redo",
        );
        if (roll < 0.35 || !runs.length) {
          const crash = rand() < 0.1;
          const before = state;
          state = `${state}+e${n}`;
          runs.unshift({
            id: `r${String(n++).padStart(5, "0")}`,
            status: "done",
            interrupted: crash,
            before,
            after: crash ? undefined : state,
          });
          if (!crash) {
            runs = runs.filter((r, k) => k === 0 || r.status !== "undone");
            runs = runs.slice(0, KEEP);
          }
        } else if (roll < 0.4) {
          state = `${state}+outside${i}`; // e.g. a sync changed the tags
        } else if (roll < 0.7 && undoable.length) {
          const target = pick(undoable);
          const chain = undoChain(runs, target.id);
          assert.equal(chain[chain.length - 1], target);
          for (const run of chain) step(run, "before");
          assert.equal(state, target.before, `seed ${seed} step ${i}: undo`);
        } else if (redoable.length) {
          const target = pick(redoable);
          const chain = redoChain(runs, target.id);
          assert.equal(chain[chain.length - 1], target);
          for (const run of chain) step(run, "after");
          assert.equal(state, target.after, `seed ${seed} step ${i}: redo`);
        }

        // The undone runs sit on top of the applied ones (or below a crashed
        // run, which never discarded them); none above the first applied one
        // is lost, and none below it can be redone.
        const top = runs.findIndex((r) => r.status !== "undone");
        for (const [k, run] of runs.entries()) {
          const action = historyAction(runs, run.id);
          if (run.status !== "undone") assert.equal(action, "undo");
          else if (top >= 0 && k > top) assert.isUndefined(action);
        }
      }
      return forced;
    }

    it("always lands exactly before or after the selected run", function () {
      let forced = 0;
      for (let seed = 1; seed <= 200; seed++) forced += simulate(seed, 300);
      // Outside changes and crashes happened, so forcing was exercised.
      assert.isAbove(forced, 0);
    });

    it("needs no forcing without outside changes or crashes", function () {
      // Only undo and redo after the stack is built: every step must find
      // the tags exactly as its snapshot expects.
      for (let seed = 1; seed <= 200; seed++) {
        const rand = random(seed);
        const runs: Run[] = [];
        let state = "";
        for (let k = 0; k < KEEP; k++) {
          const before = state;
          state = `${state}+e${k}`;
          runs.unshift({
            id: `r${k}`,
            status: "done",
            interrupted: false,
            before,
            after: state,
          });
        }
        for (let i = 0; i < 100; i++) {
          const options = runs.filter((r) => historyAction(runs, r.id));
          const target = options[Math.floor(rand() * options.length)];
          const undo = historyAction(runs, target.id) === "undo";
          const chain = undo
            ? undoChain(runs, target.id)
            : redoChain(runs, target.id);
          for (const run of chain) {
            assert.equal(state, undo ? run.after : run.before);
            state = undo ? run.before : run.after!;
            run.status = undo ? "undone" : "done";
          }
        }
      }
    });
  });

  describe("editKindOf", function () {
    it("uses the recorded kind", function () {
      assert.equal(
        editKindOf({
          kind: "case",
          tasks: [{ kind: "rename", from: "a", to: "A" }],
        }),
        "case",
      );
    });

    it("classifies older journals by their tasks", function () {
      assert.equal(
        editKindOf({ tasks: [{ kind: "remove", name: "a", types: "all" }] }),
        "remove",
      );
      assert.equal(
        editKindOf({
          tasks: [
            { kind: "rename", from: "a", to: "A" },
            { kind: "retype", name: "A", toType: 0 },
          ],
        }),
        "duplicates",
      );
      assert.equal(
        editKindOf({
          tasks: [
            { kind: "rename", from: "a", to: "c" },
            { kind: "rename", from: "b", to: "c" },
          ],
        }),
        "merge",
      );
      assert.equal(
        editKindOf({
          tasks: [
            { kind: "rename", from: "a", to: "A" },
            { kind: "rename", from: "b", to: "B" },
          ],
        }),
        "rename",
      );
    });
  });

  describe("affectedItemCount", function () {
    it("does not count items that only carry the merge target", function () {
      const before = [
        state("a", [
          [1, 0],
          [2, 0],
        ]),
        state("b", [
          [2, 0],
          [3, 0],
        ]),
      ];
      const after = [
        state("a", []),
        state("b", [
          [1, 0],
          [2, 0],
          [3, 0],
        ]),
      ];
      // 1 gains b and loses a, 2 loses a; 3 keeps only b.
      assert.equal(affectedItemCount(before, after), 2);
    });

    it("counts every item of a removed tag", function () {
      const before = [
        state("a", [
          [1, 0],
          [2, 1],
        ]),
      ];
      assert.equal(affectedItemCount(before, [state("a", [])]), 2);
    });

    it("counts items whose tag changed type", function () {
      const before = [
        state("a", [
          [1, 1],
          [2, 0],
        ]),
      ];
      const after = [
        state("a", [
          [1, 0],
          [2, 0],
        ]),
      ];
      assert.equal(affectedItemCount(before, after), 1);
    });

    it("counts every item of the run's tags without an after snapshot", function () {
      const before = [
        state("a", [
          [1, 0],
          [2, 0],
        ]),
        state("b", [
          [2, 0],
          [3, 0],
        ]),
      ];
      assert.equal(affectedItemCount(before), 3);
    });
  });

  describe("formatDate / formatTime", function () {
    it("shows a missing or damaged date as ?", function () {
      assert.equal(formatDate(""), "?");
      assert.equal(formatTime("not a date"), "?");
    });

    it("zero-pads local date and time", function () {
      const d = new Date(2026, 0, 5, 7, 3, 9);
      assert.equal(formatDate(d.toISOString()), "2026-01-05");
      assert.equal(formatTime(d.toISOString()), "07:03:09");
    });
  });
});
