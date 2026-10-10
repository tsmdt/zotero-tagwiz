import {
  registerLegacyMenus,
  registerMenus,
  unregisterLegacyMenus,
  unregisterMenus,
} from "./modules/menus";
import { initLocale } from "./utils/locale";
import { isWindowAlive } from "./utils/window";

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
  // Every step runs even if an earlier one throws: if the instance were not
  // removed, the next startup (e.g. after an update) would reuse it and keep
  // running the old code.
  const steps = [
    unregisterMenus,
    () => unregisterLegacyMenus(),
    () => {
      const dialog = addon.data.dialog;
      if (isWindowAlive(dialog)) dialog!.close();
    },
    () => ztoolkit.unregisterAll(),
  ];
  for (const step of steps) {
    try {
      step();
    } catch (e) {
      Zotero.logError(e as Error);
    }
  }
  addon.data.dialog = undefined;
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
