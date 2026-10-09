import {
  registerLegacyMenus,
  registerMenus,
  unregisterLegacyMenus,
  unregisterMenus,
} from "./modules/menus";
import { initLocale } from "./utils/locale";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  try {
    registerMenus();
  } catch (e) {
    // A menu problem must not keep the plugin from loading.
    Zotero.logError(e as Error);
  }

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  registerLegacyMenus(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterLegacyMenus(win);
}

function onShutdown(): void {
  unregisterMenus();
  unregisterLegacyMenus();
  addon.data.dialog?.close();
  ztoolkit.unregisterAll();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

// Keep hooks as pure dispatch: real work lives in modules.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
