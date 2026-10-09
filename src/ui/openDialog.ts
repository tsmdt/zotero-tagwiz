import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { isWindowAlive } from "../utils/window";
import { TagWizDialog } from "./dialog";

const DIALOG_URL = `chrome://${config.addonRef}/content/dialog.xhtml`;

const LOAD_TIMEOUT = 10000;
const LOAD_POLL = 20;

/**
 * Open the TagWiz window for the library/collection currently selected
 * in the main window. A second call focuses the existing window.
 * Never rejects: menu handlers call it fire-and-forget, so errors are logged.
 */
export async function openTagWiz(): Promise<void> {
  try {
    await open();
  } catch (e) {
    Zotero.logError(e as Error);
  }
}

async function open(): Promise<void> {
  const existing = addon.data.dialog;
  if (existing && isWindowAlive(existing)) {
    existing.focus();
    return;
  }

  const pane = Zotero.getActiveZoteroPane();
  const libraryID = pane?.getSelectedLibraryID();
  if (!libraryID) {
    Services.prompt.alert(
      Zotero.getMainWindow() as any,
      getString("dialog-title"),
      getString("dialog-no-library"),
    );
    return;
  }
  const collection = pane.getSelectedCollection();

  const win = Services.ww.openWindow(
    Zotero.getMainWindow() as any,
    DIALOG_URL,
    "tagwiz-dialog",
    "chrome,centerscreen,resizable,width=800,height=600",
    null as any,
  ) as unknown as Window;
  addon.data.dialog = win;

  await waitForRoot(win);

  await new TagWizDialog(win, {
    libraryID,
    collection: collection
      ? { id: collection.id, name: collection.name }
      : undefined,
  }).init();
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
