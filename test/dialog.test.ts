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

  async function makeItem(tags: string[]) {
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
      ...win.document.querySelectorAll<HTMLElement>(".tc-swatch"),
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
