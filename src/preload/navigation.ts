/// <reference lib="dom" />
// Registered in both views' sessions. A separate sandboxed preload keeps their bridge code independent.
import { ipcRenderer } from "electron";

/** Shadow-root inputs and inherited contenteditable count too. Leave text-editing keys to the page. */
export function editableFocus(document: Document): boolean {
    let active = document.activeElement;

    while (active?.shadowRoot?.activeElement !== undefined && active.shadowRoot.activeElement !== null) {
        active = active.shadowRoot.activeElement;
    }

    return active !== null && ((active as HTMLElement).isContentEditable ||
        active.matches("input:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), select:not([disabled])"));
}

export function keyDirection(event: KeyboardEvent, platform: string): "back" | "forward" | undefined {
    if (event.shiftKey || event.ctrlKey || (platform === "darwin" ? !event.metaKey || event.altKey : !event.altKey || event.metaKey)) {
        return undefined;
    }

    return event.key === (platform === "darwin" ? "[" : "ArrowLeft") ? "back"
        : event.key === (platform === "darwin" ? "]" : "ArrowRight") ? "forward" : undefined;
}

if (process.isMainFrame) {
    window.addEventListener("keydown", (event) => {
        const direction = keyDirection(event, process.platform);

        if (direction !== undefined && !editableFocus(document)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            ipcRenderer.send("window:navigate", direction);
        }
    }, true);

    // Windows/Linux use BaseWindow's native app-command instead. Never route one mouse press through both paths.
    if (process.platform === "darwin") {
        window.addEventListener("mouseup", (event) => {
            if (event.button === 3 || event.button === 4) {
                event.preventDefault();
                event.stopImmediatePropagation();
                ipcRenderer.send("window:navigate", event.button === 3 ? "back" : "forward");
            }
        }, true);
    }
}
