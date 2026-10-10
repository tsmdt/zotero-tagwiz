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
    const [id] = await newJournals(before);
    const journal = await readJournal(id);
    assert.oneOf(journal.status, ["cancelled", "done"]);
    assert.exists(journal.after);
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
      ["automatic", "both", "manual"],
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

    // The widths survive a re-render, and a double-click restores the defaults.
    dialog.renderAll();
    assert.approximately(width("type"), type + 40, 1);
    th("type")
      .querySelector(".tw-col-resizer")!
      .dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
    assert.isUndefined(dialog.columnWidths);
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
