/**
 * Windows, with the seamless title bar: Windows' own window menu (Restore, Move, Size, Minimize, Maximize, Close) stays
 * off right-clicks.
 *
 * A right-click on anything that drags the window (the strip beside the window's buttons, Pi Pocket's bars) is a
 * right-click on a title bar to Windows, which answers with that menu. It has been seen to stay open there, with the
 * whole window taking no clicks until the menu went by itself. With the event refused, Electron hands the click to the
 * page instead (its electron_desktop_window_tree_host_win.cc), and the page's own menu opens as it does anywhere else.
 *
 * Alt+Space asks for the same menu through the same event, and keeps it: a Space pressed with Alt just before the event
 * is the keyboard asking.
 */
import type { BaseWindow, Input, WebContents } from "electron";

/** How long after Alt+Space the menu that opens still counts as the keyboard's. */
export const ALT_SPACE_MS = 1000;

/** Tells the keyboard's request for the window menu from a right-click's. */
export class SystemMenuGate {
    private altSpaceAt: number | undefined;

    /** A key the page was given, before the page handles it. */
    key(input: Pick<Input, "type" | "alt" | "code">, now = Date.now()): void {
        if (input.type === "keyDown" && input.alt && input.code === "Space") {
            this.altSpaceAt = now;
        }
    }

    /** Whether the menu asked for now is the keyboard's. One menu for each press. */
    fromKeyboard(now = Date.now()): boolean {
        const at = this.altSpaceAt;

        this.altSpaceAt = undefined;

        return at !== undefined && now >= at && now - at <= ALT_SPACE_MS;
    }
}

/** Refuse Windows' window menu on `window` unless Alt+Space, pressed in one of `pages`, asked for it. */
export function keepSystemMenuOffRightClicks(window: BaseWindow, pages: readonly WebContents[]): SystemMenuGate {
    const gate = new SystemMenuGate();

    for (const page of pages) {
        page.on("before-input-event", (_event, input) => gate.key(input));
    }

    window.on("system-context-menu", (event) => {
        if (!gate.fromKeyboard()) {
            event.preventDefault();
        }
    });

    return gate;
}
