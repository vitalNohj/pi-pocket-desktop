// Server connections and server-page events.
// ——— Connecting ———
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, dialog, session, type ContextMenuParams } from "electron";
import { NavigationResponses } from "./connection";
import { isNewSessionKey } from "../bridge/new-session";
import { saveRequestEnded, saveRequestStarted, saveResponse } from "../bridge/save-file";
import { networkMessage } from "./probe";
import { guardContents, openOutside, type OriginPolicy } from "../core/security";
import { saveSettings } from "../core/settings";
import { normalizeServerUrl } from "../core/url";
import { activity, diagnose } from "../diagnostics/stall-watchdog";
import { ASSETS } from "../core/paths";
import { showConfig } from "../settings-screen/screen";
import { stopRetry, serverLost } from "./retry";
import { useServer } from "../local-server/use";
import { sameAddress, serverUrl, checkAddress, originOf, currentOrigin } from "./address";
import { show } from "../window/views";
import { startHealth, loadAgain } from "./health";
import { openSettings, newSession } from "../app/menu";
import { contextMenuEventAt, openContextMenu } from "../window/page-menu";
import { SERVER_PARTITION, state as appState } from "../app/state";

export function connect(url: string, unverified = false): void {
    const state = appState.gui!;
    const normalized = normalizeServerUrl(url);

    if (!normalized.ok) {
        showConfig({ kind: "not-detected", probe: { kind: "invalid", url, message: normalized.message } });

        return;
    }

    if (normalized.url !== state.settings.server.url) {
        state.settings = { ...state.settings, server: { ...state.settings.server, url: normalized.url } };
        saveSettings(state.configPath, state.settings);
    } else if (!existsSync(state.configPath)) {
        saveSettings(state.configPath, state.settings);
    }

    stopRetry();
    state.retryAttempt = 0;
    state.reason = { kind: "user" };
    state.unverified = unverified;
    state.remoteError = undefined;
    state.viewing = "remote";
    state.localAsked = false;

    // The window uses another server now; this computer's Pi Pocket keeps running until the person stops it.
    if (state.settings.server.mode !== "remote") {
        useServer("remote");
        state.loadedUrl = undefined;
    }

    if (state.loadedUrl !== undefined && sameAddress(state.loadedUrl, normalized.url)) {
        show("server");
        startHealth();

        return;
    }

    state.loadedUrl = normalized.url;
    activity("page load");
    diagnose(`page: loading ${normalized.url}`);
    void state.server.webContents.loadURL(`${normalized.url}/`).catch(() => {
        // did-fail-load shows the error.
    });
    show("server");
    startHealth();
}

