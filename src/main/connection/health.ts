// Server health and page recovery.
// ——— Watching the server while it is open ———
import { dialog } from "electron";
import { LOOK_SCRIPT, lookWithin, type PageLook } from "./page-recovery";
import { activity, diagnose } from "../diagnostics/stall-watchdog";
import { checkAddress, serverUrl, originOf, currentOrigin } from "./address";
import { serverLost } from "./retry";
import { buildMenu } from "../app/menu";
import { showWindow } from "../window/views";
import { reloadFailedOtherWindows } from "../window/other-windows";
import { state as appState } from "../app/state";

/**
 * Checks the server the window uses, and its page, every healthIntervalSeconds. Another server that stops answering
 * shows the config screen; this computer's Pi Pocket says that itself (its process). For both, a page that stays stuck
 * (the boot screen, or no answer) while the server answers is reloaded (src/main/connection/page-recovery.ts).
 */
export function startHealth(): void {
    const state = appState.gui!;
    const seconds = state.settings.connection.healthIntervalSeconds;

    stopHealth();
    state.recovery.reset();

    if (seconds === 0) {
        return;
    }

    const tick = async () => {
        if (appState.gui?.health === undefined) {
            return;
        }

        activity("health check");

        const local = appState.gui.settings.server.mode === "local";
        const found = await checkAddress(local ? serverUrl() : appState.gui.settings.server.url);

        if (appState.gui.health === undefined) {
            return;
        }

        if (found.kind === "unreachable") {
            appState.gui.health.failures += 1;

            if (!local && appState.gui.health.failures >= appState.gui.settings.connection.failuresBeforeOutage) {
                serverLost({ kind: "outage", url: found.url, message: found.message }, true);

                return;
            }
        } else {
            appState.gui.health.failures = 0;
        }

        // Detected: Pi Pocket answers its info (a server still starting answers 503, which is not up yet).
        const up = found.kind === "detected";

        if (up) reloadFailedOtherWindows();

        // The last load of this computer's Pi Pocket failed while it restarted: it answers now, load it again.
        if (up && appState.gui.loadFailed) {
            diagnose("page: the server answers again after a failed load; loading it again");
            appState.gui.loadFailed = false;
            appState.gui.recovery.reset();
            loadAgain();
            appState.gui.health.timer = setTimeout(() => void tick(), appState.gui.settings.connection.healthIntervalSeconds * 1000);

            return;
        }
        const look = up ? await lookAtPage() : "ready";

        if (appState.gui.health === undefined) {
            return;
        }

        const step = appState.gui.recovery.check(Date.now(), up, look);

        if (step !== "none") {
            diagnose(`page: still ${look} ${step === "reload" ? "while the server answers; reloading" : "after a reload; replacing its renderer"}`);
            reloadServer(step === "force-reload");
        }

        appState.gui.health.timer = setTimeout(() => void tick(), appState.gui.settings.connection.healthIntervalSeconds * 1000);
    };

    state.health = { failures: 0, timer: setTimeout(() => void tick(), seconds * 1000) };
}

export function stopHealth(): void {
    if (appState.gui?.health !== undefined) {
        clearTimeout(appState.gui.health.timer);
        appState.gui.health = undefined;
    }
}

/** How long the page has to answer a look before it counts as not answering. */
const LOOK_LIMIT_MS = 3000;

/**
 * What the server's page shows now (src/main/connection/page-recovery.ts, PageLook). A page that does not answer in time also
 * counts toward "not responding": Electron's own unresponsive does not fire while the title bar's debugger is attached.
 */
export async function lookAtPage(): Promise<PageLook> {
    const state = appState.gui;

    if (state === undefined || state.loadedUrl === undefined) {
        return "ready";
    }

    const contents = state.server.webContents;

    if (contents.isDestroyed()) {
        return "ready";
    }

    if (contents.getURL() === "" || contents.getURL() === "about:blank") {
        return contents.isLoading() ? "silent" : "empty";
    }

    // Another page (a sign-in in front of the server): not Pi Pocket's boot screen, nothing to judge.
    if (originOf(contents.getURL()) !== currentOrigin()) {
        return "ready";
    }

    const look = await lookWithin(() => contents.executeJavaScript(LOOK_SCRIPT), LOOK_LIMIT_MS);

    if (appState.gui === undefined || contents.isDestroyed()) {
        return "ready";
    }

    if (look === "silent" && !contents.isLoading()) {
        appState.gui.pageHang.unresponsive();
    } else if (look !== "silent") {
        appState.gui.pageHang.responsive();
    }

    return look;
}

