/* eslint-disable mocha/no-setup-in-describe, mocha/consistent-spacing-between-blocks -- itx() is a thin wrapper around it() that makes errors readable */
import { assert } from "chai";
import type { EditKind } from "../src/core/history";
import type { Op, TagRef, TagType } from "../src/core/types";
import {
  applyOps,
  redoJournal,
  redoTo,
  undoJournal,
  undoTo,
} from "../src/zotero/engine";
import { preflight } from "../src/zotero/guard";
import {
  deleteJournal,
  listHistory,
  listJournalIDs,
  newJournalID,
  pruneJournals,
  readJournal,
  writeJournal,
} from "../src/zotero/journal";
import {
  captureStates,
  getColorList,
  loadTags,
  measureImpact,
  typesOf,
} from "../src/zotero/tagStore";

/** Zotero rejects with non-Error values; the reporter would print "undefined". */
function describeError(e: unknown): string {
  const any = e as any;
  const parts = [`typeof=${typeof e}`];
  try {
    parts.push(`String=${String(e)}`);
  } catch {
    // ignore
  }
  for (const key of ["name", "message", "stack", "fileName", "lineNumber"]) {
    if (any?.[key] !== undefined) parts.push(`${key}=${any[key]}`);
  }
  try {
    parts.push(`keys=${Object.getOwnPropertyNames(any ?? {}).join(",")}`);
  } catch {
    // ignore
  }
  return parts.join(" | ");
}

/** `it` that turns any rejection into an Error with a readable message. */
function itx(title: string, fn: (this: Mocha.Context) => Promise<void> | void) {
  it(title, async function () {
    try {
      await fn.call(this);
    } catch (err) {
      // The scaffold reporter prints only err.expected / err.actual, not err.message.
      const wrapped = new Error(describeError(err)) as Error & {
        expected?: string;
        actual?: string;
        showDiff?: boolean;
      };
      wrapped.expected = "no error";
      wrapped.actual = describeError(err);
      wrapped.showDiff = true;
      throw wrapped;
    }
  });
}

/**
 * Integration tests: they run inside Zotero against whatever data directory
 * the dev profile uses (`npm test`). Every tag and item they create is
 * namespaced by a per-run prefix and removed afterwards, but run them against
 * a COPY of your library only.
 */
