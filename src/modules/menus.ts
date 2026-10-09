import { getLocaleID, getString } from "../utils/locale";
import { openTagCleaner } from "../ui/openDialog";

const registered: string[] = [];

// Typings declare MenuManager unconditionally; older Zotero versions lack it.
const hasMenuManager = () =>
  typeof (Zotero.MenuManager as { registerMenu?: unknown } | undefined)
    ?.registerMenu === "function";

/**
 * Add "Clean Tags…" to the collection context menu and "Tag Cleaner…" to the
 * Tools menu. Uses Zotero.MenuManager (Zotero 8+); older versions fall back to
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
          onCommand: () => void openTagCleaner(),
        },
      ],
    });
    if (id) registered.push(id);
  }
}

/** Only needed where Zotero.MenuManager does not exist. Untested on Zotero 7. */
export function registerLegacyMenus() {
  if (hasMenuManager()) return;
  ztoolkit.Menu.register("collection", {
    tag: "menuitem",
    id: "tagcleaner-menu-collection",
    label: getString("menuitem-collection-label"),
    commandListener: () => void openTagCleaner(),
  });
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    id: "tagcleaner-menu-tools",
    label: getString("menuitem-tools-label"),
    commandListener: () => void openTagCleaner(),
  });
}

export function unregisterMenus() {
  for (const id of registered.splice(0)) {
    Zotero.MenuManager?.unregisterMenu(id);
  }
}
