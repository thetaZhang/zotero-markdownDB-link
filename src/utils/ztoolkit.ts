import {
  BasicTool,
  makeHelperTool,
  ProgressWindowHelper,
  UITool,
  unregister,
} from "zotero-plugin-toolkit";
import { config } from "../../package.json";

export { createZToolkit };

function createZToolkit() {
  const _ztoolkit = new ZoteroToolkit();
  initZToolkit(_ztoolkit);
  return _ztoolkit;
}

function initZToolkit(_ztoolkit: ReturnType<typeof createZToolkit>) {
  const env = __env__;
  _ztoolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  _ztoolkit.basicOptions.log.disableConsole = env === "production";
  _ztoolkit.UI.basicOptions.ui.enableElementJSONLog = env === "development";
  _ztoolkit.UI.basicOptions.ui.enableElementDOMLog = env === "development";
  _ztoolkit.basicOptions.api.pluginID = config.addonID;
  const iconURI = `chrome://${config.addonRef}/content/icons/favicon.png`;
  _ztoolkit.ProgressWindow.setIconURI("default", iconURI);
  _ztoolkit.ProgressWindow.setIconURI("success", iconURI);
  _ztoolkit.ProgressWindow.setIconURI("fail", iconURI);
}

/**
 * On-demand toolkit: only the modules used by this plugin are bundled.
 */
class ZoteroToolkit extends BasicTool {
  UI: UITool;
  ProgressWindow: typeof ProgressWindowHelper;

  constructor() {
    super();
    this.UI = new UITool(this);
    this.ProgressWindow = makeHelperTool(ProgressWindowHelper, this);
  }

  /**
   * Unregister everything created by the modules.
   */
  unregisterAll() {
    unregister(this);
  }
}
