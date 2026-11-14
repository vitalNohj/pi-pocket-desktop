// Settings that act on the desktop.
// ——— Settings that act on the desktop ———
import { globalShortcut } from "electron";
import type { Settings } from "../../shared/types";
import { setLaunchAtLogin } from "../core/platform";
import { toggleWindow } from "../window/views";
import { otherWindows } from "../window/other-windows";
import { createTray } from "../tray/tray";
import { state as appState } from "../app/state";

export function applyDesktopSettings(before: Settings | undefined): void {
    const state = appState.gui!;
    const settings = state.settings;

    state.window.setAutoHideMenuBar(!settings.window.showMenuBar);
    state.window.setMenuBarVisibility(settings.window.showMenuBar);

    if (before === undefined || before.window.launchAtLogin !== settings.window.launchAtLogin) {
        // Writing the login item at every start would undo a change made in the system's settings; only on change.
        if (before !== undefined) {
            try {
                setLaunchAtLogin(settings.window.launchAtLogin);
            } catch (error) {
                state.problems = [
                    ...state.problems,
                    { path: "window.launchAtLogin", message: `could not be set: ${(error as Error).message}` },
                ];
            }
        }
    }

    globalShortcut.unregisterAll();

    if (settings.window.hotkeyEnabled) {
        let ok = false;

        try {
            ok = globalShortcut.register(settings.window.hotkey, toggleWindow);
        } catch {
            ok = false;
        }

        if (!ok) {
            state.problems = [
                ...state.problems.filter((problem) => problem.path !== "window.hotkey"),
                { path: "window.hotkey", message: "could not be registered: another app may use it" },
            ];
        }
    }

    // The dictation key's shortcut, which unregisterAll gave back.
    state.dictationKey?.hookChanged();

    if (state.tray === undefined && state.trayAvailable) {
        state.tray = createTray();
    }

    state.appearance?.apply(settings);
    for (const other of otherWindows()) {
        other.window.setAutoHideMenuBar(!settings.window.showMenuBar);
        other.window.setMenuBarVisibility(settings.window.showMenuBar);
        other.appearance.apply(settings);
    }
    state.desktop?.refreshTray();
}
