import { getLocaleID, getString } from "../utils/locale";
import { openTagWiz } from "../ui/openDialog";

const registered: string[] = [];

// Typings declare MenuManager unconditionally; older Zotero versions lack it.
const hasMenuManager = () =>
  typeof (Zotero.MenuManager as { registerMenu?: unknown } | undefined)
    ?.registerMenu === "function";

/**
 * Add "TagWiz" to the collection context menu and to the Tools menu. Uses Zotero.MenuManager (Zotero 8+); older versions fall back to
 * the toolkit's per-window menus (see registerLegacyMenus).
 */
export function registerMenus() {
  if (!hasMenuManager()) return;
  const { addonRef, addonID } = addon.data.config;
  const targets = [
    ["main/library/collection", "menu-collection"],
    ["main/menubar/tools", "menu-tools"],
  ] as const;
  for (const [target, l10n] of targets) {
    const id = Zotero.MenuManager.registerMenu({
      menuID: `${addonRef}-${l10n}`,
      pluginID: addonID,
      target,
      menus: [
        {
          menuType: "menuitem",
          l10nID: getLocaleID(l10n),
          onCommand: () => void openTagWiz(),
        },
      ],
    });
    if (id) registered.push(id);
  }
}

/** Menu items added per window where Zotero.MenuManager does not exist. */
const legacyItems = new Map<Window, Element[]>();

const LEGACY_TARGETS = [
  [
    "zotero-collectionmenu",
    "tagwiz-menu-collection",
    "menuitem-collection-label",
  ],
  ["menu_ToolsPopup", "tagwiz-menu-tools", "menuitem-tools-label"],
] as const;

/**
 * Fallback for Zotero versions without Zotero.MenuManager: add the menu items
 * to this window only, tracked per window so that closing one main window
 * does not touch the menus of another.
 */
export function registerLegacyMenus(win: Window) {
  if (hasMenuManager()) return;
  addLegacyMenuItems(win);
}

/** Exported for tests, which run on Zotero versions that have MenuManager. */
export function addLegacyMenuItems(win: Window) {
  if (legacyItems.has(win)) return;
  const doc = win.document;
  const items: Element[] = [];
  for (const [popupID, id, label] of LEGACY_TARGETS) {
    const popup = doc.getElementById(popupID);
    if (!popup) continue;
    const item = (
      doc as Document & { createXULElement(tag: string): Element }
    ).createXULElement("menuitem");
    item.id = id;
    item.setAttribute("label", getString(label));
    item.addEventListener("command", () => void openTagWiz());
    popup.appendChild(item);
    items.push(item);
  }
  legacyItems.set(win, items);
}

/** Remove the fallback items of `win`, or of every window. */
export function unregisterLegacyMenus(win?: Window) {
  for (const [w, items] of legacyItems) {
    if (win && w !== win) continue;
    for (const item of items) {
      try {
        item.remove();
      } catch {
        // the window is already gone
      }
    }
    legacyItems.delete(w);
  }
}

export function unregisterMenus() {
  for (const id of registered.splice(0)) {
    Zotero.MenuManager?.unregisterMenu(id);
  }
}
