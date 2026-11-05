// Calls from the config page.
// ——— Calls from the config page ———
import { existsSync } from "node:fs";
import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import type { BillionContextAction, DictationAction, LocalAction } from "../../shared/types";
import { mayConnect } from "../connection/connection";
import { isAppPage } from "./config-protocol";
import { connectFailed } from "../connection/server-choice";
import { saveSettings, validateSettings } from "../core/settings";
import { configState, pushConfigState, showConfig } from "./screen";
import { sameAddress, checkAddress } from "../connection/address";
import { stopRetry, scheduleRetry } from "../connection/retry";
import { applyDesktopSettings } from "./apply";
import { checkCombo, comboLabel } from "../dictation/key-combo";
import { startHealth } from "../connection/health";
import { connect } from "../connection/connect";
import { openSettings } from "../app/menu";
import { show } from "../window/views";
import { navigate } from "../window/navigation";
import { openLocal, localAction } from "../local-server/use";
import { LINKS } from "../app/links";
import { billionContextAction } from "../billion-context/action";
import { state as appState } from "../app/state";

export function fromConfigPage(event: IpcMainInvokeEvent): boolean {
    const frame = event.senderFrame;

    return (
        appState.gui !== undefined &&
        event.sender === appState.gui.config.webContents &&
        frame !== null &&
        frame.parent === null &&
        isAppPage(frame.url)
    );
}

export function handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args) => {
        if (!fromConfigPage(event)) {
            throw new Error("Not allowed");
        }

        return listener(event, ...args);
    });
}

