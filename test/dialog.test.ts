import { assert } from "chai";
import { config } from "../package.json";
import {
  addLegacyMenuItems,
  unregisterLegacyMenus,
} from "../src/modules/menus";
import { TagWizDialog } from "../src/ui/dialog";
import { listJournalIDs, readJournal } from "../src/zotero/journal";
import { getColorList, typesOf } from "../src/zotero/tagStore";

/**
 * UI tests: they open the real TagWiz window and drive the dialog through its
 * (private) methods. Like engine.test.ts, everything is namespaced by a
 * per-run prefix and erased afterwards.
 */
describe("dialog (in Zotero)", function () {
  this.timeout(30000);

  let libraryID: number;
  let prefix: string;
  let n = 0;
  const name = (label: string) => `${prefix}${label}${n++}`;
  const itemsToErase: Zotero.Item[] = [];
  const windows: Window[] = [];

  async function makeItem(tags: Array<string | { tag: string; type: number }>) {
    const item = new Zotero.Item("book");
    item.libraryID = libraryID;
    item.setTags(tags);
    await item.saveTx();
    itemsToErase.push(item);
    return item;
  }

  async function openDialog() {
    const win = Services.ww.openWindow(
      null as any,
      `chrome://${config.addonRef}/content/dialog.xhtml`,
      "_blank",
      "chrome,width=800,height=600",
      null as any,
    ) as unknown as Window;
    windows.push(win);
    for (let i = 0; i < 500; i++) {
      if (win.document?.getElementById("tagwiz-root")) break;
      await Zotero.Promise.delay(20);
    }
    const dialog = new TagWizDialog(win, { libraryID });
    await dialog.init();
    // The tests reach into private state on purpose.
    return { win, dialog: dialog as any };
  }

  async function newJournals(before: Set<string>) {
    return (await listJournalIDs()).filter((id) => !before.has(id));
  }

  before(function () {
    libraryID = Zotero.Libraries.userLibraryID;
    prefix = `__twd${Date.now().toString(36)}_`;
    // src/ modules reach the plugin instance through the `addon` global.
    (globalThis as any).addon ??= (Zotero as any)[config.addonInstance];
  });

  async function setColor(tag: string, color: string | false) {
    await Zotero.DB.executeTransaction(async () => {
      // Falsy clears; no position appends. The typings require both.
      await Zotero.Tags.setColor(
        libraryID,
        tag,
        color as string,
        undefined as unknown as number,
      );
    });
  }

  afterEach(async function () {
    for (const win of windows.splice(0)) if (!win.closed) win.close();
    for (const { name: tag } of getColorList(libraryID)) {
      if (tag.startsWith(prefix)) await setColor(tag, false);
    }
    for (const item of itemsToErase.splice(0)) {
      if (await Zotero.Items.getAsync(item.id)) await item.eraseTx();
    }
    await Zotero.DB.executeTransaction(async () => {
      await Zotero.Tags.purge();
    });
  });

  it("a double click on Apply starts only one run", async function () {
    const tag = name("dbl");
    await makeItem([tag]);
    const { dialog } = await openDialog();
    dialog.tab = "remove";
    dialog.selected = new Set([tag]);
    dialog.renderAll();
    let confirms = 0;
    dialog.confirm = () => {
      confirms++;
      return true;
    };
    const before = new Set(await listJournalIDs());

    await Promise.all([dialog.apply(), dialog.apply()]);

    assert.equal(confirms, 1);
    assert.lengthOf(await newJournals(before), 1);
    assert.deepEqual(await typesOf(libraryID, tag), []);
  });

  it("closing the window during a run stops it, then closes", async function () {
    const tags = Array.from({ length: 30 }, () => name("cl"));
    for (const tag of tags) await makeItem([tag]);
    const { win, dialog } = await openDialog();
    dialog.tab = "remove";
    dialog.selected = new Set(tags);
    dialog.renderAll();
    dialog.confirm = () => true;
    const before = new Set(await listJournalIDs());

    const run = dialog.apply();
    // Wait until the run has passed the confirmation and shows progress.
    for (let i = 0; i < 1000 && dialog.status.text === ""; i++) {
      await Zotero.Promise.delay(0);
    }
    assert.notEqual(dialog.status.text, "", "the run should have started");
    const close = new win.Event("close", { cancelable: true });
    win.dispatchEvent(close);
    await run;

    assert.isTrue(close.defaultPrevented, "close must wait for the run");
    assert.isTrue(win.closed, "window closes once the run stopped");
    const ids = await newJournals(before);
    let removed = 0;
    for (const tag of tags) {
      if (!(await typesOf(libraryID, tag)).length) removed++;
    }
    if (removed) {
      assert.lengthOf(ids, 1, "a run that changed tags keeps its journal");
      const journal = await readJournal(ids[0]);
      assert.oneOf(journal.status, ["cancelled", "done"]);
      assert.exists(journal.after);
    } else {
      // Stopped before the first change: nothing to undo, no journal.
      assert.lengthOf(ids, 0);
    }
  });

  it("closing the window when idle is not blocked", async function () {
    const { win } = await openDialog();
    const close = new win.Event("close", { cancelable: true });
    win.dispatchEvent(close);
    assert.isFalse(close.defaultPrevented);
  });

  it("a synced tag color cannot inject other CSS", async function () {
    const [bad, good] = [name("css"), name("ok")];
    await makeItem([bad, good]);
    await setColor(bad, "red;background-image:url(https://example.invalid/x)");
    await setColor(good, "#FF0000");
    const { win, dialog } = await openDialog();
    dialog.filter = prefix;
    dialog.renderAll();

    const swatches = [
      ...win.document.querySelectorAll<HTMLElement>(".tw-color-dot"),
    ];
    assert.lengthOf(swatches, 2);
    for (const el of swatches) {
      assert.notInclude(el.getAttribute("style") ?? "", "url(");
      assert.equal(el.style.backgroundImage, "");
    }
    assert.isTrue(
      swatches.some((el) => el.style.backgroundColor === "rgb(255, 0, 0)"),
    );
  });

  it("clicking a count header sorts descending, ascending, then by name", async function () {
    const [a, b, c] = [name("a"), name("b"), name("c")];
    await makeItem([a, b, c]);
    await makeItem([b, c]);
    await makeItem([b]);
    const { win, dialog } = await openDialog();
    dialog.filter = prefix;
    dialog.renderAll();
    const doc = win.document;
    const header = doc.querySelector<HTMLButtonElement>(
      '.tw-sort-button[data-sort="items"]',
    )!;
    const listed = () =>
      [...doc.querySelectorAll(".tw-table tbody .tw-checkbox input")].map(
        (el) => el.getAttribute("aria-label"),
      );

    assert.deepEqual(listed(), [a, b, c]);
    header.click();
    assert.deepEqual(listed(), [b, c, a]);
    assert.equal(header.parentElement!.getAttribute("aria-sort"), "descending");
    header.click();
    assert.deepEqual(listed(), [a, c, b]);
    assert.equal(header.parentElement!.getAttribute("aria-sort"), "ascending");
    header.click();
    assert.deepEqual(listed(), [a, b, c]);
    assert.equal(header.parentElement!.getAttribute("aria-sort"), "none");
  });

  it("the Tag and Type headers sort by name and by manual/automatic", async function () {
    const [a, b, c] = [name("a"), name("b"), name("c")];
    await makeItem([{ tag: a, type: 1 }, b, c]);
    await makeItem([{ tag: b, type: 1 }]);
    const { win, dialog } = await openDialog();
    dialog.filter = prefix;
    dialog.renderAll();
    const doc = win.document;
    const header = (key: string) =>
      doc.querySelector<HTMLButtonElement>(
        `.tw-sort-button[data-sort="${key}"]`,
      )!;
    const listed = () =>
      [...doc.querySelectorAll(".tw-table tbody .tw-checkbox input")].map(
        (el) => el.getAttribute("aria-label"),
      );

    assert.equal(
      header("name").parentElement!.getAttribute("aria-sort"),
      "ascending",
    );
    assert.deepEqual(
      [...doc.querySelectorAll(".tw-table tbody .tw-tag-type")].map(
        (el) => el.textContent,
      ),
      ["auto", "both", "manual"],
    );
    header("name").click();
    assert.deepEqual(listed(), [c, b, a]);
    header("type").click();
    assert.deepEqual(listed(), [c, b, a], "manual, both, automatic");
    assert.equal(
      header("name").parentElement!.getAttribute("aria-sort"),
      "none",
    );
    header("type").click();
    assert.deepEqual(listed(), [a, b, c], "automatic, both, manual");
    header("type").click();
    assert.deepEqual(listed(), [a, b, c], "back to name order");
    assert.equal(
      header("name").parentElement!.getAttribute("aria-sort"),
      "ascending",
    );
  });

  it("Cancel is enabled only while tags are selected and deselects them", async function () {
    const [a, b] = [name("a"), name("b")];
    await makeItem([a, b]);
    const { win, dialog } = await openDialog();
    dialog.filter = prefix;
    dialog.renderAll();
    const doc = win.document;
    const selectAll = doc.querySelector<HTMLButtonElement>(".tw-select-all")!;
    const cancel = doc.querySelector<HTMLButtonElement>(".tw-select-none")!;
    const box = () =>
      doc.querySelector<HTMLInputElement>(
        `.tw-checkbox input[aria-label="${a}"]`,
      )!;

    assert.isTrue(cancel.disabled);
    selectAll.click();
    assert.deepEqual([...dialog.selected].sort(), [a, b]);
    assert.isFalse(cancel.disabled);
    cancel.click();
    assert.equal(dialog.selected.size, 0);
    assert.isTrue(cancel.disabled);

    // Ticking and unticking a tag by hand updates Cancel too.
    box().click();
    assert.deepEqual([...dialog.selected], [a]);
    assert.isFalse(cancel.disabled);
    box().click();
    assert.isTrue(cancel.disabled);
  });

  it("switching to Remove drops tags selected on another tab", async function () {
    const [a, b] = [name("ra"), name("rb")];
    await makeItem([a, b]);
    const { dialog } = await openDialog();
    dialog.filter = prefix;
    dialog.renderAll();
    dialog.selected = new Set([a, b]);
    dialog.switchTab("unify");
    assert.equal(dialog.selected.size, 2, "kept between non-destructive tabs");

    dialog.switchTab("remove");

    assert.equal(dialog.selected.size, 0);
    assert.lengthOf(dialog.plan.rows, 0);
  });

  it("counts selected tags the filter hides", async function () {
    const [a, b] = [name("ha"), name("hb")];
    await makeItem([a, b]);
    const { win, dialog } = await openDialog();
    dialog.filter = prefix;
    dialog.renderAll();
    win.document.querySelector<HTMLButtonElement>(".tw-select-all")!.click();
    // Fluent may wrap arguments in bidi isolation marks.
    const count = () =>
      win.document
        .querySelector(".tw-pane-header .tw-hint")!
        .textContent!.replace(/[\u2068\u2069]/g, "");
    assert.notInclude(count(), "not shown");

    dialog.filter = a;
    dialog.renderAll();

    assert.deepEqual([...dialog.selected].sort(), [a, b]);
    assert.include(count(), "1 not shown");
  });

  it("Select All right after typing a filter selects the new matches", async function () {
    const [match, other] = [name("fm"), name("fo")];
    await makeItem([match, other]);
    const { win, dialog } = await openDialog();
    dialog.filter = prefix;
    dialog.renderAll();
    const doc = win.document;
    const search = doc.querySelector<HTMLInputElement>('input[type="search"]')!;

    // Within the filter's debounce: the list still shows both tags.
    search.value = match;
    search.dispatchEvent(new win.Event("input"));
    doc.querySelector<HTMLButtonElement>(".tw-select-all")!.click();

    assert.deepEqual([...dialog.selected], [match]);
  });

  it("the Remove confirmation says it removes and names the tags", async function () {
    const tag = name("rc");
    await makeItem([tag]);
    const { dialog } = await openDialog();
    dialog.switchTab("remove");
    dialog.selected = new Set([tag]);
    dialog.refreshPlan();
    let asked: { title: string; text: string } | undefined;
    dialog.confirm = (title: string, text: string) => {
      asked = { title, text };
      return false;
    };

    await dialog.apply();

    assert.include(asked?.title ?? "", "Remove");
    assert.include(asked?.text ?? "", tag);
    assert.deepEqual(await typesOf(libraryID, tag), [0], "nothing removed");
  });

  /** Text without Fluent's bidi isolation marks. */
  const plain = (text: string) => text.replace(/[\u2068\u2069]/g, "");

  /** Wait until `check` holds, or fail after `ms`. */
  async function until(check: () => boolean, ms = 5000) {
    for (let waited = 0; !check(); waited += 50) {
      if (waited > ms) throw new Error("timed out");
      await Zotero.Promise.delay(50);
    }
  }

  it("switches an open window to another collection", async function () {
    const [inside, outside] = [name("in"), name("out")];
    const collection = new Zotero.Collection({
      libraryID,
      name: name("col"),
    });
    await collection.saveTx();
    try {
      const item = await makeItem([inside]);
      item.setCollections([collection.id]);
      await item.saveTx();
      await makeItem([outside]);
      const { win, dialog } = await openDialog();
      const listed = () =>
        dialog.rows
          .map((r: { name: string }) => r.name)
          .filter((n: string) => n.startsWith(prefix));
      assert.includeMembers(listed(), [inside, outside]);

      const switched = await dialog.setScope({
        libraryID,
        collection: { id: collection.id, name: collection.name },
      });

      assert.isTrue(switched);
      assert.deepEqual(listed(), [inside]);
      assert.include(
        plain(win.document.querySelector(".tw-header")!.textContent!),
        collection.name,
      );
    } finally {
      await collection.eraseTx();
    }
  });

  it("a reload still running when the scope changes does not win", async function () {
    const [inside, outside] = [name("rin"), name("rout")];
    const collection = new Zotero.Collection({
      libraryID,
      name: name("rcol"),
    });
    await collection.saveTx();
    try {
      const item = await makeItem([inside]);
      item.setCollections([collection.id]);
      await item.saveTx();
      await makeItem([outside]);
      const { dialog } = await openDialog();

      // A library-wide reload (e.g. from the Notifier), then the switch.
      const pending = dialog.reload();
      await dialog.setScope({
        libraryID,
        collection: { id: collection.id, name: collection.name },
      });
      await pending;

      const listed = dialog.rows
        .map((r: { name: string }) => r.name)
        .filter((n: string) => n.startsWith(prefix));
      assert.deepEqual(listed, [inside]);
    } finally {
      await collection.eraseTx();
    }
  });

  it("reloads when tags change elsewhere in Zotero", async function () {
    const { dialog } = await openDialog();
    const tag = name("ext");
    const has = () => dialog.rows.some((r: { name: string }) => r.name === tag);
    assert.isFalse(has());

    await makeItem([tag]);

    await until(has);
  });

  it("does not apply a plan that changed since it was shown", async function () {
    const [from, to] = [name("sf"), name("st")];
    await makeItem([from]);
    const { dialog } = await openDialog();
    dialog.switchTab("unify");
    dialog.selected = new Set([from]);
    dialog.unifyTarget = to;
    dialog.targetTouched = true;
    dialog.refreshPlan();
    assert.isFalse(dialog.plan.rows[0].merges, "a plain rename so far");
    let confirms = 0;
    dialog.confirm = () => {
      confirms++;
      return true;
    };

    // The target appears elsewhere: the rename would now merge into it.
    await makeItem([to]);
    await dialog.apply();

    assert.equal(confirms, 0);
    assert.equal(dialog.status.kind, "error");
    assert.deepEqual(await typesOf(libraryID, from), [0], "nothing applied");
    assert.isTrue(dialog.selected.has(from), "the selection is kept");
    assert.isTrue(dialog.plan.rows[0].merges, "the preview shows the merge");
  });

  it("locks everything but the footer during a run, and counts tags", async function () {
    const tag = name("lk");
    await makeItem([tag]);
    await makeItem([{ tag, type: 1 }]);
    const { dialog } = await openDialog();
    dialog.selected = new Set([tag]);
    dialog.caseOpts = { ...dialog.caseOpts, style: "upper" };
    dialog.refreshPlan();
    assert.lengthOf(dialog.plan.rows, 2, "manual and automatic rows");
    let seen: { inert: boolean; text: string } | undefined;
    dialog.confirm = (_title: string, text: string) => {
      seen = { inert: dialog.mainEl.hasAttribute("inert"), text: plain(text) };
      return true;
    };

    await dialog.apply();

    assert.isTrue(seen?.inert);
    assert.include(seen?.text ?? "", "Apply 1 change to 2 items");
    assert.isFalse(dialog.mainEl.hasAttribute("inert"));
    assert.isFalse(dialog.menuEl.hasAttribute("inert"));
  });

  it("counts only items that change when merging into a bigger tag", async function () {
    const [small, big] = [name("sm"), name("bg")];
    await makeItem([small]);
    for (let i = 0; i < 3; i++) await makeItem([big]);
    const { dialog } = await openDialog();
    dialog.switchTab("unify");
    dialog.selected = new Set([small]);
    dialog.unifyTarget = big;
    dialog.targetTouched = true;
    dialog.refreshPlan();
    let seen = "";
    dialog.confirm = (_title: string, text: string) => {
      seen = plain(text);
      return false;
    };

    await dialog.apply();

    assert.include(seen, "Apply 1 change to 1 item");
  });

  it("offers one survivor per name in a duplicate group", async function () {
    const lower = name("dupe");
    const upper = lower.toUpperCase();
    await makeItem([lower, upper]);
    await makeItem([{ tag: lower, type: 1 }]);
    const { win, dialog } = await openDialog();
    dialog.switchTab("duplicates");
    const group = [
      ...win.document.querySelectorAll(".tw-duplicate-group"),
    ].find((g) => g.textContent!.includes(lower))!;
    assert.exists(group);
    assert.lengthOf(group.querySelectorAll('input[type="radio"]'), 2);
  });

  it("the count column is labelled with the library's name", async function () {
    const { win } = await openDialog();
    const label = win.document.querySelector(
      '.tw-sort-button[data-sort="items"] .tw-sort-label',
    );
    const library = Zotero.Libraries.get(libraryID) as Zotero.Library;
    assert.equal(label?.textContent, library.name);
  });

  it("dragging a header's edge resizes only that column", async function () {
    const { win, dialog } = await openDialog();
    const doc = win.document;
    const th = (key: string) =>
      doc.querySelector<HTMLButtonElement>(
        `.tw-sort-button[data-sort="${key}"]`,
      )!.parentElement!;
    const width = (key: string) => th(key).getBoundingClientRect().width;
    const pointer = (target: EventTarget, type: string, clientX: number) =>
      target.dispatchEvent(
        new win.PointerEvent(type, { bubbles: true, button: 0, clientX }),
      );
    const [type, items] = [width("type"), width("items")];
    const grip = th("type").querySelector(".tw-col-resizer")!;
    const x = th("type").getBoundingClientRect().right;

    pointer(grip, "pointerdown", x);
    pointer(doc, "pointermove", x + 40);
    pointer(doc, "pointerup", x + 40);
    assert.approximately(width("type"), type + 40, 1);
    assert.approximately(width("items"), items, 1);
    // Each table keeps its own widths: the preview's are untouched.
    assert.isUndefined(dialog.columnWidths.preview);

    // The widths survive a re-render, and a double-click restores the defaults.
    dialog.renderAll();
    assert.approximately(width("type"), type + 40, 1);
    th("type")
      .querySelector(".tw-col-resizer")!
      .dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
    assert.isUndefined(dialog.columnWidths.tags);
    assert.approximately(width("type"), type, 1);
  });

  describe("legacy menus", function () {
    it("are added once per window and removed per window", function () {
      const win = Zotero.getMainWindow();
      const count = () =>
        win.document.querySelectorAll(
          "#tagwiz-menu-collection, #tagwiz-menu-tools",
        ).length;
      const already = count();
      try {
        addLegacyMenuItems(win);
        addLegacyMenuItems(win);
        assert.equal(count(), already + 2);
        unregisterLegacyMenus(win);
        assert.equal(count(), already);
      } finally {
        unregisterLegacyMenus(win);
      }
    });
  });
});
