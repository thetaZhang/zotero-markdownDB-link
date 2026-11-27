import {
  registerMenu,
  registerWindowUI,
  unregisterMenu,
  unregisterWindowUI,
} from "./modules/ui";
import { initLocale } from "./utils/locale";

async function onStartup(): Promise<void> {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  registerMenu();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  registerWindowUI(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterWindowUI(win);
}

function onShutdown(): void {
  unregisterMenu();
  Zotero.getMainWindows().forEach(unregisterWindowUI);
  ztoolkit.unregisterAll();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
