import type { ProgressWindowHelper } from "zotero-plugin-toolkit";
import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { isSyncRunning, syncMarkdownLinks, type SyncProgress } from "./linker";
import {
  cancelActiveMinerUParse,
  isMinerUParseRunning,
  parseSelectedItemsWithMinerU,
  type MinerUParseProgress,
  type MinerUParseResult,
} from "./mineru";
import { getMinerUSettings, setMinerUPref } from "./prefs";

const MENU_TOOLS_ID = `${config.addonRef}-tools-sync`;
const MENU_ITEM_PARSE_ID = `${config.addonRef}-item-parse`;
const BUTTON_SYNC_ID = `${config.addonRef}-toolbar-sync`;
const BUTTON_PARSE_ID = `${config.addonRef}-toolbar-parse`;
const STYLE_ID = `${config.addonRef}-stylesheet`;
const PREF_PANE_ID = `${config.addonRef}-prefpane`;

const registeredMenuIDs: string[] = [];
let registeredPrefPaneID: string | null = null;
let activeParsePopup: ProgressWindowHelper | null = null;
const boundBrowseButtons = new WeakSet<EventTarget>();
const boundTimeoutInputs = new WeakSet<EventTarget>();

type PrefsWindow = Window & {
  MozXULElement?: {
    insertFTLIfNeeded?: (ftl: string) => void;
  };
};

export function registerMenu(): void {
  if (registeredMenuIDs.length > 0) {
    unregisterMenu();
  }

  const toolsMenuID = Zotero.MenuManager.registerMenu({
    menuID: MENU_TOOLS_ID,
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menu-tools-sync"),
        icon: `chrome://${config.addonRef}/content/icons/sync-md.svg`,
        onCommand: () => {
          void runSyncWithUI();
        },
      },
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menu-tools-parse"),
        icon: `chrome://${config.addonRef}/content/icons/parse-pdf.svg`,
        onCommand: () => {
          void runMinerUParseWithUI();
        },
      },
    ],
  });
  if (typeof toolsMenuID === "string" && toolsMenuID) {
    registeredMenuIDs.push(toolsMenuID);
  }

  const itemMenuID = Zotero.MenuManager.registerMenu({
    menuID: MENU_ITEM_PARSE_ID,
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menu-item-parse"),
        icon: `chrome://${config.addonRef}/content/icons/parse-pdf.svg`,
        onShowing: (_event, context) => {
          context.setEnabled(
            Boolean(context.items && context.items.length > 0),
          );
        },
        onCommand: (_event, context) => {
          void runMinerUParseWithUI(context.items);
        },
      },
    ],
  });
  if (typeof itemMenuID === "string" && itemMenuID) {
    registeredMenuIDs.push(itemMenuID);
  }
}

export function unregisterMenu(): void {
  const ids = registeredMenuIDs.splice(0);
  for (const id of ids) {
    try {
      Zotero.MenuManager.unregisterMenu(id);
    } catch (err) {
      ztoolkit.log("Failed to unregister menu", err);
    }
  }
}

export async function registerPreferencePane(): Promise<void> {
  if (registeredPrefPaneID) {
    unregisterPreferencePane();
  }
  const id = await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    id: PREF_PANE_ID,
    src: `chrome://${config.addonRef}/content/preferences.xhtml`,
    label: config.addonName,
    image: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
    stylesheets: [`chrome://${config.addonRef}/content/preferences.css`],
  });
  if (typeof id === "string" && id) {
    registeredPrefPaneID = id;
  }
}

export function unregisterPreferencePane(): void {
  if (!registeredPrefPaneID) {
    return;
  }
  const id = registeredPrefPaneID;
  registeredPrefPaneID = null;
  try {
    Zotero.PreferencePanes.unregister(id);
  } catch (err) {
    ztoolkit.log("Failed to unregister preference pane", err);
  }
}