export function watchServerView(): void {
    const contents = appState.gui!.server.webContents;

    const responses = new NavigationResponses();
    const contentsId = contents.id;

    contents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) {
            responses.started();

            // A new load: if it fails too, did-fail-load says so again.
            if (appState.gui !== undefined) {
                appState.gui.loadFailed = false;
            }
        }
    });

    const notifyDownload = (message: string) => appState.gui?.desktop?.notifyDownload(message);

    contents.session.webRequest.onBeforeRequest((details, callback) => {
        const origin = currentOrigin();
        const fromServer = details.webContentsId === contentsId && details.frame === contents.mainFrame && details.initiatorOrigin === origin;

        saveRequestStarted(details.id, details.url, details.webContentsId, origin, fromServer);
        callback({});
    });
    contents.session.webRequest.onCompleted((details) => saveRequestEnded(details.id));
    contents.session.webRequest.onErrorOccurred((details) => saveRequestEnded(details.id));

    // Record before commitment, but do not change UI here: an attachment has headers yet never replaces the page.
    contents.session.webRequest.onHeadersReceived((details, callback) => {
        // Electron has one headers hook per session: share it with file downloads.
        const redirect = [301, 302, 303, 307, 308].includes(details.statusCode) &&
            Object.entries(details.responseHeaders ?? {}).some(([name, values]) => name.toLowerCase() === "location" && values.some(Boolean));

        if (saveResponse(details.id, details.statusCode, notifyDownload, redirect)) {
            callback({ cancel: true });

            return;
        }

        if (details.webContentsId === contentsId && details.resourceType === "mainFrame") {
            const type = Object.entries(details.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === "content-type")?.[1][0] ?? "";

            responses.received(details.url, type);
        }

        callback({});
    });

    // These belong to the app, not to the server's HTML, CSS, or keyboard handlers.
    contents.on("before-input-event", (event, input) => {
        if (input.type === "keyDown" && input.key === "," && (process.platform === "darwin" ? input.meta : input.control) && !input.alt) {
            event.preventDefault();
            openSettings();
        } else if (isNewSessionKey(input, process.platform)) {
            event.preventDefault();
            newSession();
        }
    });
    contents.on("context-menu", (_event, params) => {
        contextMenuEventAt.set(contents.id, Date.now());
        openContextMenu(appState.gui!.window, contents, params, params, { openSettings });
    });

    // Electron says when the page stops answering (not while the title bar's debugger is attached, electron#54323: the
    // health check's own look at the page covers that).
    contents.on("unresponsive", () => {
        diagnose("page: unresponsive");
        appState.gui?.pageHang.unresponsive();
    });
    contents.on("responsive", () => {
        diagnose("page: responsive again");
        appState.gui?.pageHang.responsive();
    });

    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
        // -3 is ERR_ABORTED: a navigation that another one replaced, not a failure.
        if (!isMainFrame || code === -3 || appState.gui === undefined) {
            return;
        }

        diagnose(`page: did-fail-load ${String(code)} ${description} ${url}`);

        // This computer's Pi Pocket still runs (its launcher restarts the server, or a reload met the restart): keep
        // it, and load again once it answers. When its process stops, localDown says so. (With the checks turned off,
        // the settings screen shows the error, as before.)
        if (
            appState.gui.settings.server.mode === "local" &&
            appState.gui.loadedUrl !== undefined &&
            appState.gui.local?.state().status === "running" &&
            appState.gui.settings.connection.healthIntervalSeconds > 0
        ) {
            appState.gui.loadFailed = true;

            if (appState.gui.health === undefined) {
                startHealth();
            }

            return;
        }

        serverLost({ kind: "load-failed", url, message: networkMessage(new Error(description), appState.gui.settings.connection.probeTimeoutMs) }, true);
    });

    contents.on("render-process-gone", (_event, details) => {
        if (appState.gui === undefined || details.reason === "clean-exit") {
            return;
        }

        // reloadServer replaces a hung renderer: the old one is gone, load the page in a new one.
        if (appState.gui.replacing !== undefined) {
            loadAgain();

            return;
        }

        serverLost({ kind: "crashed", message: `The page stopped (${details.reason}).` }, true);
    });

    contents.on("page-title-updated", (_event, title) => {
        if (appState.gui?.showing === "server") {
            appState.gui.window.setTitle(title || "Pi Pocket");
        }
    });

    // Only a committed main-frame navigation replaces the page. Downloads and subresource errors leave it alone.
    contents.on("did-navigate", (_event, url, status) => {
        appState.gui?.desktop?.reset();
        const message = responses.committed(url, status, appState.gui?.unverified ?? false);

        if (appState.gui !== undefined && appState.gui.loadedUrl !== undefined && message !== undefined) {
            appState.gui.unverified = false;
            stopRetry();
            serverLost({ kind: "load-failed", url: serverUrl(), message }, false);
        }
    });

    contents.on("did-finish-load", () => {
        // A page that loads answers: whatever hung is gone.
        appState.gui?.pageHang.responsive();

        // The login link is spent: Back must not go to it.
        if (appState.gui?.signingIn === true && !contents.getURL().includes("/login")) {
            appState.gui.signingIn = false;
            contents.navigationHistory.clear();
        }

        tellNoBridge();

        // After a sign-in redirects back, detection can succeed and remove the recovery footer.
        if (appState.gui?.unverified) {
            void checkAddress(appState.gui.settings.server.url);
        }
    });

    // Each document starts without the see-through CSS: give it again as soon as there is a page to give it to.
    contents.on("dom-ready", () => {
        appState.gui?.appearance?.pageLoaded();
    });
}

/**
 * Once in each run: a server without the bridge (an older Pi Pocket) still works, but without the badge, pins, and
 * notifications. Say so, on the server's own address only.
 */
export function tellNoBridge(): void {
    const state = appState.gui!;
    const probe = state.probe;

    if (
        state.loadedUrl === undefined ||
        state.toldNoBridge ||
        probe?.kind !== "detected" ||
        probe.bridge > 0 ||
        originOf(state.server.webContents.getURL()) !== currentOrigin()
    ) {
        return;
    }

    state.toldNoBridge = true;
    void dialog.showMessageBox(state.window, {
        type: "info",
        title: "Pi Pocket",
        message: "This server doesn't support desktop features yet.",
        detail: "Please update it. Until then, the tray's pins, the badge, and native notifications stay off; everything else works.",
        buttons: ["OK"],
    });
}

/** Opens one of the server's own pages that asked for a new window: in a plain window of this app, or outside. */
export function openServerWindow(url: string): void {
    const state = appState.gui!;

    if (state.settings.window.sameOriginLinks === "browser") {
        openOutside(url);

        return;
    }

    const child = new BrowserWindow({
        width: 1100,
        height: 800,
        icon: join(ASSETS, "icon-512.png"),
        autoHideMenuBar: !state.settings.window.showMenuBar,
        backgroundColor: "#1a1b26",
        webPreferences: {
            session: session.fromPartition(SERVER_PARTITION),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
        },
    });
    const policy: OriginPolicy = {
        server: () => currentOrigin(),
        allowed: () => new Set([currentOrigin(), ...(appState.gui?.settings.server.extraOrigins ?? [])]),
    };

    guardContents(child.webContents, policy, openServerWindow);
    child.webContents.on("context-menu", (_event, params: ContextMenuParams) => {
        openContextMenu(child, child.webContents, params, params, {});
    });
    // The caption buttons' nativeTheme is process-wide: this window is given the system's scheme, and until it is,
    // nativeTheme stays "system" (src/main/window/titlebar.ts). Registered before loading, which the protocol needs first.
    void state.titleBar?.followSystemScheme(child.webContents);
    void child.loadURL(url);
}
