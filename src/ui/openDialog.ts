import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { isWindowAlive } from "../utils/window";
import { DialogParams, TagWizDialog } from "./dialog";

const DIALOG_URL = `chrome://${config.addonRef}/content/dialog.xhtml`;

const LOAD_TIMEOUT = 10000;
const LOAD_POLL = 20;

/** The dialog shown in addon.data.dialog, once it has loaded. */
let current: TagWizDialog | undefined;
/** Selection of a TagWiz click while the window was still loading. */
let pending: DialogParams | undefined;

/**
 * Open the TagWiz window for the library/collection currently selected
 * in the main window. A second call focuses the existing window and switches
 * it to the current selection (unless a run is going on there).
 * Never rejects: menu handlers call it fire-and-forget, so errors are logged.
 */
export async function openTagWiz(): Promise<void> {
  try {
    await open();
  } catch (e) {
    Zotero.logError(e as Error);
  }
}

/** The library/collection selected in the main window, if any. */
function selection(): DialogParams | undefined {
  const pane = Zotero.getActiveZoteroPane();
  const libraryID = pane?.getSelectedLibraryID();
  if (!libraryID) return undefined;
  const collection = pane.getSelectedCollection();
  return {
    libraryID,
    collection: collection
      ? { id: collection.id, name: collection.name }
      : undefined,
  };
}

async function open(): Promise<void> {
  const params = selection();
  const existing = addon.data.dialog;
  if (existing && isWindowAlive(existing)) {
    existing.focus();
    if (!params) return;
    if (!current) {
      // Still loading: switch once it has.
      pending = params;
    } else if (!(await current.setScope(params))) {
      Services.prompt.alert(
        existing as any,
        getString("dialog-title"),
        getString("dialog-busy"),
      );
    }
    return;
  }

  if (!params) {
    Services.prompt.alert(
      Zotero.getMainWindow() as any,
      getString("dialog-title"),
      getString("dialog-no-library"),
    );
    return;
  }

  current = undefined;
  pending = undefined;
  const win = Services.ww.openWindow(
    Zotero.getMainWindow() as any,
    DIALOG_URL,
    "tagwiz-dialog",
    "chrome,centerscreen,resizable,width=980,height=720",
    null as any,
  ) as unknown as Window;
  addon.data.dialog = win;

  try {
    await waitForRoot(win);
  } catch (e) {
    // Don't keep focusing a window that never loaded on later clicks.
    if (isWindowAlive(win)) win.close();
    if (addon.data.dialog === win) addon.data.dialog = undefined;
    throw e;
  }

  const dialog = new TagWizDialog(win, params);
  current = dialog;
  await dialog.init();
  if (pending) {
    const next = pending;
    pending = undefined;
    await dialog.setScope(next);
  }
}

/**
 * openWindow returns before the XHTML has loaded; wait for our root node.
 * Polls on Zotero's timer, not the window's, so closing the window early
 * ends the wait instead of leaving it pending forever.
 */
async function waitForRoot(win: Window): Promise<void> {
  for (let waited = 0; waited < LOAD_TIMEOUT; waited += LOAD_POLL) {
    if (!isWindowAlive(win)) {
      throw new Error("TagWiz window was closed before it finished loading");
    }
    if (win.document.getElementById("tagwiz-root")) return;
    await Zotero.Promise.delay(LOAD_POLL);
  }
  throw new Error("TagWiz window did not finish loading");
}