async function pickExecutablePath(
  win: Window,
  title: string,
): Promise<string | null> {
  try {
    const mod = ChromeUtils.importESModule(
      "chrome://zotero/content/modules/filePicker.mjs",
    ) as { FilePicker?: new () => any };
    if (mod?.FilePicker) {
      const fp = new mod.FilePicker();
      fp.init(win, title, fp.modeOpen);
      fp.appendFilters(fp.filterAll);
      const result = await fp.show();
      if (result === fp.returnOK || result === fp.returnReplace) {
        return typeof fp.file === "string" && fp.file ? fp.file : null;
      }
      return null;
    }
  } catch (err) {
    ztoolkit.log(
      "FilePicker ES module unavailable, falling back to nsIFilePicker",
      err,
    );
  }

  return new Promise<string | null>((resolve) => {
    const cc = Components.classes as unknown as Record<
      string,
      { createInstance(iid: unknown): nsIFilePicker }
    >;
    const fp = cc["@mozilla.org/filepicker;1"].createInstance(
      Components.interfaces.nsIFilePicker,
    );
    fp.init(
      (win as unknown as { browsingContext: BrowsingContext }).browsingContext,
      title,
      Components.interfaces.nsIFilePicker.modeOpen,
    );
    fp.appendFilters(Components.interfaces.nsIFilePicker.filterAll ?? 1);
    fp.open((result: number) => {
      if (
        result === Components.interfaces.nsIFilePicker.returnOK ||
        result === Components.interfaces.nsIFilePicker.returnReplace
      ) {
        resolve(fp.file?.path || null);
      } else {
        resolve(null);
      }
    });
  });
}

export function onPrefsLoad(win: Window): void {
  if (!win || Components.utils.isDeadWrapper(win) || win.closed) {
    return;
  }
  (win as PrefsWindow).MozXULElement?.insertFTLIfNeeded?.(
    `${config.addonRef}-preferences.ftl`,
  );

  const doc = win.document;
  const timeoutInput = doc.getElementById(
    `${config.addonRef}-pref-timeout`,
  ) as HTMLInputElement | null;
  if (timeoutInput) {
    timeoutInput.value = String(getMinerUSettings().timeoutSeconds);
    if (!boundTimeoutInputs.has(timeoutInput)) {
      boundTimeoutInputs.add(timeoutInput);
      const commitTimeout = () => {
        const parsed = Number(timeoutInput.value);
        if (Number.isFinite(parsed) && timeoutInput.value.trim() !== "") {
          setMinerUPref("timeoutSeconds", parsed);
        }
        timeoutInput.value = String(getMinerUSettings().timeoutSeconds);
      };
      timeoutInput.addEventListener("change", commitTimeout);
      timeoutInput.addEventListener("blur", commitTimeout);
    }
  }

  const browseBtn = doc.getElementById(`${config.addonRef}-pref-path-browse`);
  const pathInput = doc.getElementById(
    `${config.addonRef}-pref-path`,
  ) as HTMLInputElement | null;

  if (!browseBtn || boundBrowseButtons.has(browseBtn)) {
    return;
  }
  boundBrowseButtons.add(browseBtn);

  const handleBrowse = () => {
    void (async () => {
      const labelText =
        doc
          .querySelector(
            `[data-l10n-id="${config.addonRef}-pref-mineru-path-label"]`,
          )
          ?.textContent?.trim() || addon.data.config.addonName;
      const chosenPath = await pickExecutablePath(win, labelText);
      if (!chosenPath) {
        return;
      }
      if (pathInput) {
        pathInput.value = chosenPath;
      }
      setMinerUPref("executablePath", chosenPath);
    })();
  };

  browseBtn.addEventListener("command", handleBrowse);
}

export function registerWindowUI(win: _ZoteroTypes.MainWindow): void {
  win.MozXULElement.insertFTLIfNeeded(`${config.addonRef}-mainWindow.ftl`);

  const doc = win.document;
  doc.getElementById(STYLE_ID)?.remove();
  doc.getElementById(BUTTON_SYNC_ID)?.remove();
  doc.getElementById(BUTTON_PARSE_ID)?.remove();

  const styles = ztoolkit.UI.createElement(doc, "link", {
    id: STYLE_ID,
    properties: {
      type: "text/css",
      rel: "stylesheet",
      href: `chrome://${config.addonRef}/content/zoteroPane.css`,
    },
  });
  doc.documentElement?.appendChild(styles);

  const toolbar =
    doc.getElementById("zotero-items-toolbar") ||
    doc.querySelector(".zotero-items-toolbar");
  if (!toolbar) {
    return;
  }

  const syncBtn = ztoolkit.UI.createElement(doc, "toolbarbutton", {
    id: BUTTON_SYNC_ID,
    classList: ["zotero-tb-button"],
    attributes: {
      tabindex: "-1",
      "data-l10n-id": getLocaleID("toolbar-sync-button"),
    },
    listeners: [
      {
        type: "command",
        listener: () => {
          void runSyncWithUI();
        },
      },
    ],
  });

  const parseBtn = ztoolkit.UI.createElement(doc, "toolbarbutton", {
    id: BUTTON_PARSE_ID,
    classList: isMinerUParseRunning()
      ? ["zotero-tb-button", "running"]
      : ["zotero-tb-button"],
    attributes: {
      tabindex: "-1",
      "data-l10n-id": getLocaleID("toolbar-parse-button"),
    },
    listeners: [
      {
        type: "command",
        listener: () => {
          void runMinerUParseWithUI();
        },
      },
    ],
  });

  const noteAddBtn = doc.getElementById("zotero-tb-note-add");
  if (noteAddBtn && toolbar.contains(noteAddBtn)) {
    noteAddBtn.after(syncBtn);
  } else {
    const spacer = toolbar.querySelector("spacer");
    if (spacer) {
      spacer.before(syncBtn);
    } else {
      toolbar.appendChild(syncBtn);
    }
  }
  syncBtn.after(parseBtn);
}

