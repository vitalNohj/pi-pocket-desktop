// Every Back/Forward input goes here: the server's history, and one return step to GUI Settings.
import { ipcMain } from "electron";
import { state } from "../app/state";
import { currentOrigin, originOf } from "../connection/address";
import { canReturn } from "../connection/server-choice";
import { isAppPage } from "../settings-screen/config-protocol";
import { showConfig } from "../settings-screen/screen";
import { show } from "./views";
import { navigationKey, navigationStep, serverNavigated, type Direction, type HistoryStep } from "./navigation-state";

export function navigate(direction: Direction): void {
    const gui = state.gui;

    if (gui === undefined || gui.server.webContents.isDestroyed()) {
        return;
    }

    const history = gui.server.webContents.navigationHistory;
    const index = history.getActiveIndex();
    const entry = (offset: number): HistoryStep => ({ index: index + offset, url: history.getEntryAtIndex(index + offset).url });
    const next = navigationStep(gui.navigation, direction, {
        showing: gui.showing,
        canReturn: canReturn({ inUse: gui.settings.server.mode, viewing: gui.viewing, loaded: gui.loadedUrl !== undefined }),
        reason: gui.reason,
        origin: currentOrigin(),
        ...(history.canGoBack() ? { back: entry(-1) } : {}),
        ...(history.canGoForward() ? { forward: entry(1) } : {}),
    });

    // Same as the settings screen's Back to Pi Pocket button: cancel a connection attempt even if Back cannot return.
    if (gui.showing === "config" && direction === "back") {
        gui.connectionAttempt++;
    }

    gui.navigation = next.state;

    switch (next.action.kind) {
        case "server":
            gui.reason = { kind: "user" };
            show("server");
            break;
        case "config":
            showConfig(next.action.reason);
            break;
        case "history":
            if (next.action.direction === "back") {
                history.goBack();
            } else {
                history.goForward();
            }
            break;
        case "none":
            break;
    }
}

export function setUpNavigation(): void {
    const gui = state.gui!;
    const { window, server, config } = gui;

    // BaseWindow emits app-command on Windows and Linux, including while either WebContentsView has focus.
    // macOS has no app-command. Its mouse fallback is in the shared navigation preload, never enabled here too.
    if (process.platform !== "darwin") {
        window.on("app-command", (_event, command) => {
            if (command === "browser-backward" || command === "browser-forward") {
                navigate(command === "browser-backward" ? "back" : "forward");
            }
        });
    } else {
        window.on("swipe", (_event, direction) => {
            if (direction === "left" || direction === "right") {
                navigate(direction === "left" ? "back" : "forward");
            }
        });
    }

    for (const view of [server, config]) {
        // registerAccelerator:false is Windows/Linux only. On macOS, let this key reach the preload too, so it can
        // check editable focus before taking it. Reset this for every other key; other menu shortcuts still work.
        view.webContents.on("before-input-event", (_event, input) => {
            view.webContents.setIgnoreMenuShortcuts(navigationKey(input, process.platform) !== undefined);
        });
    }

    ipcMain.on("window:navigate", (event, direction: unknown) => {
        if (direction !== "back" && direction !== "forward") {
            return;
        }

        const frame = event.senderFrame;
        const fromShownView = gui.showing === "config"
            ? event.sender === config.webContents && frame !== null && isAppPage(frame.url)
            : event.sender === server.webContents && frame !== null && originOf(frame.url) === currentOrigin();

        if (fromShownView && frame?.parent === null) {
            navigate(direction);
        }
    });

    const committed = (url: string): void => {
        gui.navigation = serverNavigated(gui.navigation, { index: server.webContents.navigationHistory.getActiveIndex(), url });
    };

    server.webContents.on("did-navigate", (_event, url) => committed(url));
    server.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
        if (isMainFrame) committed(url);
    });
    server.webContents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
        if (isMainFrame) gui.navigation = {};
    });
    server.webContents.on("render-process-gone", () => { gui.navigation = {}; });
}
