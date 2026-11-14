// Multi-window commands, placement, and closing rules, without Electron at runtime.
import type { MenuItemConstructorOptions, Rectangle } from "electron";

export function isNewWindowKey(
    input: { type: string; key: string; control: boolean; meta: boolean; alt: boolean; shift: boolean },
    platform: NodeJS.Platform,
): boolean {
    const mod = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;

    return input.type === "keyDown" && input.key.toLowerCase() === "n" && mod && input.shift && !input.alt;
}

export function newWindowMenuItem(click: () => void): MenuItemConstructorOptions {
    return { label: "New Window", accelerator: "CommandOrControl+Shift+N", click };
}

/** Keep the normal size; wrap both coordinates when the next step would leave this display's work area. */
export function cascadeBounds(bounds: Rectangle, workArea: Rectangle): Rectangle {
    const x = bounds.x + 28;
    const y = bounds.y + 28;
    const outside = x < workArea.x || y < workArea.y || x + bounds.width > workArea.x + workArea.width || y + bounds.height > workArea.y + workArea.height;

    return { ...bounds, x: outside ? workArea.x + 28 : x, y: outside ? workArea.y + 28 : y };
}

export function mainCloseAction(input: { quitting: boolean; closeToTray: boolean; otherWindows: number; tray: boolean }): "close" | "hide" | "minimize" {
    return !input.quitting && (input.closeToTray || input.otherWindows > 0) ? (input.tray ? "hide" : "minimize") : "close";
}

/**
 * The last other window closed. The app quits only when the person closed the main window before it (mainClosed): they
 * closed every window. A main window that is minimized or hidden for another reason keeps the app running.
 */
export function quitAfterOtherClosed(input: { quitting: boolean; closeToTray: boolean; otherWindows: number; mainClosed: boolean }): boolean {
    return !input.quitting && input.otherWindows === 0 && input.mainClosed && !input.closeToTray;
}