describe("engine (in Zotero)", function () {
  this.timeout(20000);

  let libraryID: number;
  let prefix: string;
  const itemsToErase: Zotero.Item[] = [];
  const collectionsToErase: Zotero.Collection[] = [];
  let n = 0;
  const name = (label: string) => `${prefix}${label}${n++}`;

  async function makeItem(
    tags: Array<string | { tag: string; type: number }>,
    collection?: Zotero.Collection,
  ) {
    const item = new Zotero.Item("book");
    item.libraryID = libraryID;
    item.setField("title", `${prefix}item${n++}`);
    item.setTags(tags);
    if (collection) item.setCollections([collection.id]);
    await item.saveTx();
    itemsToErase.push(item);
    return item;
  }

  async function makeCollection(parent?: Zotero.Collection) {
    const collection = new Zotero.Collection({
      libraryID,
      name: `${prefix}col${n++}`,
      parentID: parent?.id,
    });
    await collection.saveTx();
    collectionsToErase.push(collection);
    return collection;
  }

  async function color(tag: string, value: string | false) {
    await Zotero.DB.executeTransaction(async () => {
      // Zotero clears the color for a falsy value and appends it without a
      // position; its typings require both.
      await Zotero.Tags.setColor(
        libraryID,
        tag,
        value as string,
        undefined as unknown as number,
      );
    });
  }

  const colorOf = (tag: string) =>
    getColorList(libraryID).find((x) => x.name === tag)?.color;

  async function ref(tag: string, type: TagType = 0): Promise<TagRef> {
    const found = (await loadTags(libraryID)).find(
      (t) => t.name === tag && t.type === type,
    );
    assert.exists(found, `tag ${tag} (type ${type}) should exist`);
    return found!;
  }

  async function run(ops: Op[], kind: EditKind = "rename") {
    return applyOps({
      libraryID,
      ops,
      allTags: await loadTags(libraryID),
      kind,
    });
  }

  const rename = async (from: string, to: string, type: TagType = 0) =>
    run([{ kind: "rename", from: await ref(from, type), to }]);

  const typeOn = (item: Zotero.Item, tag: string) => item.getTagType(tag);

  before(function () {
    libraryID = Zotero.Libraries.userLibraryID;
    prefix = `__tc${Date.now().toString(36)}_`;
  });

  afterEach(async function () {
    for (const item of itemsToErase.splice(0)) {
      if (await Zotero.Items.getAsync(item.id)) await item.eraseTx();
    }
    for (const col of collectionsToErase.splice(0).reverse()) {
      if (await Zotero.Collections.getAsync(col.id)) await col.eraseTx();
    }
    for (const { name: tag } of getColorList(libraryID)) {
      if (tag.startsWith(prefix)) await color(tag, false);
    }
    await Zotero.DB.executeTransaction(async () => {
      await Zotero.Tags.purge();
    });
  });

  describe("smoke (isolates the first failing building block)", function () {
    itx("1. loadTags reads the library", async function () {
      const tags = await loadTags(libraryID);
      assert.isArray(tags);
    });

    itx("2. can create and erase an item with tags", async function () {
      const item = await makeItem([name("smoke")]);
      assert.isTrue(item.id > 0);
    });

    itx("3. loadTags sees a freshly created tag", async function () {
      const tag = name("seen");
      await makeItem([tag]);
      const found = (await loadTags(libraryID)).find((t) => t.name === tag);
      assert.equal(found?.itemCount, 1);
    });

    itx("4. typesOf and captureStates work", async function () {
      const tag = name("types");
      await makeItem([{ tag, type: 1 }]);
      assert.deepEqual(await typesOf(libraryID, tag), [1]);
      const [state] = await captureStates(libraryID, [tag]);
      assert.lengthOf(state.items, 1);
    });

    itx("5. a rename with no tasks needs no journal", async function () {
      const result = await run([]);
      assert.equal(result.totalTasks, 0);
    });

    itx("6. journal files can be written and read", async function () {
      const id = newJournalID();
      await writeJournal({
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        libraryID,
        status: "done",
        kind: "rename",
        tasks: [],
        completedTasks: 0,
        before: [],
      });
      assert.equal((await readJournal(id)).id, id);
      assert.include(await listJournalIDs(), id);
      // Not left in the History of the test profile's library.
      await deleteJournal(id);
    });
  });

  itx("preflight accepts the user library", function () {
    assert.isTrue(preflight(libraryID).ok);
  });

  describe("tags stored in a non-NFC form", function () {
    /** Store `tag` decomposed (NFD), as old imports could, and reload Zotero's tag cache. */
    async function decompose(tag: string) {
      await Zotero.DB.executeTransaction(async () => {
        await Zotero.DB.queryAsync("UPDATE tags SET name=? WHERE name=?", [
          tag.normalize("NFD"),
          tag,
        ]);
      });
      await (Zotero.Tags as any).init();
    }

    /** Tag names stored for `item`, read straight from the database. */
    async function storedNames(item: Zotero.Item): Promise<string[]> {
      return (await Zotero.DB.columnQueryAsync(
        "SELECT name FROM itemTags JOIN tags USING (tagID) WHERE itemID=?",
        [item.id],
      )) as string[];
    }

    itx("lists, renames and removes them", async function () {
      const [x, y, z] = [name("café"), name("cy"), name("crème")];
      const a = await makeItem([x]);
      const b = await makeItem([z]);
      await decompose(x);
      await decompose(z);
      assert.deepEqual(await storedNames(a), [x.normalize("NFD")]);

      const listed = (await loadTags(libraryID)).filter((t) => t.name === x);
      assert.lengthOf(listed, 1);
      assert.deepEqual(await typesOf(libraryID, x), [0]);

      const renamed = await rename(x, y);
      assert.equal(renamed.status, "done");
      assert.equal(renamed.skippedTasks, 0);
      assert.deepEqual(await storedNames(a), [y]);

      const removed = await run([{ kind: "remove", tag: await ref(z) }]);
      assert.equal(removed.status, "done");
      assert.equal(removed.skippedTasks, 0);
      assert.deepEqual(await storedNames(b), []);
    });

    itx("renames a name stored in two forms on every item", async function () {
      const [x, other, y] = [name("née"), name("tmp"), name("ny")];
      const a = await makeItem([x]);
      const b = await makeItem([other]);
      // b's tag becomes the NFD twin of a's NFC one.
      await Zotero.DB.executeTransaction(async () => {
        await Zotero.DB.queryAsync("UPDATE tags SET name=? WHERE name=?", [
          x.normalize("NFD"),
          other,
        ]);
      });
      await (Zotero.Tags as any).init();
      await (Zotero.Items as any).reload([a.id, b.id], ["tags"], true);

      const listed = (await loadTags(libraryID)).filter((t) => t.name === x);
      assert.lengthOf(listed, 1);
      assert.equal(listed[0].itemCount, 2);

      const result = await rename(x, y);

      assert.equal(result.status, "done");
      assert.deepEqual(await storedNames(a), [y]);
      assert.deepEqual(await storedNames(b), [y]);
      assert.deepEqual(await typesOf(libraryID, x), []);
    });

    itx("reports a task whose tag is gone as skipped", async function () {
      const x = name("gone");
      const item = await makeItem([x]);
      const allTags = await loadTags(libraryID);
      const from = await ref(x);
      item.removeTag(x);
      await item.saveTx();

      const result = await applyOps({
        libraryID,
        allTags,
        ops: [{ kind: "rename", from, to: name("gt") }],
        kind: "rename",
      });

      assert.equal(result.status, "done");
      assert.equal(result.completedTasks, 1);
      assert.equal(result.skippedTasks, 1);
      // Nothing changed, so no journal is kept (see "a run that changed nothing").
      assert.equal(result.journalId, "");
    });
  });

  describe("rename", function () {
    itx(
      "fast path: merges into an existing tag without duplicates",
      async function () {
        const x = name("x");
        const y = name("y");
        const a = await makeItem([x]);
        const b = await makeItem([y]);
        const c = await makeItem([x, y]);

        const result = await rename(x, y);

        assert.equal(result.status, "done");
        assert.isTrue(a.hasTag(y));
        assert.isTrue(b.hasTag(y));
        assert.isTrue(c.hasTag(y));
        assert.lengthOf(c.getTags(), 1);
        assert.deepEqual(await typesOf(libraryID, x), []);
      },
    );

    itx("per-item path keeps the automatic type", async function () {
      const x = name("auto");
      const z = name("z");
      const item = await makeItem([{ tag: x, type: 1 }]);

      await rename(x, z, 1);

      assert.equal(typeOn(item, z), 1);
      assert.isFalse(item.hasTag(x));
    });

    itx(
      "manual wins when merging automatic into manual and vice versa",
      async function () {
        const [m, a] = [name("m"), name("a")];
        const both = await makeItem([
          { tag: m, type: 0 },
          { tag: a, type: 1 },
        ]);
        await rename(a, m, 1);
        assert.equal(typeOn(both, m), 0);

        const [m2, a2] = [name("m"), name("a")];
        const other = await makeItem([
          { tag: m2, type: 0 },
          { tag: a2, type: 1 },
        ]);
        await rename(m2, a2, 0);
        assert.equal(typeOn(other, a2), 0);
      },
    );

    itx("handles case-only renames", async function () {
      const upper = name("Foo");
      const lower = upper.toLowerCase();
      const item = await makeItem([upper]);

      await rename(upper, lower);

      assert.isTrue(item.hasTag(lower));
      assert.isFalse(item.hasTag(upper));
    });

    itx(
      "does not change Date Modified on the per-item path",
      async function () {
        const x = name("dm");
        const item = await makeItem([{ tag: x, type: 1 }]);
        const before = item.dateModified;

        await rename(x, name("dm2"), 1);

        assert.equal(item.dateModified, before);
      },
    );

    for (const auto of [false, true]) {
      const path = auto ? "per-item" : "fast";

      itx(
        `${path} path: source color moves to an uncolored target`,
        async function () {
          const [x, y] = [name("cx"), name("cy")];
          const type = auto ? 1 : 0;
          await makeItem([{ tag: x, type }]);
          await color(x, "#FF0000");

          await rename(x, y, type);

          assert.equal(colorOf(y), "#FF0000");
          assert.isUndefined(colorOf(x));
        },
      );

      itx(
        `${path} path: a colored target keeps its own color`,
        async function () {
          const [x, y] = [name("kx"), name("ky")];
          const type = auto ? 1 : 0;
          await makeItem([{ tag: x, type }]);
          await makeItem([{ tag: y, type }]);
          await color(x, "#FF0000");
          await color(y, "#00FF00");

          await rename(x, y, type);

          assert.equal(colorOf(y), "#00FF00");
          assert.isUndefined(colorOf(x));
        },
      );
    }

    itx(
      "refuses a rename covering only one type of a name, changing nothing",
      async function () {
        const x = name("both");
        const item = await makeItem([x]);
        await makeItem([{ tag: x, type: 1 }]);

        let threw = false;
        try {
          await rename(x, name("to"), 0);
        } catch {
          threw = true;
        }

        assert.isTrue(threw);
        assert.isTrue(item.hasTag(x));
      },
    );
  });

  describe("remove / retype", function () {
    itx(
      "remove deletes the tag everywhere and clears its color",
      async function () {
        const x = name("rm");
        const a = await makeItem([x]);
        await color(x, "#123456");

        await run([{ kind: "remove", tag: await ref(x) }]);

        assert.isFalse(a.hasTag(x));
        assert.isUndefined(colorOf(x));
      },
    );

    itx(
      "removing one type leaves the other type and the color",
      async function () {
        const x = name("rt");
        const manual = await makeItem([{ tag: x, type: 0 }]);
        const auto = await makeItem([{ tag: x, type: 1 }]);
        await color(x, "#123456");

        await run([{ kind: "remove", tag: await ref(x, 1) }]);

        assert.isTrue(manual.hasTag(x));
        assert.isFalse(auto.hasTag(x));
        assert.equal(colorOf(x), "#123456");
      },
    );

    itx("retype consolidates a name onto one type", async function () {
      const x = name("re");
      const auto = await makeItem([{ tag: x, type: 1 }]);

      await run([{ kind: "retype", tag: await ref(x, 1), toType: 0 }]);

      assert.equal(typeOn(auto, x), 0);
    });
  });

  describe("unify into a new name", function () {
    const mergeInto = async (sources: string[], target: string) =>
      run(
        await Promise.all(
          sources.map(
            async (from): Promise<Op> => ({
              kind: "rename",
              from: await ref(from),
              to: target,
            }),
          ),
        ),
      );

    itx(
      "combines several tags into a name that did not exist",
      async function () {
        const [x, y, z, target] = [
          name("mx"),
          name("my"),
          name("mz"),
          name("new"),
        ];
        const a = await makeItem([x]);
        const b = await makeItem([y]);
        const c = await makeItem([x, y, z]);

        const result = await mergeInto([x, y, z], target);

        assert.equal(result.status, "done");
        for (const item of [a, b, c]) assert.isTrue(item.hasTag(target));
        assert.lengthOf(c.getTags(), 1);
        for (const old of [x, y, z]) {
          assert.deepEqual(await typesOf(libraryID, old), []);
        }
      },
    );

    itx(
      "the new tag inherits the first colored source color",
      async function () {
        const [x, y, target] = [name("cx"), name("cy"), name("cnew")];
        await makeItem([x]);
        await makeItem([y]);
        await color(x, "#FF0000");
        await color(y, "#00FF00");

        await mergeInto([x, y], target);

        assert.equal(colorOf(target), "#FF0000");
        assert.isUndefined(colorOf(x));
        assert.isUndefined(colorOf(y));
      },
    );
  });

  describe("undo", function () {
    itx(
      "restores membership, types and colors after a merge",
      async function () {
        const [x, y] = [name("ux"), name("uy")];
        await makeItem([{ tag: x, type: 1 }]);
        await makeItem([y]);
        await makeItem([x, y]);
        await color(x, "#FF0000");
        const before = await captureStates(libraryID, [x, y]);

        // x is used as manual and automatic, so a rename must cover both.
        const result = await run([
          { kind: "rename", from: await ref(x, 0), to: y },
          { kind: "rename", from: await ref(x, 1), to: y },
        ]);
        assert.equal(result.status, "done");
        assert.deepEqual(await typesOf(libraryID, x), []);
        const undone = await undoJournal(result.journalId);

        assert.isTrue(undone.ok);
        const after = await captureStates(libraryID, [x, y]);
        const norm = (s: typeof before) =>
          s.map((t) => ({
            name: t.name,
            color: t.color?.color,
            items: t.items.map((i) => `${i.id}:${i.type}`).sort(),
          }));
        assert.deepEqual(norm(after), norm(before));
      },
    );

    itx(
      "refuses when the tags changed after the run, unless forced",
      async function () {
        const [x, y] = [name("dx"), name("dy")];
        await makeItem([x]);
        const later = await makeItem([]);
        const result = await rename(x, y);
        later.addTag(y);
        await later.saveTx();

        const refused = await undoJournal(result.journalId);
        assert.isFalse(refused.ok);
        assert.equal((refused as { reason: string }).reason, "drifted");

        const forced = await undoJournal(result.journalId, { force: true });
        assert.isTrue(forced.ok);
        assert.isFalse(later.hasTag(y));
      },
    );

    itx(
      "a throwing progress callback neither stops the run nor loses the snapshot",
      async function () {
        const [a, b, c, d] = [name("pa"), name("pb"), name("pc"), name("pd")];
        await makeItem([a]);
        await makeItem([c]);
        const allTags = await loadTags(libraryID);
        let calls = 0;
        const result = await applyOps({
          libraryID,
          allTags,
          ops: [
            { kind: "rename", from: await ref(a), to: b },
            { kind: "rename", from: await ref(c), to: d },
          ],
          kind: "rename",
          onProgress: () => {
            calls++;
            throw new TypeError("can't access dead object");
          },
        });

        assert.equal(calls, 2);
        assert.equal(result.status, "done");
        assert.equal(result.completedTasks, 2);
        assert.deepEqual(await typesOf(libraryID, d), [0]);
        const journal = await readJournal(result.journalId);
        assert.equal(journal.status, "done");
        assert.exists(journal.after);
        assert.isTrue((await undoJournal(result.journalId)).ok);
        assert.deepEqual(await typesOf(libraryID, a), [0]);
      },
    );

    itx(
      "undoes an interrupted run (no after snapshot) only when forced",
      async function () {
        const [x, y] = [name("ix"), name("iy")];
        const item = await makeItem([x]);
        const result = await rename(x, y);
        // Simulate a crash right after the first task.
        const journal = await readJournal(result.journalId);
        journal.status = "running";
        delete journal.after;
        await writeJournal(journal);

        const [latest] = (await listHistory(libraryID)).entries;
        assert.equal(latest?.id, result.journalId);
        assert.isTrue(latest?.interrupted);
        const refused = await undoJournal(result.journalId);
        assert.deepEqual(refused, { ok: false, reason: "interrupted" });
        assert.isTrue(item.hasTag(y));

        const forced = await undoJournal(result.journalId, { force: true });
        assert.isTrue(forced.ok);
        assert.isTrue(item.hasTag(x));
        assert.isFalse(item.hasTag(y));
      },
    );

    itx(
      "lists unreadable journals apart from the library's runs",
      async function () {
        const [x, y] = [name("jx"), name("jy")];
        await makeItem([x]);
        const result = await rename(x, y);
        const brokenID = `${newJournalID()}-broken`;
        const broken = PathUtils.join(
          Zotero.DataDirectory.dir,
          "tagwiz",
          `${brokenID}.json`,
        );
        await IOUtils.writeUTF8(broken, '{"version": 1, "id": "trunc');
        try {
          const found = await listHistory(libraryID);
          assert.equal(found.entries[0]?.id, result.journalId);
          assert.deepEqual(found.unreadable, [brokenID]);
        } finally {
          await IOUtils.remove(broken, { ignoreAbsent: true });
        }
      },
    );

    itx(
      "writes journals without leaving temporary files behind",
      async function () {
        const [x, y] = [name("wx"), name("wy")];
        await makeItem([x]);
        const result = await rename(x, y);
        const dir = PathUtils.join(Zotero.DataDirectory.dir, "tagwiz");
        const tmpFiles = async () =>
          ((await IOUtils.getChildren(dir)) as string[]).filter((p) =>
            p.endsWith(".tmp"),
          );
        assert.deepEqual(await tmpFiles(), []);
        assert.equal((await readJournal(result.journalId)).status, "done");

        // A write interrupted by a crash leaves its temporary file; the next
        // prune removes it.
        const stray = PathUtils.join(dir, `${result.journalId}.json.tmp`);
        await IOUtils.writeUTF8(stray, '{"trunc');
        await pruneJournals();
        assert.deepEqual(await tmpFiles(), []);
        assert.equal((await readJournal(result.journalId)).status, "done");
      },
    );

    /** Journal-shaped data for files written straight to disk. */
    const fakeJournal = (id: string, library: number) => ({
      version: 1 as const,
      id,
      createdAt: new Date().toISOString(),
      libraryID: library,
      status: "done" as const,
      kind: "rename" as const,
      tasks: [],
      completedTasks: 0,
      before: [],
    });
    const journalPath = (id: string) =>
      PathUtils.join(Zotero.DataDirectory.dir, "tagwiz", `${id}.json`);

    itx(
      "treats a parseable journal of the wrong shape as unreadable",
      async function () {
        const id = `${newJournalID()}-shape`;
        const { before: _before, ...damaged } = fakeJournal(id, libraryID);
        await IOUtils.writeJSON(journalPath(id), damaged);
        try {
          let error: unknown;
          try {
            await readJournal(id);
          } catch (e) {
            error = e;
          }
          assert.exists(error);
          assert.include((await listHistory(libraryID)).unreadable, id);
        } finally {
          await IOUtils.remove(journalPath(id), { ignoreAbsent: true });
        }
      },
    );

    itx(
      "treats a journal without a recorded kind as unreadable",
      async function () {
        const id = `${newJournalID()}-nokind`;
        const { kind: _kind, ...old } = fakeJournal(id, libraryID);
        await IOUtils.writeJSON(journalPath(id), old);
        try {
          assert.include((await listHistory(libraryID)).unreadable, id);
        } finally {
          await IOUtils.remove(journalPath(id), { ignoreAbsent: true });
        }
      },
    );

    itx(
      "new journals sort after existing ones even if the clock went back",
      async function () {
        const future = "9999-12-31T00-00-00-000Z";
        await writeJournal(fakeJournal(future, -1));
        const x = name("cx");
        await makeItem([x]);
        let result: Awaited<ReturnType<typeof rename>> | undefined;
        try {
          result = await rename(x, name("cy"));
          // listJournalIDs sorts by plain string order.
          assert.isTrue(result.journalId > future, result.journalId);
          assert.equal((await listJournalIDs())[0], result.journalId);
        } finally {
          await IOUtils.remove(journalPath(future), { ignoreAbsent: true });
          if (result) {
            await IOUtils.remove(journalPath(result.journalId), {
              ignoreAbsent: true,
            });
          }
        }
      },
    );

    itx(
      "keeps the newest journals of each library when pruning",
      async function () {
        // Libraries that do not exist: prune only reads their IDs.
        const [quiet, busy] = [-2, -3];
        const base = newJournalID();
        const quietID = `${base}-a`;
        const busyIDs = Array.from(
          { length: 12 },
          (_, i) => `${base}-b${String(i).padStart(2, "0")}`,
        );
        await writeJournal(fakeJournal(quietID, quiet));
        for (const id of busyIDs) await writeJournal(fakeJournal(id, busy));
        try {
          await pruneJournals();
          const ids = await listJournalIDs();
          assert.include(ids, quietID, "another library's journal is kept");
          const keptBusy = busyIDs.filter((id) => ids.includes(id));
          // Newest first: the two oldest of the busy library are dropped.
          assert.deepEqual(keptBusy, busyIDs.slice(2));
        } finally {
          for (const id of [quietID, ...busyIDs]) {
            await IOUtils.remove(journalPath(id), { ignoreAbsent: true });
          }
        }
      },
    );

    // it, not itx: itx would turn this.skip() into a failure.
    it("writes the journal a constant number of times, not once per task", async function () {
      const desc = Object.getOwnPropertyDescriptor(IOUtils, "writeJSON");
      if (!desc?.writable) this.skip();
      const ops: Op[] = [];
      for (let i = 0; i < 6; i++) {
        const x = name("wc");
        await makeItem([x]);
        ops.push({ kind: "rename", from: await ref(x), to: name("wd") });
      }
      const allTags = await loadTags(libraryID);
      const original = IOUtils.writeJSON;
      let writes = 0;
      (IOUtils as any).writeJSON = function (...args: unknown[]) {
        writes++;
        return (original as any).apply(IOUtils, args);
      };
      try {
        const result = await applyOps({
          libraryID,
          allTags,
          ops,
          kind: "rename",
        });
        assert.equal(result.completedTasks, 6);
      } finally {
        (IOUtils as any).writeJSON = original;
      }
      // Once before the first task, once with the after snapshot.
      assert.equal(writes, 2);
    });

    itx(
      "a run that changed nothing keeps the previous run undoable",
      async function () {
        const [x, y, gone] = [name("na"), name("nb"), name("ng")];
        await makeItem([x]);
        const first = await rename(x, y);
        assert.notEqual(first.journalId, "");

        const goneItem = await makeItem([gone]);
        const allTags = await loadTags(libraryID);
        const from = await ref(gone);
        goneItem.removeTag(gone);
        await goneItem.saveTx();
        const second = await applyOps({
          libraryID,
          allTags,
          ops: [{ kind: "rename", from, to: name("nh") }],
          kind: "rename",
        });

        assert.equal(second.skippedTasks, 1);
        assert.equal(second.journalId, "");
        const [latest] = (await listHistory(libraryID)).entries;
        assert.equal(latest?.id, first.journalId);
      },
    );

    itx(
      "ignores files in the journal folder that are not journals",
      async function () {
        const dir = PathUtils.join(Zotero.DataDirectory.dir, "tagwiz");
        const foreign = PathUtils.join(dir, "notes.json");
        await IOUtils.makeDirectory(dir, { ignoreExisting: true });
        await IOUtils.writeJSON(foreign, { not: "a journal" });
        const x = name("fx");
        await makeItem([x]);
        let result: Awaited<ReturnType<typeof rename>> | undefined;
        try {
          assert.notInclude(await listJournalIDs(), "notes");
          result = await rename(x, name("fy"));
          assert.match(result.journalId, /^\d{4}-\d{2}-\d{2}T/);
          assert.equal((await listJournalIDs())[0], result.journalId);
          assert.deepEqual((await listHistory(libraryID)).unreadable, []);
        } finally {
          await IOUtils.remove(foreign, { ignoreAbsent: true });
        }
      },
    );
  });

  describe("history", function () {
    const snapshot = async (tags: string[]) =>
      (await captureStates(libraryID, tags)).map((t) => ({
        name: t.name,
        items: t.items.map((i) => `${i.id}:${i.type}`).sort(),
      }));

    itx(
      "lists this library's runs newest first, with kind and changed items",
      async function () {
        const [a, b, c] = [name("ha"), name("hb"), name("hc")];
        await makeItem([a]);
        await makeItem([a, b]);
        await makeItem([b]);
        const first = await applyOps({
          libraryID,
          ops: [{ kind: "rename", from: await ref(a), to: b }],
          allTags: await loadTags(libraryID),
          kind: "merge",
        });
        const second = await applyOps({
          libraryID,
          ops: [{ kind: "remove", tag: await ref(b) }],
          allTags: await loadTags(libraryID),
          kind: "remove",
        });
        await makeItem([c]);
        const third = await rename(c, name("hd"));

        const { entries } = await listHistory(libraryID);
        const ids = entries.map((e) => e.id);
        assert.deepEqual(ids.slice(0, 3), [
          third.journalId,
          second.journalId,
          first.journalId,
        ]);
        const [l, r, m] = entries;
        // The item that carried only b keeps it: 2 of 3 items change.
        assert.include(m, { kind: "merge", items: 2, status: "done" });
        assert.include(r, { kind: "remove", items: 3 });
        assert.include(l, { kind: "rename", items: 1, interrupted: false });
        assert.equal((await readJournal(first.journalId)).kind, "merge");
      },
    );

    itx(
      "restores the state before an older run, undoing the newer ones",
      async function () {
        const [a, b, c] = [name("ra"), name("rb"), name("rc")];
        await makeItem([a]);
        await makeItem([a, b]);
        const tags = [a, b, c];
        const initial = await snapshot(tags);
        const first = await rename(a, b);
        const second = await rename(b, c);
        const third = await run([{ kind: "remove", tag: await ref(c) }]);

        const result = await undoTo(libraryID, first.journalId);
        assert.deepEqual(result, { ok: true, steps: 3 });
        assert.deepEqual(await snapshot(tags), initial);
        for (const id of [first, second, third].map((r) => r.journalId)) {
          assert.equal((await readJournal(id)).status, "undone");
        }
      },
    );

    itx("passes over runs that were undone already", async function () {
      const [a, b, c] = [name("sa"), name("sb"), name("sc")];
      await makeItem([a]);
      const initial = await snapshot([a, b, c]);
      const first = await rename(a, b);
      const second = await rename(b, c);
      assert.isTrue((await undoJournal(second.journalId)).ok);

      const result = await undoTo(libraryID, first.journalId);
      assert.deepEqual(result, { ok: true, steps: 1 });
      assert.deepEqual(await snapshot([a, b, c]), initial);
    });

    itx(
      "stops at a run whose tags changed since, and goes on when it is forced",
      async function () {
        const [a, b, c] = [name("da"), name("db"), name("dc")];
        await makeItem([a]);
        const later = await makeItem([]);
        const initial = await snapshot([a, b, c]);
        const first = await rename(a, b);
        // Changed between the two runs: undoing the second one restores b
        // on `later` too, which then differs from the first run's `after`.
        later.addTag(b);
        await later.saveTx();
        const second = await rename(b, c);

        const refused = await undoTo(libraryID, first.journalId);
        assert.deepInclude(refused, {
          ok: false,
          reason: "drifted",
          journalID: first.journalId,
          steps: 1,
        });
        assert.equal((await readJournal(second.journalId)).status, "undone");

        const forced = await undoTo(libraryID, first.journalId, {
          forceRun: first.journalId,
        });
        assert.deepEqual(forced, { ok: true, steps: 1 });
        assert.deepEqual(await snapshot([a, b, c]), initial);
      },
    );

    describe("edge cases", function () {
      itx(
        "undoes and redoes ten runs in one go, and parts of them",
        async function () {
          this.timeout(120000);
          const tags = Array.from({ length: 11 }, () => name("deep"));
          await makeItem([tags[0]]);
          await makeItem([tags[0]]);
          // states[i]: before run i; states[10]: after the last one.
          const states = [await snapshot(tags)];
          const ids: string[] = [];
          for (let i = 0; i < 10; i++) {
            ids.push((await rename(tags[i], tags[i + 1])).journalId);
            states.push(await snapshot(tags));
          }

          assert.deepEqual(await undoTo(libraryID, ids[0]), {
            ok: true,
            steps: 10,
          });
          assert.deepEqual(await snapshot(tags), states[0]);
          assert.deepEqual(await redoTo(libraryID, ids[9]), {
            ok: true,
            steps: 10,
          });
          assert.deepEqual(await snapshot(tags), states[10]);
          assert.deepEqual(await undoTo(libraryID, ids[5]), {
            ok: true,
            steps: 5,
          });
          assert.deepEqual(await snapshot(tags), states[5]);
          assert.deepEqual(await redoTo(libraryID, ids[7]), {
            ok: true,
            steps: 3,
          });
          assert.deepEqual(await snapshot(tags), states[8]);
          // ids[8] and ids[9] are still undone and can be redone later.
          const { entries } = await listHistory(libraryID);
          const status = (id: string) =>
            entries.find((e) => e.id === id)?.status;
          assert.equal(status(ids[8]), "undone");
          assert.equal(status(ids[7]), "done");
        },
      );

      itx(
        "undoes and redoes a retype and a removal of a colored tag",
        async function () {
          const [x, z] = [name("tx"), name("tz")];
          await makeItem([x]);
          await makeItem([{ tag: x, type: 1 }]);
          await makeItem([z]);
          await color(z, "#0000FF");
          const retype = await applyOps({
            libraryID,
            ops: [{ kind: "retype", tag: await ref(x, 1), toType: 0 }],
            allTags: await loadTags(libraryID),
            kind: "duplicates",
          });
          const remove = await run([{ kind: "remove", tag: await ref(z) }]);
          assert.deepEqual(await typesOf(libraryID, x), [0]);
          assert.isUndefined(colorOf(z));

          assert.deepEqual(await undoTo(libraryID, retype.journalId), {
            ok: true,
            steps: 2,
          });
          assert.sameMembers(await typesOf(libraryID, x), [0, 1]);
          assert.deepEqual(await typesOf(libraryID, z), [0]);
          assert.equal(colorOf(z), "#0000FF");

          assert.deepEqual(await redoTo(libraryID, remove.journalId), {
            ok: true,
            steps: 2,
          });
          assert.deepEqual(await typesOf(libraryID, x), [0]);
          assert.deepEqual(await typesOf(libraryID, z), []);
          assert.isUndefined(colorOf(z));
        },
      );

      itx(
        "copes with an item erased between the run, the undo and the redo",
        async function () {
          const [x, y] = [name("ex"), name("ey")];
          const kept = await makeItem([x]);
          const first = await makeItem([x]);
          const result = await rename(x, y);
          await first.eraseTx();

          assert.deepEqual(await undoJournal(result.journalId), {
            ok: false,
            reason: "drifted",
            driftedTags: [y],
          });
          assert.deepEqual(
            await undoJournal(result.journalId, { force: true }),
            { ok: true },
          );
          assert.isTrue(kept.hasTag(x) && !kept.hasTag(y));

          // `before` still lists the erased item: redo sees x as changed.
          assert.deepEqual(await redoJournal(result.journalId), {
            ok: false,
            reason: "drifted",
            driftedTags: [x],
          });
          assert.deepEqual(
            await redoJournal(result.journalId, { force: true }),
            { ok: true },
          );
          assert.isTrue(kept.hasTag(y) && !kept.hasTag(x));
        },
      );

      itx(
        "lists every status change at once, even within one second",
        async function () {
          const [x, y] = [name("cx"), name("cy")];
          await makeItem([x]);
          const result = await rename(x, y);
          const status = async () =>
            (await listHistory(libraryID)).entries.find(
              (e) => e.id === result.journalId,
            )?.status;
          assert.equal(await status(), "done"); // now cached
          // File systems that keep modification times to the second (FAT,
          // network drives) must not serve the cached summary.
          assert.isTrue((await undoJournal(result.journalId)).ok);
          assert.equal(await status(), "undone");
          assert.isTrue((await redoJournal(result.journalId)).ok);
          assert.equal(await status(), "done");
        },
      );

      itx("leaves another library's undone runs alone", async function () {
        const otherID = `${newJournalID()}-other`;
        await writeJournal({
          version: 1,
          id: otherID,
          createdAt: new Date().toISOString(),
          libraryID: -1,
          status: "undone",
          undoneStatus: "done",
          kind: "rename",
          tasks: [],
          completedTasks: 0,
          before: [],
          after: [],
        });
        try {
          const x = name("ox");
          await makeItem([x]);
          const result = await rename(x, name("oy"));
          assert.notEqual(result.journalId, "");

          assert.equal((await readJournal(otherID)).status, "undone");
          const ids = (await listHistory(libraryID)).entries.map((e) => e.id);
          assert.notInclude(ids, otherID);
          assert.include(
            (await listHistory(-1)).entries.map((e) => e.id),
            otherID,
          );
        } finally {
          await deleteJournal(otherID);
        }
      });

      itx("takes nothing when the selected run is gone", async function () {
        const [x, y] = [name("gx"), name("gy")];
        await makeItem([x]);
        const result = await rename(x, y);
        assert.isTrue((await undoJournal(result.journalId)).ok);
        await deleteJournal(result.journalId);

        assert.deepEqual(await redoTo(libraryID, result.journalId), {
          ok: false,
          reason: "not-found",
        });
        assert.deepEqual(await typesOf(libraryID, x), [0]);
      });
    });

    itx("reports a run that is no longer kept", async function () {
      assert.deepEqual(await undoTo(libraryID, "missing"), {
        ok: false,
        reason: "not-found",
      });
    });

    itx(
      "redo brings back the run's tags, types, colors and status",
      async function () {
        const [x, y] = [name("ya"), name("yb")];
        await makeItem([{ tag: x, type: 1 }]);
        await makeItem([y]);
        await color(x, "#00FF00");
        const state = async () =>
          (await captureStates(libraryID, [x, y])).map((t) => ({
            name: t.name,
            color: t.color?.color,
            items: t.items.map((i) => `${i.id}:${i.type}`).sort(),
          }));
        const initial = await state();
        const result = await rename(x, y, 1);
        const applied = await state();
        // A cancelled run keeps that status through undo and redo.
        const journal = await readJournal(result.journalId);
        journal.status = "cancelled";
        await writeJournal(journal);

        assert.deepEqual(await undoJournal(result.journalId), { ok: true });
        assert.deepEqual(await state(), initial);
        assert.deepEqual(await redoJournal(result.journalId), { ok: true });
        assert.deepEqual(await state(), applied);
        const redone = await readJournal(result.journalId);
        assert.equal(redone.status, "cancelled");
        assert.notProperty(redone, "undoneStatus");
        assert.deepEqual(await redoJournal(result.journalId), {
          ok: false,
          reason: "not-undone",
        });
      },
    );

    itx(
      "refuses to redo when the tags changed after the undo, unless forced",
      async function () {
        const [x, y] = [name("za"), name("zb")];
        const item = await makeItem([x]);
        const later = await makeItem([]);
        const result = await rename(x, y);
        assert.isTrue((await undoJournal(result.journalId)).ok);
        later.addTag(x);
        await later.saveTx();

        assert.deepEqual(await redoJournal(result.journalId), {
          ok: false,
          reason: "drifted",
          driftedTags: [x],
        });
        const forced = await redoJournal(result.journalId, { force: true });
        assert.isTrue(forced.ok);
        assert.isTrue(item.hasTag(y));
        assert.isFalse(later.hasTag(x));
      },
    );

    itx("cannot redo an interrupted run", async function () {
      const [x, y] = [name("ia"), name("ib")];
      await makeItem([x]);
      const result = await rename(x, y);
      const journal = await readJournal(result.journalId);
      journal.status = "running";
      delete journal.after;
      await writeJournal(journal);
      assert.isTrue((await undoJournal(result.journalId, { force: true })).ok);

      const interrupted = { ok: false, reason: "interrupted" } as const;
      assert.deepEqual(await redoJournal(result.journalId), interrupted);
      assert.deepEqual(
        await redoJournal(result.journalId, { force: true }),
        interrupted,
      );
      assert.deepEqual(await redoTo(libraryID, result.journalId), {
        ok: false,
        reason: "not-found",
      });
    });

    itx(
      "redoes undone runs oldest first, up to the selected one",
      async function () {
        const [a, b, c] = [name("wa"), name("wb"), name("wc")];
        await makeItem([a]);
        await makeItem([a, b]);
        const tags = [a, b, c];
        const initial = await snapshot(tags);
        const first = await rename(a, b);
        const afterFirst = await snapshot(tags);
        const second = await rename(b, c);
        const afterSecond = await snapshot(tags);
        assert.deepEqual(await undoTo(libraryID, first.journalId), {
          ok: true,
          steps: 2,
        });

        assert.deepEqual(await redoTo(libraryID, first.journalId), {
          ok: true,
          steps: 1,
        });
        assert.deepEqual(await snapshot(tags), afterFirst);
        assert.equal((await readJournal(second.journalId)).status, "undone");
        assert.deepEqual(await redoTo(libraryID, second.journalId), {
          ok: true,
          steps: 1,
        });
        assert.deepEqual(await snapshot(tags), afterSecond);

        assert.deepEqual(await undoTo(libraryID, first.journalId), {
          ok: true,
          steps: 2,
        });
        assert.deepEqual(await snapshot(tags), initial);
        assert.deepEqual(await redoTo(libraryID, second.journalId), {
          ok: true,
          steps: 2,
        });
        assert.deepEqual(await snapshot(tags), afterSecond);
      },
    );

    itx(
      "a new edit discards the undone runs, one that changed nothing does not",
      async function () {
        const [a, b, c, gone] = [
          name("ka"),
          name("kb"),
          name("kc"),
          name("kg"),
        ];
        await makeItem([a]);
        await rename(a, b);
        const second = await rename(b, c);
        assert.isTrue((await undoJournal(second.journalId)).ok);

        const goneItem = await makeItem([gone]);
        const allTags = await loadTags(libraryID);
        const from = await ref(gone);
        goneItem.removeTag(gone);
        await goneItem.saveTx();
        const nothing = await applyOps({
          libraryID,
          allTags,
          ops: [{ kind: "rename", from, to: name("kh") }],
          kind: "rename",
        });
        assert.equal(nothing.journalId, "");
        const ids = async () =>
          (await listHistory(libraryID)).entries.map((e) => e.id);
        assert.include(await ids(), second.journalId);

        const third = await rename(b, name("kd"));
        assert.notEqual(third.journalId, "");
        assert.notInclude(await ids(), second.journalId);
        assert.deepEqual(await redoTo(libraryID, second.journalId), {
          ok: false,
          reason: "not-found",
        });
      },
    );
  });

  describe("tagStore", function () {
    itx(
      "scopes tags to a collection and optionally its subcollections",
      async function () {
        const parent = await makeCollection();
        const child = await makeCollection(parent);
        const [inParent, inChild, outside] = [name("p"), name("c"), name("o")];
        await makeItem([inParent], parent);
        await makeItem([inChild, inParent], child);
        await makeItem([outside, inParent]);

        const flat = await loadTags(libraryID, {
          collectionID: parent.id,
          includeSubcollections: false,
        });
        const deep = await loadTags(libraryID, {
          collectionID: parent.id,
          includeSubcollections: true,
        });
        const names = (tags: TagRef[]) =>
          tags
            .map((t) => t.name)
            .filter((t) => t.startsWith(prefix))
            .sort();

        assert.deepEqual(names(flat), [inParent]);
        assert.deepEqual(names(deep), [inChild, inParent].sort());
        const p = deep.find((t) => t.name === inParent)!;
        assert.equal(p.itemCount, 3);
        assert.equal(p.scopeCount, 2);
      },
    );

    itx(
      "measures how many affected items are outside the scope",
      async function () {
        const col = await makeCollection();
        const x = name("mx");
        await makeItem([x], col);
        await makeItem([x]);

        const impact = await measureImpact(libraryID, [x], {
          collectionID: col.id,
          includeSubcollections: true,
        });

        assert.deepEqual(impact, { total: 2, outsideScope: 1 });
      },
    );

    itx(
      "counts child items of the collection's items as inside the scope",
      async function () {
        const col = await makeCollection();
        const x = name("cn");
        const parent = await makeItem([], col);
        const note = new Zotero.Item("note");
        note.libraryID = libraryID;
        note.parentID = parent.id;
        note.setNote(`${prefix}note`);
        note.setTags([x]);
        await note.saveTx();
        itemsToErase.push(note);
        const scope = { collectionID: col.id, includeSubcollections: true };

        const listed = (await loadTags(libraryID, scope)).find(
          (t) => t.name === x,
        );
        assert.equal(listed?.scopeCount, 1);
        assert.deepEqual(await measureImpact(libraryID, [x], scope), {
          total: 1,
          outsideScope: 0,
        });
      },
    );
  });
});
