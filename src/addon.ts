import { config } from "../package.json";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: Localization;
    };
    /** The open TagWiz window, if any. */
    dialog?: Window;
  };
  // Lifecycle hooks
  public hooks: typeof hooks;

  constructor() {
    this.data = {
      alive: true,
      config,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
  }
}

export default Addon;
