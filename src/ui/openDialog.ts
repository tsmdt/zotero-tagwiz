import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { isWindowAlive } from "../utils/window";
import { TagWizDialog } from "./dialog";

const DIALOG_URL = `chrome://${config.addonRef}/content/dialog.xhtml`;

/**
 * Open the TagWiz window for the library/collection currently selected
 * in the main window. A second call focuses the existing window.
 */
export async function openTagWiz(): Promise<void> {
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

  // openWindow returns before the XHTML has loaded; wait for our root node.
  await new Promise<void>((resolve) => {
    const check = () =>
      win.document.getElementById("tagwiz-root")
        ? resolve()
        : win.setTimeout(check, 20);
    check();
  });

  await new TagWizDialog(win, {
    libraryID,
    collection: collection
      ? { id: collection.id, name: collection.name }
      : undefined,
  }).init();
}
