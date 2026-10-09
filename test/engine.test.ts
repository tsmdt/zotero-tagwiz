/* eslint-disable mocha/no-setup-in-describe, mocha/consistent-spacing-between-blocks -- itx() is a thin wrapper around it() that makes errors readable */
import { assert } from "chai";
import type { Op, TagRef, TagType } from "../src/core/types";
import { applyOps, undoJournal } from "../src/zotero/engine";
import { preflight } from "../src/zotero/guard";
import {
  latestUndoable,
  listJournalIDs,
  newJournalID,
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
    const collection = new Zotero.Collection();
    collection.libraryID = libraryID;
    collection.name = `${prefix}col${n++}`;
    if (parent) collection.parentID = parent.id;
    await collection.saveTx();
    collectionsToErase.push(collection);
    return collection;
  }

  async function color(tag: string, value: string | false) {
    await Zotero.DB.executeTransaction(async () => {
      await Zotero.Tags.setColor(libraryID, tag, value as string);
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

  async function run(ops: Op[]) {
    return applyOps({ libraryID, ops, allTags: await loadTags(libraryID) });
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
        createdAt: "",
        libraryID,
        status: "done",
        tasks: [],
        completedTasks: 0,
        before: [],
      });
      assert.equal((await readJournal(id)).id, id);
      assert.include(await listJournalIDs(), id);
    });

    itx(
      "7. snapshots from the old tagcleaner folder are migrated",
      async function () {
        const legacyDir = PathUtils.join(
          Zotero.DataDirectory.dir,
          "tagcleaner",
        );
        await IOUtils.makeDirectory(legacyDir, { ignoreExisting: true });
        const id = `${newJournalID()}-legacy`;
        const legacyFile = PathUtils.join(legacyDir, `${id}.json`);
        await IOUtils.writeJSON(legacyFile, {
          version: 1,
          id,
          createdAt: "",
          libraryID,
          status: "done",
          tasks: [],
          completedTasks: 0,
          before: [],
        });

        assert.include(await listJournalIDs(), id);
        assert.isFalse(await IOUtils.exists(legacyFile));
        assert.equal((await readJournal(id)).id, id);

        await IOUtils.remove(
          PathUtils.join(Zotero.DataDirectory.dir, "tagwiz", `${id}.json`),
          { ignoreAbsent: true },
        );
      },
    );
  });

  itx("preflight accepts the user library", function () {
    assert.isTrue(preflight(libraryID).ok);
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

        const latest = await latestUndoable(libraryID);
        assert.equal(latest?.id, result.journalId);
        const refused = await undoJournal(result.journalId);
        assert.deepEqual(refused, { ok: false, reason: "interrupted" });
        assert.isTrue(item.hasTag(y));

        const forced = await undoJournal(result.journalId, { force: true });
        assert.isTrue(forced.ok);
        assert.isTrue(item.hasTag(x));
        assert.isFalse(item.hasTag(y));
      },
    );

    itx("skips unreadable journal files", async function () {
      const [x, y] = [name("jx"), name("jy")];
      await makeItem([x]);
      const result = await rename(x, y);
      const broken = PathUtils.join(
        Zotero.DataDirectory.dir,
        "tagwiz",
        `${newJournalID()}-broken.json`,
      );
      await IOUtils.writeUTF8(broken, '{"version": 1, "id": "trunc');
      try {
        const latest = await latestUndoable(libraryID);
        assert.equal(latest?.id, result.journalId);
      } finally {
        await IOUtils.remove(broken, { ignoreAbsent: true });
      }
    });
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
  });
});
