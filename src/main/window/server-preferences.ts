// The same signed-in session and preload in every full server view.
import type { Session, WebPreferences } from "electron";
import { preloadPath } from "../core/paths";

export function serverPreferences(session: Session): WebPreferences {
    return {
        session,
        preload: preloadPath("server"),
        additionalArguments: ["--pocket-gui-navigation"],
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: true,
        // Notifications and the live connection keep working while a window is hidden.
        backgroundThrottling: false,
    };
}
