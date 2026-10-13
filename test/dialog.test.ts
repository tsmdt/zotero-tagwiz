import { assert } from "chai";
import { config } from "../package.json";
import {
  addLegacyMenuItems,
  unregisterLegacyMenus,
} from "../src/modules/menus";
import { TagWizDialog } from "../src/ui/dialog";
import { applyOps } from "../src/zotero/engine";
import {
  deleteJournal,
  listJournalIDs,
  newJournalID,
  readJournal,
  writeJournal,
} from "../src/zotero/journal";
import { getColorList, loadTags, typesOf } from "../src/zotero/tagStore";

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

  it("highlights the selected tags", async function () {
    const tag = name("hl");
    await makeItem([tag]);
    const { dialog } = await openDialog();
    dialog.filter = tag;
    dialog.renderAll();
    const row = () => dialog.leftEl.querySelector("tbody tr") as HTMLElement;
    const highlighted = () => row().classList.contains("tw-row-selected");
    assert.isFalse(highlighted());

    (row().querySelector("input") as HTMLInputElement).click();
    assert.isTrue(highlighted());
    (row().querySelector("input") as HTMLInputElement).click();
    assert.isFalse(highlighted());

    // Redrawn (e.g. by Select All or a reload): still marked.
    dialog.selected = new Set([tag]);
    dialog.renderAll();
    assert.isTrue(highlighted());
  });

  it("a click anywhere in a tag's row toggles it", async function () {
    const tag = name("rc");
    await makeItem([tag]);
    const { dialog } = await openDialog();
    dialog.filter = tag;
    dialog.renderAll();
    const row = () => dialog.leftEl.querySelector("tbody tr") as HTMLElement;
    const box = () => row().querySelector("input") as HTMLInputElement;

    (row().querySelector(".tw-tag-name") as HTMLElement).click();
    assert.isTrue(dialog.selected.has(tag));
    assert.isTrue(box().checked);
    assert.isTrue(row().classList.contains("tw-row-selected"));
    (row().querySelector(".tw-count") as HTMLElement).click();
    assert.isFalse(dialog.selected.has(tag));

    // The checkbox itself still toggles once, not twice.
    box().click();
    assert.isTrue(dialog.selected.has(tag));
  });

  it("Shift + Click ticks or unticks every row from the last clicked one", async function () {
    const tags = [name("shr"), name("shr"), name("shr"), name("shr")];
    await makeItem(tags);
    const { win, dialog } = await openDialog();
    dialog.filter = `${prefix}shr`;
    dialog.renderAll();
    const rows = () =>
      [...dialog.leftEl.querySelectorAll("tbody tr")] as HTMLElement[];
    const click = (
      index: number,
      shiftKey = false,
      target = ".tw-tag-name",
    ) => {
      const el = rows()[index].querySelector(target)!;
      const init = { bubbles: true, cancelable: true, shiftKey };
      el.dispatchEvent(new win.MouseEvent("click", init));
    };
    const ticked = () =>
      rows().map((r) => (r.querySelector("input") as HTMLInputElement).checked);
    const shown = () =>
      rows().map((r) => r.querySelector(".tw-tag-name")!.textContent);
    assert.lengthOf(rows(), 4);

    click(0);
    click(2, true);
    assert.deepEqual(ticked(), [true, true, true, false]);
    assert.sameMembers([...dialog.selected], shown().slice(0, 3));
    assert.isTrue(rows()[1].classList.contains("tw-row-selected"));

    // From the row clicked last; on the checkbox itself too.
    click(3, true, "input");
    assert.deepEqual(ticked(), [true, true, true, true]);

    // A ticked row unticks the range.
    click(1, true);
    assert.deepEqual(ticked(), [true, false, false, false]);
    assert.sameMembers([...dialog.selected], shown().slice(0, 1));
    assert.isFalse(rows()[2].classList.contains("tw-row-selected"));
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

  it("undoes and redoes edits on the History tab", async function () {
    const [a, b] = [name("ha"), name("hb")];
    const one = await makeItem([a]);
    const two = await makeItem([b]);
    const { dialog } = await openDialog();
    dialog.confirm = () => true;
    dialog.switchTab("unify");
    dialog.selected = new Set([a]);
    dialog.unifyTarget = b;
    dialog.targetTouched = true;
    dialog.refreshPlan();
    await dialog.apply();
    dialog.switchTab("remove");
    dialog.selected = new Set([b]);
    dialog.renderAll();
    await dialog.apply();
    const [removeID, mergeID] = (await listJournalIDs()).slice(0, 2);
    assert.equal((await readJournal(mergeID)).kind, "merge");
    assert.equal((await readJournal(removeID)).kind, "remove");

    dialog.tab = "history";
    await dialog.showHistory();
    const cells = (row: Element) =>
      [...row.querySelectorAll("td")].map((td) => td.textContent);
    const rows = () => [...dialog.leftEl.querySelectorAll("tbody tr")];
    const [removed, merged] = rows().slice(0, 2).map(cells);
    assert.match(removed[1], /^\d{4}-\d{2}-\d{2}$/);
    assert.match(removed[2], /^\d{2}:\d{2}:\d{2}$/);
    assert.deepEqual(removed.slice(3, 5), ["Remove", "2"]);
    assert.deepEqual(merged.slice(3, 5), ["Merge", "1"]);
    const button = (label: string) =>
      [...dialog.footerEl.querySelectorAll("button")].find(
        (el) => el.textContent === label,
      ) as HTMLButtonElement;
    assert.isTrue(button("Apply").disabled, "nothing selected yet");
    const selected = () => [
      ...dialog.leftEl.querySelectorAll("tr.tw-row-selected"),
    ];
    /** The action the Apply button takes, without taking it. */
    const applyAction = () => {
      const step = dialog.stepHistory;
      let action: string | undefined;
      dialog.stepHistory = async (to: string) => {
        action = to;
      };
      button("Apply").click();
      dialog.stepHistory = step;
      return action;
    };
    const summary = () => plain(dialog.previewEl.textContent ?? "");
    assert.equal(cells(rows()[0])[5], "");
    let seen = "";
    dialog.confirm = (_title: string, text: string) => {
      seen = plain(text);
      return true;
    };

    // Undo the merge: the newer remove is undone first.
    (rows()[1].querySelector("input") as HTMLInputElement).click();
    assert.equal(dialog.historySelected, mergeID);
    assert.deepEqual(selected(), [rows()[1]]);
    assert.isFalse(button("Apply").disabled);
    assert.equal(applyAction(), "undo");
    assert.include(summary(), "Undoing 2 edits.");
    await dialog.stepHistory("undo");

    assert.include(seen, "the 1 edit made after it");
    assert.isTrue(one.hasTag(a) && !one.hasTag(b));
    assert.isTrue(two.hasTag(b) && !two.hasTag(a));
    assert.equal((await readJournal(mergeID)).status, "undone");
    assert.equal((await readJournal(removeID)).status, "undone");
    assert.include(dialog.status.text, "Undone: 2 edits");
    assert.isTrue(rows()[0].classList.contains("tw-history-undone"));
    assert.isTrue(rows()[1].classList.contains("tw-history-undone"));
    assert.equal(cells(rows()[0])[5], "undone");
    assert.deepEqual(selected(), [], "the selection is cleared");

    // Redo the remove: the older merge is redone first.
    (rows()[0].querySelector("input") as HTMLInputElement).click();
    assert.equal(dialog.historySelected, removeID);
    assert.deepEqual(selected(), [rows()[0]]);
    assert.equal(applyAction(), "redo");
    assert.include(summary(), "Redoing 2 edits.");
    await dialog.stepHistory("redo");

    assert.include(seen, "the 1 undone edit before it");
    assert.deepEqual(await typesOf(libraryID, a), []);
    assert.deepEqual(await typesOf(libraryID, b), []);
    assert.equal((await readJournal(mergeID)).status, "done");
    assert.equal((await readJournal(removeID)).status, "done");
    assert.include(dialog.status.text, "Redone: 2 edits");
    assert.equal(cells(rows()[0])[5], "");
  });

  describe("History edge cases", function () {
    /** Rename a tag through the engine, as the Rename & Merge tab does. */
    async function renameRun(from: string, to: string) {
      const allTags = await loadTags(libraryID);
      const ref = allTags.find((t) => t.name === from)!;
      const result = await applyOps({
        libraryID,
        allTags,
        ops: [{ kind: "rename", from: ref, to }],
        kind: "rename",
      });
      assert.notEqual(result.journalId, "");
      return result.journalId;
    }

    async function openHistory() {
      const { dialog } = await openDialog();
      dialog.tab = "history";
      await dialog.showHistory();
      const rows = () =>
        [...dialog.leftEl.querySelectorAll("tbody tr")] as HTMLElement[];
      const select = (id: string) => {
        const index = dialog.history.findIndex(
          (e: { id: string }) => e.id === id,
        );
        (rows()[index].querySelector("input") as HTMLInputElement).click();
      };
      return { dialog, rows, select };
    }

    it("stops where the user declines and keeps what was undone", async function () {
      const [x, y, z] = [name("sx"), name("sy"), name("sz")];
      await makeItem([x]);
      const outside = await makeItem([]);
      const first = await renameRun(x, y);
      // Changed outside TagWiz between the two runs: the first one drifts.
      outside.addTag(y);
      await outside.saveTx();
      const second = await renameRun(y, z);
      const { dialog, select } = await openHistory();
      select(first);
      const asked: string[] = [];
      dialog.confirm = (_title: string, text: string) => {
        asked.push(plain(text));
        return asked.length === 1; // agree to start, decline the overwrite
      };

      await dialog.stepHistory("undo");

      assert.lengthOf(asked, 2);
      assert.include(asked[1], "These tags changed after the edit of");
      assert.include(asked[1], y);
      assert.include(
        plain(dialog.status.text),
        "Stopped after undoing 1 of 2 edits.",
      );
      assert.equal((await readJournal(second)).status, "undone");
      assert.equal((await readJournal(first)).status, "done");
    });

    it("undoes an interrupted run after asking, but never offers to redo it", async function () {
      const [x, y] = [name("ix"), name("iy")];
      const item = await makeItem([x]);
      const id = await renameRun(x, y);
      const journal = await readJournal(id);
      journal.status = "running";
      delete journal.after;
      await writeJournal(journal);
      const { dialog, rows, select } = await openHistory();
      assert.equal(
        rows()[0].querySelectorAll("td")[5].textContent,
        "interrupted",
      );
      select(id);
      const asked: string[] = [];
      dialog.confirm = (_title: string, text: string) => {
        asked.push(plain(text));
        return true;
      };

      await dialog.stepHistory("undo");

      assert.include(asked[1], "was interrupted");
      assert.isTrue(item.hasTag(x) && !item.hasTag(y));
      const radio = rows()[0].querySelector("input") as HTMLInputElement;
      assert.isTrue(radio.disabled, "an interrupted run cannot be redone");
      assert.equal(rows()[0].querySelectorAll("td")[5].textContent, "undone");

      // Nor selected by clicking its row.
      dialog.historySelected = undefined;
      rows()[0].querySelectorAll("td")[1].click();
      assert.isUndefined(dialog.historySelected);
    });

    it("selects a run by clicking anywhere in its row", async function () {
      const [x, y, z] = [name("rx"), name("ry"), name("rz")];
      await makeItem([x]);
      const first = await renameRun(x, y);
      const second = await renameRun(y, z);
      const { dialog, rows } = await openHistory();
      const index = (id: string) =>
        dialog.history.findIndex((e: { id: string }) => e.id === id);

      rows()[index(first)].querySelectorAll("td")[3].click();
      assert.equal(dialog.historySelected, first);
      assert.isTrue(rows()[index(first)].classList.contains("tw-row-selected"));

      rows()[index(second)].querySelectorAll("td")[1].click();
      assert.equal(dialog.historySelected, second);
      assert.isFalse(
        rows()[index(first)].classList.contains("tw-row-selected"),
      );
      const radio = rows()[index(second)].querySelector(
        "input",
      ) as HTMLInputElement;
      assert.isTrue(radio.checked);
    });

    it("warns about an unreadable snapshot the undo or redo would skip", async function () {
      const [x, y, z] = [name("ux"), name("uy"), name("uz")];
      await makeItem([x]);
      const first = await renameRun(x, y);
      // Sorts between the two runs; its library is unknown.
      const brokenID = `${newJournalID()}-broken`;
      const broken = PathUtils.join(
        Zotero.DataDirectory.dir,
        "tagwiz",
        `${brokenID}.json`,
      );
      await IOUtils.writeUTF8(broken, '{"version": 1, "id": "trunc');
      try {
        const second = await renameRun(y, z);
        const { dialog, select } = await openHistory();
        assert.include(
          plain(dialog.leftEl.textContent ?? ""),
          "could not be read",
        );
        let seen = "";
        dialog.confirm = (_title: string, text: string) => {
          seen = plain(text);
          return true;
        };

        select(first);
        await dialog.stepHistory("undo");
        assert.include(seen, "could not be read");

        // Redoing the first run only does not pass the broken one.
        select(first);
        await dialog.stepHistory("redo");
        assert.notInclude(seen, "could not be read");
        select(second);
        await dialog.stepHistory("redo");
        assert.notInclude(seen, "could not be read", "nothing skipped");

        // Undo both, then redo both: the broken one lies in between.
        select(first);
        await dialog.stepHistory("undo");
        select(second);
        seen = "";
        await dialog.stepHistory("redo");
        assert.include(seen, "could not be read");
      } finally {
        await IOUtils.remove(broken, { ignoreAbsent: true });
      }
    });

    it("says so when the selected run is gone before Apply", async function () {
      const [x, y] = [name("gx"), name("gy")];
      await makeItem([x]);
      const id = await renameRun(x, y);
      const { dialog, select } = await openHistory();
      select(id);
      await deleteJournal(id);
      dialog.confirm = () => true;

      await dialog.stepHistory("undo");

      assert.include(
        plain(dialog.status.text),
        "can no longer be undone or redone",
      );
      assert.deepEqual(await typesOf(libraryID, y), [0], "nothing changed");
      assert.isUndefined(dialog.historySelected);
    });
  });

  it("has the same footer buttons on every tab", async function () {
    const { dialog } = await openDialog();
    const labels = () =>
      [...dialog.footerEl.querySelectorAll("button")].map(
        (el) => el.textContent,
      );
    assert.deepEqual(labels(), ["Close", "Apply"]);
    dialog.tab = "history";
    await dialog.showHistory();
    assert.deepEqual(labels(), ["Close", "Apply"]);
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
