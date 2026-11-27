import { stopActiveMinerUServer } from "./modules/mineru";
import {
  onPrefsLoad,
  registerMenu,
  registerPreferencePane,
  registerWindowUI,
  unregisterMenu,
  unregisterPreferencePane,
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
  await registerPreferencePane();

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

async function onShutdown(): Promise<void> {
  await stopActiveMinerUServer();
  unregisterPreferencePane();
  unregisterMenu();
  Zotero.getMainWindows().forEach(unregisterWindowUI);
  ztoolkit.unregisterAll();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onAppShutdown(): Promise<void> {
  await stopActiveMinerUServer();
}

export default {
  onStartup,
  onShutdown,
  onAppShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsLoad,
};
