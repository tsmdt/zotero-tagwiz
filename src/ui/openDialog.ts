import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { isWindowAlive } from "../utils/window";
import { DialogParams, TagWizDialog } from "./dialog";

const DIALOG_URL = `chrome://${config.addonRef}/content/dialog.xhtml`;

const LOAD_TIMEOUT = 10000;
const LOAD_POLL = 20;

/** The dialog shown in addon.data.dialog, once it has loaded. */
let current: TagWizDialog | undefined;

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
    if (params) await current?.setScope(params);
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
  const win = Services.ww.openWindow(
    Zotero.getMainWindow() as any,
    DIALOG_URL,
    "tagwiz-dialog",
    "chrome,centerscreen,resizable,width=980,height=720",
    null as any,
  ) as unknown as Window;
  addon.data.dialog = win;

  await waitForRoot(win);

  const dialog = new TagWizDialog(win, params);
  current = dialog;
  await dialog.init();
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
