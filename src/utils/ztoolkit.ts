import { BasicTool, unregister } from "zotero-plugin-toolkit";
import { config } from "../../package.json";

export { createZToolkit };

/**
 * Only the parts of zotero-plugin-toolkit TagWiz uses (getGlobal,
 * unregisterAll), so the full toolkit and its UI helpers stay out of the
 * bundle.
 */
class TagWizToolkit extends BasicTool {
  unregisterAll() {
    unregister(this);
  }
}

function createZToolkit() {
  const _ztoolkit = new TagWizToolkit();
  _ztoolkit.basicOptions.api.pluginID = config.addonID;
  return _ztoolkit;
}
