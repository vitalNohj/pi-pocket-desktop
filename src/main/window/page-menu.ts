// The server page's right-click menu.
import { BaseWindow, clipboard, Menu, type WebContents } from "electron";
import { contextMenuTemplate, type ClickInfo, type MenuActions } from "./context-menu";
import { MENU_WORLD, menuScript, menuSheet, pickScript, runPicked, themedGroups } from "./themed-menu";
import { state } from "../app/state";

/** When each page's last `context-menu` event came: a report from its preload for the same click then opens nothing. */
export const contextMenuEventAt = new Map<number, number>();

/** The menus drawn so far: each is waited for by its number. */
let menusDrawn = 0;

/**
 * The right-click menu on one of the server's pages: `contextMenuTemplate`'s items, drawn in the page in Pi Pocket's
 * theme (src/main/window/themed-menu.ts). Where the page cannot draw it, the same template pops up as the native menu.
 */
export function openContextMenu(
    window: BaseWindow,
    contents: WebContents,
    click: ClickInfo,
    at: { x: number; y: number },
    actions: Pick<MenuActions, "openSettings">,
): void {
    const template = contextMenuTemplate(click, { ...spelling(contents), ...actions });
    const native = (): void => {
        if (!contents.isDestroyed() && !window.isDestroyed()) {
            Menu.buildFromTemplate(template).popup({ window });
        }
    };
    const mac = process.platform === "darwin";
    const key = ++menusDrawn;
    const script = menuScript(key, {
        groups: themedGroups(template, mac),
        x: at.x,
        y: at.y,
        label: "Pi Pocket",
        sheet: menuSheet(state.gui!.theme),
    });

    contents.executeJavaScriptInIsolatedWorld(MENU_WORLD, [{ code: script }], true).then(
        (shown: unknown) => {
            if (shown !== true) {
                native();

                return;
            }

            contents.executeJavaScriptInIsolatedWorld(MENU_WORLD, [{ code: pickScript(key) }], true).then(
                (id: unknown) => {
                    if (!contents.isDestroyed()) {
                        runPicked(template, id, {
                            cut: () => contents.cut(),
                            copy: () => contents.copy(),
                            paste: () => contents.paste(),
                            selectAll: () => contents.selectAll(),
                        });
                    }
                },
                // The page went away with the menu open: there is nothing left to act on.
                () => undefined,
            );
        },
        native,
    );
}

/** Something to paste: what Chromium checks before it enables Paste. */
export async function clipboardHasContent(): Promise<boolean> {
    try {
        return (await clipboard.read()).some((item) => item.types.length > 0);
    } catch {
        return true;
    }
}

/** The right-click menu's spelling actions on a page: replace the word clicked, or add it to the dictionary. */
export function spelling(contents: WebContents): { replace: (word: string) => void; learn: (word: string) => void } {
    return {
        replace: (word) => contents.replaceMisspelling(word),
        learn: (word) => contents.session.addWordToSpellCheckerDictionary(word),
    };
}
