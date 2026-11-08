// Window visibility and view layout.
import { pushConfigState } from "../settings-screen/screen";
import { state } from "../app/state";

export function layout(): void {
    if (state.gui === undefined) {
        return;
    }

    const { width, height } = state.gui.window.getContentBounds();
    // Below the title bar's strip only when the page could not be told to keep clear of it (src/main/window/titlebar.ts).
    const top = state.gui.titleBar?.offset() ?? 0;

    const recovery = state.gui.showing === "server" && state.gui.unverified ? Math.min(48, height) : 0;

    state.gui.server.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top - recovery) });
    state.gui.config.setBounds({ x: 0, y: recovery > 0 ? height - recovery : 0, width, height: recovery > 0 ? recovery : height });
}

export function show(which: "server" | "config"): void {
    if (state.gui === undefined) {
        return;
    }

    state.gui.showing = which;
    state.gui.server.setVisible(which === "server");
    state.gui.config.setVisible(which === "config" || state.gui.unverified);
    layout();
    (which === "server" ? state.gui.server : state.gui.config).webContents.focus();
    state.gui.window.setTitle(which === "server" ? state.gui.server.webContents.getTitle() || "Pi Pocket" : "Pi Pocket — Desktop Settings");
    state.gui.desktop?.visibilityChanged();
    pushConfigState();
}

export function showWindow(): void {
    if (state.gui === undefined) {
        return;
    }

    if (state.gui.window.isMinimized()) {
        state.gui.window.restore();
    }

    state.gui.window.show();
    state.gui.window.focus();
}

export function toggleWindow(): void {
    if (state.gui === undefined) {
        return;
    }

    if (state.gui.window.isVisible() && state.gui.window.isFocused()) {
        if (state.gui.tray !== undefined) {
            state.gui.window.hide();
        } else {
            state.gui.window.minimize();
        }
    } else {
        showWindow();
    }
}
