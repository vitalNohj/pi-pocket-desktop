// Application menu actions and the menu.
import { appendFile } from "node:fs/promises";
import { app, Menu, shell, type BaseWindow, type BrowserWindow, type MenuItemConstructorOptions, type WebContents } from "electron";
import type { Side } from "../../shared/types";
import { newSessionMenuItem } from "../bridge/new-session";
import { diagnosticsFile } from "../diagnostics/stall-watchdog";
import { showWindow } from "../window/views";
import { navigate, navigateOtherWindow } from "../window/navigation";
import { isPopOut, otherWindow } from "../window/other-windows";
import { newWindow } from "../window/new-window";
import { newWindowMenuItem } from "../window/window-rules";
import { showConfig } from "../settings-screen/screen";
import { reloadServer } from "../connection/health";
import { LINKS } from "./links";
import { state } from "./state";

/**
 * The page that Reload and Developer tools act on when the window in front is not the main one: an other window's
 * page, or a pop-out's own. Undefined for the main window, and for anything else in front (the tray's menu, nothing).
 */
function ownPage(window: BaseWindow | undefined): WebContents | undefined {
    const other = otherWindow(window);

    if (other !== undefined) return other.view.webContents;

    return isPopOut(window) ? (window as BrowserWindow).webContents : undefined;
}

/** New session (src/main/bridge/new-session.ts): the window shows, and the page opens its New session sheet when it can. */
export function newSession(starting = false): void {
    state.gui?.desktop?.newSession(starting);
}

/** The config screen, on the side of the server in use. Menus call it with their own arguments: it takes none. */
export function openSettings(): void {
    openSettingsOn(undefined);
}

/** The config screen, on `side`, or on the side of the server in use. */
export function openSettingsOn(side: Side | undefined, section?: "dictation"): void {
    if (state.gui !== undefined) {
        state.gui.connectionAttempt++;
        state.gui.viewing = side ?? state.gui.settings.server.mode;
    }

    showWindow();
    showConfig({ kind: "user", ...(section === undefined ? {} : { section }) });

    // No timed update checks: opening Settings looks for updates of the app, this computer's Pi Pocket, and the
    // extension, so what it shows is current.
    state.gui?.updates?.settingsOpened();
    state.gui?.local?.settingsOpened();
    state.gui?.billionContext?.settingsOpened();
    // The runner's allowed folders can change from a terminal (`pi-pocket runner folders remove`): show them as they are.
    void state.gui?.runner?.refreshFolders().catch(() => {});
}

/** Help → Open diagnostics log: the file the stall watchdog and the page events write (docs/settings.md, Diagnostics). */
export function openDiagnosticsLog(): void {
    const file = diagnosticsFile();

    if (file === undefined) {
        return;
    }

    // The worker writes the file; make sure it is there before it opens, even when nothing was logged yet.
    void appendFile(file, "")
        .then(() => shell.openPath(file))
        .then((problem) => {
            if (problem !== "") {
                shell.showItemInFolder(file);
            }
        })
        .catch(() => shell.showItemInFolder(file));
}

export function quit(): void {
    if (state.gui !== undefined) {
        state.gui.quitting = true;
    }

    app.quit();
}

export function buildMenu(): void {
    const mac = process.platform === "darwin";
    const template: MenuItemConstructorOptions[] = [
        ...(mac ? [{ role: "appMenu" as const }] : []),
        {
            label: "File",
            submenu: [
                newSessionMenuItem(() => newSession()),
                newWindowMenuItem(newWindow),
                { type: "separator" },
                { label: "Desktop Settings…", accelerator: "CommandOrControl+,", click: openSettings },
                { type: "separator" },
                mac ? { role: "close" } : { label: "Quit", accelerator: "CommandOrControl+Q", click: quit },
            ],
        },
        { role: "editMenu" },
        {
            label: "View",
            submenu: [
                // The main window and an other window each step through their own page. A pop-out in front moves neither.
                { label: "Back", accelerator: mac ? "Command+[" : "Alt+Left", registerAccelerator: false, click: (_item, window) => {
                    if (window === state.gui?.window) navigate("back");
                    else if (window !== undefined) navigateOtherWindow("back", window);
                } },
                { label: "Forward", accelerator: mac ? "Command+]" : "Alt+Right", registerAccelerator: false, click: (_item, window) => {
                    if (window === state.gui?.window) navigate("forward");
                    else if (window !== undefined) navigateOtherWindow("forward", window);
                } },
                { type: "separator" },
                {
                    label: state.gui?.pageHang.hung === true ? "Reload (page not responding)" : "Reload",
                    accelerator: "CommandOrControl+R",
                    click: (_item, window) => {
                        const page = ownPage(window);

                        if (page !== undefined) {
                            if (!page.isDestroyed()) page.reload();
                        } else if (state.gui?.showing === "config") {
                            state.gui.config.webContents.reload();
                        } else {
                            reloadServer();
                        }
                    },
                },
                {
                    label: "Developer tools",
                    accelerator: mac ? "Alt+Command+I" : "Control+Shift+I",
                    click: (_item, window) => {
                        const page = ownPage(window);

                        if (page !== undefined) {
                            if (!page.isDestroyed()) page.toggleDevTools();
                        } else {
                            (state.gui?.showing === "config" ? state.gui.config : state.gui?.server)?.webContents.toggleDevTools();
                        }
                    },
                },
                { type: "separator" },
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" },
            ],
        },
        { role: "windowMenu" },
        {
            role: "help",
            submenu: [
                { label: "Pi Pocket on GitHub", click: () => void shell.openExternal(LINKS.github) },
                { label: "Pi Pocket's documentation", click: () => void shell.openExternal(LINKS.docs) },
                { label: "This app's releases", click: () => void shell.openExternal(LINKS.releases) },
                { type: "separator" },
                { label: "Open diagnostics log", click: openDiagnosticsLog },
            ],
        },
    ];

    // The zoom and reload roles act on the focused view, which is the one showing.
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
