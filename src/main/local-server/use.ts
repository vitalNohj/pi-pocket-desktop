// Use of this computer's Pi Pocket server.
import { join } from "node:path";
import { dialog, Notification, shell } from "electron";
import type { LocalAction, Side } from "../../shared/types";
import { keepsLocalAsked, whenLocalReady, whenLost, type LocalDown } from "../connection/server-choice";
import { saveSettings } from "../core/settings";
import { activity, diagnose } from "../diagnostics/stall-watchdog";
import { ASSETS } from "../core/paths";
import { pushConfigState, showConfig } from "../settings-screen/screen";
import { stopHealth, startHealth } from "../connection/health";
import { stopRetry } from "../connection/retry";
import { checkAddress } from "../connection/address";
import { show } from "../window/views";
import { openSettingsOn } from "../app/menu";
import { connect } from "../connection/connect";
import { state as appState } from "../app/state";

/** This computer's Pi Pocket is ready: open it when the person asked for it, or when the window uses it. */
export function localReady(url: string, loginPath: string): void {
    const state = appState.gui!;
    const asked = state.localAsked;

    state.localLogin = { url, loginPath };
    state.localAsked = false;
    state.localStopNotice.reset();

    const next = whenLocalReady({ inUse: state.settings.server.mode, asked, showing: state.showing, viewing: state.viewing });

    if (next === "none") {
        pushConfigState();

        return;
    }

    openLocal(url, loginPath, next === "show");
}

/**
 * The window uses this computer's Pi Pocket: sign in with its login link (the cookie keeps the app signed in). This
 * ends a connection to another server. `display`: show it now; otherwise it loads, and Back on This computer shows it.
 */
export function openLocal(url: string, loginPath: string, display: boolean): void {
    const state = appState.gui!;

    useServer("local");
    stopHealth();
    stopRetry();
    state.retryAttempt = 0;
    state.loadedUrl = url;
    state.unverified = false;
    state.signingIn = true;
    void checkAddress(url);
    activity("page load");
    diagnose(`page: loading this computer's Pi Pocket at ${url}`);
    void state.server.webContents.loadURL(`${url}${loginPath}`).catch(() => {
        // did-fail-load shows the error.
    });
    // What went wrong before, with either server, is over: the window uses this one now.
    state.reason = { kind: "user" };

    if (display) {
        state.viewing = "local";
        show("server");
    } else {
        pushConfigState();
    }

    // Watch the server and the page: the page reloads by itself when it stays stuck while the server answers.
    startHealth();
}

/** Saves the side of the server the window uses: the app opens it at its next start. */
export function useServer(side: Side): void {
    const state = appState.gui!;

    if (state.settings.server.mode !== side) {
        state.settings = { ...state.settings, server: { ...state.settings.server, mode: side } };
        saveSettings(state.configPath, state.settings);
    }
}

/**
 * This computer's Pi Pocket stopped, failed, or is not installed. When the window uses it, the window loses its server;
 * while another server is in use, nothing changes but its card and its choice. Stopping on its own is also told in a
 * desktop notification.
 */
export function localDown(why: LocalDown): void {
    const state = appState.gui!;

    state.localLogin = undefined;

    // A crash, or an update that goes back to the version before, keeps the person's Start: it starts again by
    // itself, and then opens. Stop, Uninstall, or no usable Pi Pocket ends it.
    if (!keepsLocalAsked(why)) {
        state.localAsked = false;
    }

    if (why.kind === "stopped") {
        state.localStopNotice.reset();
    }

    if (state.localStopNotice.down(why, state.quitting) && why.kind === "crashed") {
        notifyLocalStopped(why.message);
    }

    if (state.settings.server.mode !== "local") {
        pushConfigState();

        return;
    }

    stopHealth();
    stopRetry();

    const loaded = state.loadedUrl !== undefined;

    if (loaded) {
        state.loadedUrl = undefined;
        void state.server.webContents.loadURL("about:blank").catch(() => {});
    }

    const next = whenLost({ lost: "local", showing: state.showing, viewing: state.viewing });

    if (next.show) {
        state.viewing = "local";
        showConfig({ kind: "local" });
    } else {
        pushConfigState();
    }
}

/** A desktop notification: this computer's Pi Pocket stopped on its own. A click opens This computer in settings. */
export function notifyLocalStopped(message: string): void {
    const state = appState.gui!;

    if (!state.settings.notifications.enabled || !Notification.isSupported()) {
        return;
    }

    const notification = new Notification({
        title: "Pi Pocket on this computer stopped",
        body: message,
        silent: !state.settings.notifications.sound,
        icon: join(ASSETS, "icon-192.png"),
    });

    notification.on("click", () => {
        openSettingsOn("local");
    });
    activity("notification show");
    notification.show();
}

export async function localAction(action: LocalAction): Promise<void> {
    const state = appState.gui!;
    const local = state.local!;

    switch (action) {
        case "install":
            // Started once installed, and opened: the window uses it.
            state.localAsked = true;
            await local.install(true);
            break;
        case "start":
            state.localAsked = true;
            state.localStopNotice.reset();
            await local.start();
            break;
        case "stop":
            state.localAsked = false;
            await local.stop();
            break;
        case "restart":
            await local.restart();
            break;
        case "check-updates":
            await local.checkUpdates();
            break;
        case "show-log":
            shell.showItemInFolder(local.logFile);
            break;
        case "open": {
            // The app's own Pi Pocket runs: the window uses it, which ends a connection to another server.
            if (local.state().status === "running" && state.localLogin !== undefined) {
                openLocal(state.localLogin.url, state.localLogin.loginPath, true);
                break;
            }

            if (local.state().status !== "external") {
                state.localAsked = true;
                await local.start();
                break;
            }

            // A Pi Pocket started outside the app answers at the port: open it as another server.
            const url = local.state().url ?? `http://127.0.0.1:${String(state.settings.local.port)}`;

            connect(url);
            break;
        }
        case "uninstall": {
            const { response } = await dialog.showMessageBox(state.window, {
                type: "warning",
                message: "Uninstall Pi Pocket from this computer?",
                detail: `This stops it and removes what the app installed for it: Node.js and Pi Pocket (${local.state().home}).\n\nYour sessions, settings, and sign-in stay in Pi Pocket's data folder. Install puts it back.`,
                buttons: ["Uninstall", "Cancel"],
                defaultId: 1,
                cancelId: 1,
            });

            if (response === 0) {
                await local.uninstall();
            }

            break;
        }
    }
}