/** The page stopped answering for HANG_MS, or answers again: say so in the tray, the menu, and a question. */
export function pageHangChanged(hung: boolean): void {
    const state = appState.gui;

    if (state === undefined) {
        return;
    }

    diagnose(hung ? "page: not responding for 10 s; Reload offered" : "page: answers again");
    state.desktop?.refreshTray();
    buildMenu();

    if (!hung) {
        hangQuestion?.abort();

        return;
    }

    if (state.askingHang || !state.window.isVisible()) {
        return;
    }

    // Asynchronous: the main process (and the tray) go on while the question shows.
    const controller = new AbortController();

    hangQuestion = controller;
    state.askingHang = true;
    void dialog
        .showMessageBox(state.window, {
            type: "warning",
            message: "Pi Pocket's page is not responding",
            detail: "You can wait for it, or reload it. Reload is also in the tray menu and in View.",
            buttons: ["Reload", "Wait"],
            defaultId: 0,
            cancelId: 1,
            signal: controller.signal,
        })
        .then(({ response }) => {
            if (response === 0 && !controller.signal.aborted) {
                reloadServer();
            }
        })
        .catch(() => undefined)
        .finally(() => {
            if (appState.gui !== undefined) {
                appState.gui.askingHang = false;
            }

            if (hangQuestion === controller) {
                hangQuestion = undefined;
            }
        });
}

let hangQuestion: AbortController | undefined;

/** The tray's Reload: the screen that shows, as View → Reload does. */
export function reloadShowing(): void {
    if (appState.gui?.showing === "config") {
        appState.gui.config.webContents.reload();
    } else {
        showWindow();
        reloadServer();
    }
}

/**
 * Load the server's page again: the menu's Reload, and the Reload button over a boot screen that took too long. A view
 * with nothing committed yet (its first load never finished) loads the server's address again instead.
 */
export function reloadServer(force = false): void {
    const state = appState.gui;

    if (state === undefined) {
        return;
    }

    const contents = state.server.webContents;

    if (contents.isDestroyed()) {
        return;
    }

    // A page that does not answer may not take a reload either: replace its renderer, then load in a new one.
    const replace = force || state.pageHang.hung;

    if (state.replacing !== undefined) {
        return;
    }

    activity(replace ? "page reload (new renderer)" : "page reload");
    diagnose(replace ? "page: reloading in a new renderer" : "page: reloading");
    clearTimeout(state.reloadCheck);
    state.reloadCheck = undefined;

    if (replace) {
        // The load starts once the old renderer is gone (render-process-gone, in watchServerView); a renderer that was
        // already gone sends nothing, so the timer loads anyway.
        state.replacing = setTimeout(loadAgain, 3000);
        state.pageHang.responsive();
        contents.forcefullyCrashRenderer();

        return;
    }

    loadAgain();

    // A normal reload of a stuck page may not help: if the page still does not answer, replace its renderer.
    state.reloadCheck = setTimeout(() => {
        if (appState.gui === undefined) {
            return;
        }

        appState.gui.reloadCheck = undefined;
        void lookAtPage().then((look) => {
            if (look === "silent" && appState.gui !== undefined && appState.gui.reloadCheck === undefined && !appState.gui.server.webContents.isDestroyed()) {
                diagnose("page: no answer 10 s after a reload");
                reloadServer(true);
            }
        });
    }, 10_000);
}

/** The page again: a reload, or its address when nothing of it is committed (its first load never finished). */
export function loadAgain(): void {
    const state = appState.gui;

    if (state === undefined) {
        return;
    }

    clearTimeout(state.replacing);
    state.replacing = undefined;

    const contents = state.server.webContents;

    if (contents.isDestroyed()) {
        return;
    }

    if ((contents.getURL() === "" || contents.getURL() === "about:blank") && state.loadedUrl !== undefined) {
        void contents.loadURL(`${state.loadedUrl}/`).catch(() => {
            // did-fail-load shows the error.
        });
    } else {
        contents.reload();
    }
}
