// The config screen and its state.
// ——— The config screen ———
import { app } from "electron";
import type { ConfigReason, ConfigState } from "../../shared/types";
import { isAppPage } from "./config-protocol";
import { canReturn, localChoiceStatus, remoteChoiceStatus, shownReason, sideOf } from "../connection/server-choice";
import { defaultSettings } from "../core/settings";
import { currentOrigin } from "../connection/address";
import { show } from "../window/views";
import { state as appState } from "../app/state";

export function configState(): ConfigState {
    const state = appState.gui!;
    const inUse = state.settings.server.mode;
    const connectedUrl = inUse === "remote" ? state.loadedUrl : undefined;
    const local = state.local!.state();

    return {
        settings: state.settings,
        defaults: defaultSettings(),
        problems: state.problems,
        configPath: state.configPath,
        reason: shownReason(state.reason, sideOf(state.reason, inUse), state.viewing),
        ...(state.probe === undefined ? {} : { probe: state.probe }),
        ...(state.retry === undefined || state.viewing !== "remote" ? {} : { nextRetryAt: state.retry.at }),
        ...(connectedUrl === undefined ? {} : { connectedUrl }),
        viewing: state.viewing,
        inUse,
        choices: {
            local: localChoiceStatus(local),
            remote: remoteChoiceStatus({ connectedUrl, error: state.remoteError }),
        },
        ...(connectedUrl === undefined && state.remoteError?.kind === "dropped" ? { disconnected: { url: state.remoteError.url, line: state.remoteError.line } } : {}),
        canReturn: canReturn({ inUse, viewing: state.viewing, loaded: state.loadedUrl !== undefined }),
        recovery: state.showing === "server" && state.unverified,
        trayAvailable: state.trayAvailable,
        translucency: state.appearance?.support() ?? { kind: "unsupported", message: "" },
        translucentAtStart: state.translucentAtStart,
        titleBarAtStart: state.titleBarAtStart,
        theme: state.theme,
        platform: process.platform,
        appVersion: app.getVersion(),
        update: state.updates?.state() ?? { method: "source", status: "idle" },
        local,
        dictation: state.dictation!.state(),
        billionContext: state.billionContext!.state(),
        runner: { ...state.runner!.state(), ...(currentOrigin() === "null" ? {} : { suggestedServer: currentOrigin() }) },
    };
}

export function pushConfigState(): void {
    if (appState.gui !== undefined && !appState.gui.config.webContents.isDestroyed()) {
        appState.gui.config.webContents.send("config:state", configState());
    }
}

export function showConfig(reason: ConfigReason): void {
    if (appState.gui === undefined) {
        return;
    }

    appState.gui.reason = reason;
    show("config");
}

/** The config page may only be the app's own page: it never navigates or opens windows. */
export function lockConfigView(): void {
    const contents = appState.gui!.config.webContents;

    contents.on("will-navigate", (event) => {
        // Its own pages only (a reload): links in it go through the main process.
        if (!isAppPage(event.url)) {
            event.preventDefault();
        }
    });
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
}
