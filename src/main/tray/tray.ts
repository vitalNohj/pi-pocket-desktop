// Creation of the tray icon.
import { join } from "node:path";
import { nativeImage, Tray } from "electron";
import { ASSETS } from "../core/paths";
import { toggleWindow } from "../window/views";

/** The tray icon. Its menu and image (the pins, a dot when sessions need you) come from src/main/bridge/desktop.ts. */
export function createTray(): Tray {
    const image = nativeImage.createFromPath(join(ASSETS, "icon-192.png")).resize({ width: 22, height: 22 });
    const tray = new Tray(image);

    tray.setToolTip("Pi Pocket");

    // On macOS a menu-bar icon only opens its menu, as every other one there does; "Open Pi Pocket" in it shows the
    // window. Elsewhere a click on the tray icon shows or hides the window, and right-click opens the menu.
    if (process.platform !== "darwin") {
        tray.on("click", toggleWindow);
    }

    return tray;
}
