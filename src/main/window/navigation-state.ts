// Back/Forward rules, without Electron. The settings screen is one page, not a second browser history.
import type { ConfigReason } from "../../shared/types";

export type Direction = "back" | "forward";
export interface HistoryStep {
    index: number;
    url: string;
}
export interface NavigationState {
    forwardConfig?: ConfigReason;
    pendingHistory?: HistoryStep;
}
export interface NavigationView {
    showing: "server" | "config";
    canReturn: boolean;
    reason: ConfigReason;
    origin: string;
    back?: HistoryStep;
    forward?: HistoryStep;
}
export type NavigationAction =
    | { kind: "none" }
    | { kind: "server" }
    | { kind: "config"; reason: ConfigReason }
    | { kind: "history"; direction: Direction };

/** Never go through a spent login link, about:blank, or a different origin (including a former server). */
export function safeHistoryEntry(url: string, origin: string): boolean {
    try {
        const parsed = new URL(url);

        return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin === origin &&
            !/(?:^|\/)login\/?$/.test(parsed.pathname);
    } catch {
        return false;
    }
}

export function navigationStep(state: NavigationState, direction: Direction, view: NavigationView): { state: NavigationState; action: NavigationAction } {
    if (view.showing === "config") {
        return direction === "back" && view.canReturn
            ? { state: { ...state, forwardConfig: view.reason }, action: { kind: "server" } }
            : { state, action: { kind: "none" } };
    }

    if (direction === "forward" && state.forwardConfig !== undefined) {
        return { state: state.pendingHistory === undefined ? {} : { pendingHistory: state.pendingHistory }, action: { kind: "config", reason: state.forwardConfig } };
    }

    const target = direction === "back" ? view.back : view.forward;

    if (state.pendingHistory !== undefined || target === undefined || !safeHistoryEntry(target.url, view.origin)) {
        return { state, action: { kind: "none" } };
    }

    return { state: { ...state, pendingHistory: target }, action: { kind: "history", direction } };
}

/** A commit from our own history step keeps the settings shortcut. Every other server navigation clears it. */
export function serverNavigated(state: NavigationState, entry: HistoryStep): NavigationState {
    return state.pendingHistory?.index === entry.index && state.pendingHistory.url === entry.url
        ? (state.forwardConfig === undefined ? {} : { forwardConfig: state.forwardConfig })
        : {};
}

/** Shared by before-input-event and its tests. The preload checks focus before taking this key. */
export function navigationKey(input: { key: string; alt: boolean; control: boolean; meta: boolean; shift: boolean }, platform: string): Direction | undefined {
    if (input.shift || input.control || (platform === "darwin" ? !input.meta || input.alt : !input.alt || input.meta)) {
        return undefined;
    }

    return input.key === (platform === "darwin" ? "[" : "ArrowLeft") ? "back"
        : input.key === (platform === "darwin" ? "]" : "ArrowRight") ? "forward" : undefined;
}