export function registerIpc(): void {
    handle("config:state", () => configState());

    handle("config:probe", async (_event, url) => {
        if (typeof url !== "string") {
            throw new Error("Not an address");
        }

        // The person checks another address: the background tries of the saved one would only confuse.
        if (!sameAddress(url, appState.gui!.settings.server.url)) {
            stopRetry();
        }

        const found = await checkAddress(url);

        // A check that finds Pi Pocket clears the error on the Another server choice.
        if (found.kind === "detected" && appState.gui!.remoteError !== undefined) {
            appState.gui!.remoteError = undefined;
            pushConfigState();
        }

        return found;
    });

    // The person looks at a side: only that. Nothing connects, disconnects, starts, or stops.
    handle("config:view", (_event, side) => {
        if (side !== "local" && side !== "remote") {
            throw new Error("Not a side");
        }

        // A Connect under way goes on: the person asked for it.
        appState.gui!.viewing = side;
        pushConfigState();
    });

    handle("config:save", (_event, input) => {
        const state = appState.gui!;
        const before = state.settings;
        const checked = validateSettings(input);

        // The server in use changes only by Connect, Start, or Open, never with a page's copy of the settings.
        checked.settings.server.mode = before.server.mode;
        state.settings = checked.settings;
        state.problems = checked.problems;
        saveSettings(state.configPath, state.settings);
        applyDesktopSettings(before);
        state.dictation?.settingsChanged();
        state.dictationKey?.settingsChanged();

        if (!state.server.webContents.isDestroyed()) {
            state.server.webContents.send("host:dictation-key", state.dictationKey?.pageKey() ?? null);
        }

        state.anywhere?.settingsChanged();

        if (
            before.runner.confirmSessions !== state.settings.runner.confirmSessions ||
            before.runner.allowHttp !== state.settings.runner.allowHttp
        ) {
            void state.runner?.confirmChanged();
        }

        if (before.runner.enabled !== state.settings.runner.enabled) {
            state.runner?.enabledChanged();
        }

        if (!sameAddress(before.server.url, state.settings.server.url)) {
            state.probe = undefined;
        }

        if (state.health !== undefined) {
            startHealth();
        }

        return configState();
    });

    handle("config:connect", async (_event, url, allowUnverified) => {
        if (typeof url !== "string") {
            throw new Error("Not an address");
        }

        const state = appState.gui!;
        const attempt = ++state.connectionAttempt;

        stopRetry();
        const found = await checkAddress(url);

        if (appState.gui !== state || attempt !== state.connectionAttempt) {
            return found;
        }

        // Enforce this at the IPC boundary too: never save/navigate to an API error or an unreachable address.
        if (mayConnect(found, allowUnverified === true)) {
            state.probe = found;
            connect(found.url, found.kind !== "detected");
        } else {
            state.remoteError = connectFailed(found);
            state.viewing = "remote";
            showConfig({ kind: "not-detected", probe: found });
        }

        return found;
    });

    handle("config:open-settings", openSettings);

    handle("config:back", () => {
        if (appState.gui?.showing === "config") navigate("back");
    });

    handle("config:retry", async () => {
        stopRetry();

        const state = appState.gui!;

        if (state.viewing === "local") {
            if (state.settings.server.mode === "local" && state.loadedUrl !== undefined) {
                state.server.webContents.reload();
                show("server");
            } else if (state.localLogin !== undefined) {
                openLocal(state.localLogin.url, state.localLogin.loginPath, true);
            } else {
                state.localAsked = true;
                await state.local!.start();
            }

            return;
        }

        state.retryAttempt = 0;

        const found = await checkAddress(state.settings.server.url);

        if (found.kind === "detected") {
            connect(state.settings.server.url);
        } else {
            if (state.reason.kind === "not-detected") {
                state.reason = { kind: "not-detected", probe: found };
            }

            scheduleRetry();
        }
    });

    handle("config:open-external", (_event, target) => {
        if (target === "github" || target === "docs" || target === "releases") {
            void shell.openExternal(LINKS[target]);
        }
    });

    handle("config:check-updates", () => appState.gui!.updates?.check(true));

    handle("config:update-action", () => appState.gui!.updates?.act());

    handle("config:local", (_event, action) => {
        const actions: LocalAction[] = ["install", "start", "stop", "restart", "open", "check-updates", "show-log", "uninstall"];

        if (typeof action !== "string" || !(actions as string[]).includes(action)) {
            throw new Error("Not an action");
        }

        return localAction(action as LocalAction);
    });

    // The Runner card's form: the server's address and a one-time code from its Menu → Runners, as `runner link` takes.
    handle("config:link-runner", async (_event, request: unknown) => {
        const { server, code } = (typeof request === "object" && request !== null ? request : {}) as { server?: unknown; code?: unknown };

        if (typeof server !== "string" || server.trim() === "") {
            throw new Error("Enter the server's address.");
        }

        if (typeof code !== "string" || !/^[A-Za-z0-9-]{4,64}$/.test(code.trim())) {
            throw new Error("Enter the one-time code from the server's Menu → Runners → Link a computer.");
        }

        await appState.gui!.runner!.linkTo(server.trim(), code.trim().toUpperCase());

        // The runner runs from Pi Pocket on this computer: keep that current, also while another server is in use.
        if (appState.gui!.settings.server.mode !== "local") {
            appState.gui!.local!.keepCurrent();
        }
    });

    handle("config:record-key", (_event, on: unknown) => {
        appState.gui!.dictationKey?.pause(on === true);
    });

    handle("config:check-key", (_event, keys: unknown) => {
        if (typeof keys !== "string" || keys.length > 200) {
            throw new Error("Not keys");
        }

        const checked = checkCombo(keys);

        return checked.ok ? { ok: true, key: checked.key, label: comboLabel(checked.combo, process.platform) } : checked;
    });

    handle("config:runner-folders", (_event, remove: unknown) => {
        const runner = appState.gui!.runner!;

        if (remove === undefined) {
            return runner.refreshFolders();
        }

        if (typeof remove !== "string" || remove.length === 0) {
            throw new Error("Not a folder");
        }

        return runner.removeFolder(remove);
    });

    handle("config:runner", async (_event, action) => {
        const runner = appState.gui!.runner!;

        switch (action) {
            case "unlink": {
                const link = runner.link();
                const answer = await dialog.showMessageBox(appState.gui!.window, {
                    type: "question",
                    buttons: ["Unlink", "Cancel"],
                    defaultId: 1,
                    cancelId: 1,
                    message: "Unlink this computer?",
                    detail: `The runner stops, and ${link?.server ?? "the server"} can no longer run sessions' tools here. Remove "${link?.name ?? "this computer"}" under Menu → Runners there too.`,
                });

                if (answer.response === 0) {
                    await runner.unlink();
                }

                return;
            }
            case "restart":
                return runner.restart();
            default:
                throw new Error("Unknown runner action");
        }
    });

    handle("config:billion-context", (_event, action) => {
        const actions: BillionContextAction[] = ["install", "uninstall", "check", "show-folder", "open-page"];

        if (typeof action !== "string" || !(actions as string[]).includes(action)) {
            throw new Error("Not an action");
        }

        return billionContextAction(action as BillionContextAction);
    });

    handle("config:dictation", (_event, action) => {
        const value = action as Partial<DictationAction> | null;

        if (
            typeof value !== "object" ||
            value === null ||
            typeof value.id !== "string" ||
            !["download", "cancel", "remove", "use"].includes(String(value.type))
        ) {
            throw new Error("Not an action");
        }

        // A download runs on: its progress shows through the state.
        const done = appState.gui!.dictation!.act(value as DictationAction);

        if (value.type === "download") {
            done.catch((error: unknown) => {
                console.error(error);
            });

            return undefined;
        }

        return done;
    });

    handle("config:reset-accessibility", () => appState.gui!.anywhere?.resetPermission() ?? false);

    handle("config:show-dictation-folder", () => {
        const folder = appState.gui!.dictation!.state().folder;

        void shell.openPath(existsSync(folder) ? folder : app.getPath("userData"));
    });

    handle("config:choose-folder", async (_event, start) => {
        const result = await dialog.showOpenDialog(appState.gui!.window, {
            properties: ["openDirectory", "createDirectory"],
            ...(typeof start === "string" && start !== "" ? { defaultPath: start } : {}),
        });

        return result.canceled ? undefined : result.filePaths[0];
    });

    handle("config:relaunch", () => {
        appState.gui!.quitting = true;
        app.relaunch();
        app.quit();
    });

    handle("config:show-file", () => {
        const state = appState.gui!;

        if (!existsSync(state.configPath)) {
            saveSettings(state.configPath, state.settings);
        }

        shell.showItemInFolder(state.configPath);
    });
}
