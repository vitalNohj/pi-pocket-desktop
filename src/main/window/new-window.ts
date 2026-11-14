// New Window makes a full server page, not a plain link pop-out.
import { join } from "node:path";
import { BaseWindow, screen, session, WebContentsView } from "electron";
import { SERVER_PARTITION, state } from "../app/state";
import { quit, openSettings } from "../app/menu";
import { currentOrigin, originOf } from "../connection/address";
import { openServerWindow, wireServerKeys } from "../connection/connect";
import { guardContents, type OriginPolicy } from "../core/security";
import { ASSETS } from "../core/paths";
import { setUpAppearance, windowOptions } from "./appearance";
import { addOtherWindow, lastUsedWindow, otherWindows, removeOtherWindow, windowFocused, type OtherWindow } from "./other-windows";
import { contextMenuEventAt, openContextMenu } from "./page-menu";
import { serverPreferences } from "./server-preferences";
import { keepSystemMenuOffRightClicks } from "./system-menu";
import { titleBarOptions } from "./titlebar";
import { cascadeBounds, quitAfterOtherClosed } from "./window-rules";
import { setUpOtherNavigation } from "./navigation";
import { showWindow } from "./views";

export function newWindow(): void {
    const gui = state.gui;

    if (gui === undefined) return;
    if (gui.loadedUrl === undefined || gui.unverified) {
        showWindow();

        return;
    }

    const source = lastUsedWindow() ?? gui.window;
    const bounds = source.getNormalBounds();
    const window = new BaseWindow({
        title: "Pi Pocket",
        ...cascadeBounds(bounds, screen.getDisplayMatching(bounds).workArea),
        minWidth: 360,
        minHeight: 480,
        show: false,
        backgroundColor: gui.theme.colors.bg,
        ...windowOptions(process.platform, {
            ...gui.settings.appearance,
            // A Linux window must match how the main window was made, even after a pending restart setting.
            ...(process.platform === "linux" ? { translucent: gui.translucentAtStart } : {}),
        }),
        icon: join(ASSETS, "icon-512.png"),
        autoHideMenuBar: !gui.settings.window.showMenuBar,
        ...titleBarOptions(process.platform, gui.titleBarAtStart, gui.theme),
    });
    const view = new WebContentsView({ webPreferences: serverPreferences(session.fromPartition(SERVER_PARTITION)) });
    const contents = view.webContents;
    const origin = currentOrigin();

    window.contentView.addChildView(view);
    const offset = gui.titleBar?.addWindow(window, contents) ?? (() => 0);
    const appearance = setUpAppearance({
        platform: process.platform,
        systemVersion: process.getSystemVersion(),
        window,
        views: [view],
        server: contents,
        onServerOrigin: () => originOf(contents.getURL()) === origin,
        translucentAtStart: gui.translucentAtStart,
        solid: () => gui.theme.colors.bg,
    });
    const other: OtherWindow = { window, view, origin, failed: false, offset, appearance };

    // The preload asks host:hello synchronously, so registration must precede the load.
    addOtherWindow(other);
    appearance.apply(gui.settings);
    gui.desktop?.windowsChanged();

    if (process.platform === "win32" && gui.titleBarAtStart === "seamless") {
        keepSystemMenuOffRightClicks(window, [contents]);
    }

    const policy: OriginPolicy = {
        server: () => origin,
        allowed: () => new Set([origin, ...(state.gui?.settings.server.extraOrigins ?? [])]),
    };

    guardContents(contents, policy, openServerWindow);
    const layout = (): void => {
        const { width, height } = window.getContentBounds();
        const top = offset();

        view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    };

    for (const event of ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const) {
        window.on(event as "resize", layout);
    }
    layout();
    wireServerKeys(contents);
    contents.on("before-input-event", (_event, input) => gui.dictationKey?.fromWindow(input));
    window.on("blur", () => gui.dictationKey?.windowBlurred());
    contents.on("context-menu", (_event, params) => {
        contextMenuEventAt.set(contents.id, Date.now());
        openContextMenu(window, contents, params, params, { openSettings });
    });
    contents.on("page-title-updated", (_event, title) => window.setTitle(title || "Pi Pocket"));
    contents.on("dom-ready", () => appearance.pageLoaded());
    let failedThisLoad = false;

    contents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) failedThisLoad = false;
    });
    contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) {
            failedThisLoad = true;
            other.failed = true;
        }
    });
    contents.on("render-process-gone", () => {
        failedThisLoad = true;
        other.failed = true;
        gui.desktop?.reset(contents);
    });
    contents.on("did-finish-load", () => {
        // Electron finishes its network-error document too; only a successful load clears the failure.
        if (!failedThisLoad) other.failed = false;
    });
    contents.on("did-navigate", () => gui.desktop?.reset(contents));
    setUpOtherNavigation(window);
    window.on("focus", () => windowFocused(window));
    for (const event of ["show", "hide", "minimize", "restore", "focus", "blur"] as const) {
        window.on(event as "show", () => gui.desktop?.visibilityChanged());
    }
    window.on("closed", () => {
        removeOtherWindow(window);
        gui.desktop?.reset(contents);
        contextMenuEventAt.delete(contents.id);
        // BaseWindow does not own a WebContentsView's lifetime.
        if (!contents.isDestroyed()) contents.close();

        if (!other.automaticClose && quitAfterOtherClosed({
            quitting: gui.quitting,
            closeToTray: gui.settings.window.closeToTray,
            otherWindows: otherWindows().length,
            mainVisible: !gui.window.isDestroyed() && gui.window.isVisible() && !gui.window.isMinimized(),
        })) quit();
    });

    void contents.loadURL(`${gui.loadedUrl}/`).catch(() => {
        // The failed load is marked above; the main window's health check retries it when the server answers.
    });
    window.show();
    window.focus();
    contents.focus();
}