export function unregisterWindowUI(win: Window): void {
  if (!win || Components.utils.isDeadWrapper(win) || win.closed) {
    return;
  }
  const doc = win.document;
  doc?.getElementById(BUTTON_PARSE_ID)?.remove();
  doc?.getElementById(BUTTON_SYNC_ID)?.remove();
  doc?.getElementById(STYLE_ID)?.remove();
}

function setParseButtonsRunning(running: boolean): void {
  for (const win of Zotero.getMainWindows()) {
    if (!win || Components.utils.isDeadWrapper(win) || win.closed) {
      continue;
    }
    const btn = win.document?.getElementById(BUTTON_PARSE_ID);
    btn?.classList.toggle("running", running);
  }
}

function showBriefNotice(text: string, durationMs = 3000): void {
  const notice = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text,
      type: "default",
    })
    .show();
  notice.startCloseTimer(durationMs);
}

function formatProgress(progress: SyncProgress): {
  text: string;
  percent: number;
} {
  switch (progress.phase) {
    case "scanning":
      return { text: getString("sync-scanning"), percent: 10 };
    case "indexing":
      return { text: getString("sync-indexing"), percent: 30 };
    case "linking": {
      const current = progress.current ?? 0;
      const total = progress.total ?? 0;
      const percent = total > 0 ? 30 + Math.round((current / total) * 65) : 50;
      return {
        text: getString("sync-linking", { args: { current, total } }),
        percent,
      };
    }
  }
}

export async function runSyncWithUI(): Promise<void> {
  if (isSyncRunning()) {
    showBriefNotice(getString("sync-already-running"), 3000);
    return;
  }

  const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text: getString("sync-start"),
      type: "default",
      progress: 0,
    })
    .show();

  try {
    const result = await syncMarkdownLinks((progress) => {
      const { text, percent } = formatProgress(progress);
      popup.changeLine({
        text,
        progress: percent,
      });
    });

    switch (result.status) {
      case "already-running":
        popup.changeLine({
          text: getString("sync-already-running"),
          type: "default",
          progress: 100,
        });
        break;
      case "no-base-dir":
        popup.changeLine({
          text: getString("sync-no-base-dir"),
          type: "default",
          progress: 100,
        });
        break;
      case "base-dir-missing":
        popup.changeLine({
          text: getString("sync-base-dir-missing", {
            args: { path: result.baseDir ?? "" },
          }),
          type: "default",
          progress: 100,
        });
        break;
      case "completed":
        if (result.failed > 0) {
          popup.changeLine({
            text: getString("sync-summary-with-errors", {
              args: {
                linked: result.linked,
                skipped: result.skipped,
                unmatched: result.unmatched,
                failed: result.failed,
              },
            }),
            type: "default",
            progress: 100,
          });
        } else {
          popup.changeLine({
            text: getString("sync-summary", {
              args: {
                linked: result.linked,
                skipped: result.skipped,
                unmatched: result.unmatched,
              },
            }),
            type: "success",
            progress: 100,
          });
        }
        break;
    }
  } catch (err) {
    ztoolkit.log("Markdown link sync failed", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    popup.changeLine({
      text: getString("sync-error", { args: { error: errorMessage } }),
      type: "default",
      progress: 100,
    });
  } finally {
    popup.startCloseTimer(6000);
  }
}

function computeItemPhasePercent(
  current: number,
  total: number,
  phaseOffset: number,
  fallback: number,
): number {
  if (total <= 0) {
    return fallback;
  }
  const indexOffset = Math.max(0, current - 1) + phaseOffset;
  return Math.min(95, 15 + Math.round((indexOffset / total) * 80));
}

