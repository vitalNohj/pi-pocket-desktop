// Registered full server windows. Pop-outs never enter this registry.
import type { BaseWindow, WebContents, WebContentsView } from "electron";
import { state, type Gui } from "../app/state";
import { currentOrigin } from "../connection/address";

export interface OtherWindow {
    window: BaseWindow;
    view: WebContentsView;
    origin: string;
    failed: boolean;
    /** Server cleanup is not the person closing their last window. */
    automaticClose?: boolean;
    offset: () => number;
    appearance: NonNullable<Gui["appearance"]>;
}

export interface ServerPage {
    window: BaseWindow;
    contents: WebContents;
    origin: string;
}

const others = new Map<BaseWindow, OtherWindow>();
let lastFocused: BaseWindow | undefined;
let mainCloseHeld = false;

/**
 * The person closed the main window while it could not close (another window was open, or close to tray): it was kept,
 * hidden or minimized. False again once it shows. A main window that was only minimized, or hidden by the hotkey, was
 * not closed.
 */
export function holdMainClose(held: boolean): void {
    mainCloseHeld = held;
}

export function mainCloseIsHeld(): boolean {
    return mainCloseHeld;
}

export function otherWindows(): readonly OtherWindow[] {
    return [...others.values()];
}

export function addOtherWindow(other: OtherWindow): void {
    others.set(other.window, other);
}

export function removeOtherWindow(window: BaseWindow): void {
    others.delete(window);

    if (lastFocused === window) lastFocused = undefined;
}

export function otherWindow(window: BaseWindow | undefined): OtherWindow | undefined {
    return window === undefined ? undefined : others.get(window);
}

export function serverPages(): ServerPage[] {
    const gui = state.gui;
    const pages: ServerPage[] = gui === undefined || gui.window.isDestroyed() || gui.server.webContents.isDestroyed()
        ? [] : [{ window: gui.window, contents: gui.server.webContents, origin: currentOrigin() }];

    for (const other of others.values()) {
        if (!other.window.isDestroyed() && !other.view.webContents.isDestroyed()) {
            pages.push({ window: other.window, contents: other.view.webContents, origin: other.origin });
        }
    }

    return pages;
}

export function serverPage(contents: WebContents): ServerPage | undefined {
    return serverPages().find((page) => page.contents === contents);
}

export function isServerPage(contents: WebContents): boolean {
    return serverPage(contents) !== undefined;
}

export function serverPageWindow(contents: WebContents): BaseWindow | undefined {
    return serverPage(contents)?.window;
}

/** Both the main window and other windows report focus; a closed last window falls back to the main one. */
export function windowFocused(window: BaseWindow): void {
    lastFocused = window;
}

export function lastUsedWindow(): BaseWindow | undefined {
    return lastFocused !== undefined && others.has(lastFocused) && !lastFocused.isDestroyed() ? lastFocused : state.gui?.window;
}

/** A different origin (or side) is in use. No argument closes every other window. */
export function closeOtherWindows(keepOrigin?: string): void {
    for (const other of otherWindows()) {
        if (other.origin !== keepOrigin) {
            other.automaticClose = true;
            other.window.close();
        }
    }
}

/** The server answers again. Pages that stayed connected need no reload. */
export function reloadFailedOtherWindows(): void {
    for (const other of others.values()) {
        const contents = other.view.webContents;

        if (!other.failed || other.origin !== currentOrigin() || contents.isDestroyed()) continue;
        other.failed = false;

        if (contents.getURL() === "" || contents.getURL() === "about:blank") {
            void contents.loadURL(`${state.gui?.loadedUrl ?? other.origin}/`).catch(() => {});
        } else {
            contents.reload();
        }
    }
}
