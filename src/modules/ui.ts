import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { isSyncRunning, syncMarkdownLinks, type SyncProgress } from "./linker";

const MENU_ID = `${config.addonRef}-tools-sync`;
const BUTTON_ID = `${config.addonRef}-toolbar-sync`;
const STYLE_ID = `${config.addonRef}-stylesheet`;

let registeredMenuID: string | null = null;

export function registerMenu(): void {
  if (registeredMenuID) {
    unregisterMenu();
  }
  const id = Zotero.MenuManager.registerMenu({
    menuID: MENU_ID,
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
    ],
  });
  if (typeof id === "string" && id) {
    registeredMenuID = id;
  }
}

export function unregisterMenu(): void {
  if (!registeredMenuID) {
    return;
  }
  const idToRemove = registeredMenuID;
  registeredMenuID = null;
  try {
    Zotero.MenuManager.unregisterMenu(idToRemove);
  } catch (err) {
    ztoolkit.log("Failed to unregister menu", err);
  }
}

export function registerWindowUI(win: _ZoteroTypes.MainWindow): void {
  win.MozXULElement.insertFTLIfNeeded(`${config.addonRef}-mainWindow.ftl`);

  const doc = win.document;
  doc.getElementById(STYLE_ID)?.remove();
  doc.getElementById(BUTTON_ID)?.remove();

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

  const btn = ztoolkit.UI.createElement(doc, "toolbarbutton", {
    id: BUTTON_ID,
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

  const noteAddBtn = doc.getElementById("zotero-tb-note-add");
  if (noteAddBtn && toolbar.contains(noteAddBtn)) {
    noteAddBtn.after(btn);
  } else {
    const spacer = toolbar.querySelector("spacer");
    if (spacer) {
      spacer.before(btn);
    } else {
      toolbar.appendChild(btn);
    }
  }
}

export function unregisterWindowUI(win: Window): void {
  if (!win || Components.utils.isDeadWrapper(win) || win.closed) {
    return;
  }
  const doc = win.document;
  doc?.getElementById(BUTTON_ID)?.remove();
  doc?.getElementById(STYLE_ID)?.remove();
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
    const notice = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
      closeTime: -1,
    })
      .createLine({
        text: getString("sync-already-running"),
        type: "default",
      })
      .show();
    notice.startCloseTimer(3000);
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
