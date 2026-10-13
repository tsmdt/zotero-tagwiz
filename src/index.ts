import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";

const basicTool = new BasicTool();

// @ts-expect-error - Plugin instance is not typed
if (!basicTool.getGlobal("Zotero")[config.addonInstance]) {
  _globalThis.addon = new Addon();
  Object.defineProperty(_globalThis, "ztoolkit", {
    get: () => _globalThis.addon.data.ztoolkit,
  });
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = addon;
}