function formatMinerUProgress(progress: MinerUParseProgress): {
  text: string;
  percent: number;
} {
  const current = progress.current ?? 0;
  const total = progress.total ?? 0;
  const citeKey = progress.citeKey ?? "";

  switch (progress.phase) {
    case "resolving":
      return { text: getString("mineru-resolving"), percent: 5 };
    case "starting-server":
      return { text: getString("mineru-starting-server"), percent: 15 };
    case "parsing": {
      const percent = computeItemPhasePercent(current, total, 0.2, 35);
      return {
        text: getString("mineru-parsing", {
          args: { current, total, citeKey },
        }),
        percent,
      };
    }
    case "extracting": {
      const percent = computeItemPhasePercent(current, total, 0.75, 75);
      return {
        text: getString("mineru-extracting", {
          args: { current, total, citeKey },
        }),
        percent,
      };
    }
    case "linking": {
      const percent = computeItemPhasePercent(current, total, 0.95, 90);
      return {
        text: getString("mineru-linking", {
          args: { current, total, citeKey },
        }),
        percent,
      };
    }
    case "stopping-server":
      return { text: getString("mineru-stopping-server"), percent: 96 };
  }
}

function formatMinerUResultLine(result: MinerUParseResult): {
  text: string;
  type: "default" | "success" | "fail";
} {
  switch (result.status) {
    case "already-running":
      return { text: getString("mineru-already-running"), type: "default" };
    case "no-selection":
      return { text: getString("mineru-no-selection"), type: "default" };
    case "no-base-dir":
      return { text: getString("sync-no-base-dir"), type: "default" };
    case "base-dir-missing":
      return {
        text: getString("sync-base-dir-missing", {
          args: { path: result.baseDir ?? "" },
        }),
        type: "default",
      };
    case "mineru-not-found":
      return { text: getString("mineru-not-found"), type: "fail" };
    case "server-start-failed":
      return {
        text: getString("mineru-server-start-failed", {
          args: { error: result.error ?? "" },
        }),
        type: "fail",
      };
    case "canceled":
      return {
        text: getString("mineru-summary-canceled", {
          args: {
            parsed: result.parsed,
            linkedExisting: result.linkedExisting,
            skippedExisting: result.skippedExisting,
            skippedInvalid: result.skippedInvalid,
            failed: result.failed,
          },
        }),
        type: "default",
      };
    case "completed":
      if (result.failed > 0) {
        return {
          text: getString("mineru-summary-with-errors", {
            args: {
              parsed: result.parsed,
              linkedExisting: result.linkedExisting,
              skippedExisting: result.skippedExisting,
              skippedInvalid: result.skippedInvalid,
              failed: result.failed,
            },
          }),
          type: "default",
        };
      }
      return {
        text: getString("mineru-summary", {
          args: {
            parsed: result.parsed,
            linkedExisting: result.linkedExisting,
            skippedExisting: result.skippedExisting,
            skippedInvalid: result.skippedInvalid,
          },
        }),
        type: "success",
      };
  }
}

export async function runMinerUParseWithUI(
  explicitItems?: Zotero.Item[],
): Promise<void> {
  if (isMinerUParseRunning()) {
    const confirmed = Services.prompt.confirm(
      Zotero.getMainWindow() as unknown as mozIDOMWindowProxy,
      addon.data.config.addonName,
      getString("mineru-confirm-cancel"),
    );
    if (confirmed && cancelActiveMinerUParse()) {
      activeParsePopup?.changeLine({
        text: getString("mineru-canceling"),
        type: "default",
      });
    }
    return;
  }

  const items =
    explicitItems && explicitItems.length > 0
      ? explicitItems
      : (Zotero.getActiveZoteroPane()?.getSelectedItems() ?? []);

  if (items.length === 0) {
    showBriefNotice(getString("mineru-no-selection"), 3000);
    return;
  }

  setParseButtonsRunning(true);

  const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: false,
    closeTime: -1,
  })
    .createLine({
      text: getString("mineru-start"),
      type: "default",
      progress: 0,
    })
    .addDescription(getString("mineru-cancel-hint"))
    .show();
  activeParsePopup = popup;

  try {
    const result = await parseSelectedItemsWithMinerU(items, (progress) => {
      const { text, percent } = formatMinerUProgress(progress);
      popup.changeLine({
        text,
        progress: percent,
      });
    });

    const line = formatMinerUResultLine(result);
    popup.changeLine({
      text: line.text,
      type: line.type,
      progress: 100,
    });
  } catch (err) {
    ztoolkit.log("MinerU PDF parse failed", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    popup.changeLine({
      text: getString("mineru-error", { args: { error: errorMessage } }),
      type: "fail",
      progress: 100,
    });
  } finally {
    if (activeParsePopup === popup) {
      activeParsePopup = null;
    }
    setParseButtonsRunning(false);
    popup.startCloseTimer(8000);
  }
}
