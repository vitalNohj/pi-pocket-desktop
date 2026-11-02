import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as rules from "../main/window/navigation-state";
import type { ConfigReason } from "../shared/types";
import type * as Navigation from "../main/window/navigation";

/** Actual main-process wiring and pure rules, with only Electron and the rest of the app replaced. */
function app(platform = "linux") {
    const entries = ["about:blank", "https://pocket.example/", "https://pocket.example/?session=one", "https://pocket.example/?sheet=settings"];
    let index = 2;
    const historyCalls: string[] = [];
    const shortcuts: boolean[] = [];
    const history = {
        getActiveIndex: () => index,
        getEntryAtIndex: (at: number) => ({ url: entries[at] }),
        canGoBack: () => index > 0,
        canGoForward: () => index < entries.length - 1,
        goBack: () => { historyCalls.push("back"); index--; },
        goForward: () => { historyCalls.push("forward"); index++; },
    };
    const contents = () => Object.assign(new EventEmitter(), { navigationHistory: history, isDestroyed: () => false, setIgnoreMenuShortcuts: (ignore: boolean) => shortcuts.push(ignore) });
    const gui = {
        navigation: {} as rules.NavigationState,
        window: new EventEmitter(),
        server: { webContents: contents() },
        config: { webContents: contents() },
        showing: "server",
        viewing: "remote",
        reason: { kind: "user", section: "dictation" } as ConfigReason,
        settings: { server: { mode: "remote" } },
        loadedUrl: "https://pocket.example/" as string | undefined,
        connectionAttempt: 0,
    };
    const ipcMain = new EventEmitter();
    const exports = {} as typeof Navigation;
    const openSettings: ConfigReason[] = [];

    runInNewContext(readFileSync(join(__dirname, "..", "main", "window", "navigation.js"), "utf8"), {
        exports,
        process: { platform },
        require: (name: string) => {
            switch (name) {
                case "electron": return { ipcMain };
                case "../app/state": return { state: { gui } };
                case "./navigation-state": return rules;
                case "../connection/address": return { currentOrigin: () => "https://pocket.example", originOf: (url: string) => new URL(url).origin };
                case "../connection/server-choice": return { canReturn: (input: { loaded: boolean; inUse: string; viewing: string }) => input.loaded && input.inUse === input.viewing };
                case "../settings-screen/config-protocol": return { isAppPage: (url: string) => url === "pocket-gui://app/" };
                case "../settings-screen/screen": return { showConfig: (reason: ConfigReason) => { gui.showing = "config"; gui.reason = reason; openSettings.push(reason); } };
                case "./views": return { show: (which: string) => { gui.showing = which; } };
                default: throw new Error(`Unexpected import: ${name}`);
            }
        },
    });
    exports.setUpNavigation();

    return { gui, ipcMain, historyCalls, shortcuts, openSettings, navigate: exports.navigate, commit: () => gui.server.webContents.emit("did-navigate-in-page", {}, entries[index], true) };
}

test("BaseWindow app-command handles both views on Windows and Linux, without a second mouse path", () => {
    for (const platform of ["win32", "linux"]) {
        const state = app(platform);
        const reason = state.gui.reason;

        state.gui.showing = "config";
        state.gui.window.emit("app-command", {}, "browser-backward");
        assert.equal(state.gui.showing, "server");
        assert.equal(state.gui.connectionAttempt, 1);
        assert.equal(state.historyCalls.length, 0);
        state.gui.window.emit("app-command", {}, "browser-forward");
        assert.equal(state.gui.showing, "config");
        assert.deepEqual(state.openSettings, [reason]);
        state.gui.window.emit("app-command", {}, "volume-up");
        assert.equal(state.openSettings.length, 1);
        assert.equal(state.gui.window.listenerCount("swipe"), 0);
    }
});

test("macOS uses swipe left/back, right/forward and ignores other swipe directions", () => {
    const state = app("darwin");

    state.gui.showing = "config";
    state.gui.window.emit("swipe", {}, "left");
    assert.equal(state.gui.showing, "server");
    state.gui.window.emit("swipe", {}, "up");
    assert.equal(state.gui.showing, "server");
    state.gui.window.emit("swipe", {}, "right");
    assert.equal(state.gui.showing, "config");
    assert.equal(state.gui.window.listenerCount("app-command"), 0);
});

test("only the shown view's main frame, on its expected origin, may send navigation IPC", () => {
    const state = app();
    const event = { sender: state.gui.server.webContents, senderFrame: { parent: null, url: "https://pocket.example/" } };
    const send = (event: unknown, direction: unknown = "back") => state.ipcMain.emit("window:navigate", event, direction);

    send({ ...event, senderFrame: null });
    send({ ...event, senderFrame: { ...event.senderFrame, parent: {} } });
    send({ ...event, senderFrame: { ...event.senderFrame, url: "https://other.example/" } });
    send({ ...event, sender: state.gui.config.webContents });
    send(event, "other");
    assert.equal(state.historyCalls.length, 0);
    send(event);
    assert.deepEqual(state.historyCalls, ["back"]);
    state.commit();
    state.gui.showing = "config";
    send(event);
    assert.equal(state.historyCalls.length, 1);
    send({ sender: state.gui.config.webContents, senderFrame: { parent: null, url: "pocket-gui://app/" } });
    assert.equal(state.gui.showing, "server");
});

test("main ignores menu shortcuts only for the navigation keys in both views, resetting for other keys", () => {
    for (const platform of ["linux", "darwin"]) {
        const state = app(platform);
        const input = { key: platform === "darwin" ? "[" : "ArrowLeft", alt: platform !== "darwin", meta: platform === "darwin", shift: false, control: false };

        for (const view of [state.gui.server, state.gui.config]) {
            view.webContents.emit("before-input-event", {}, input);
            view.webContents.emit("before-input-event", {}, { ...input, key: "r" });
        }
        assert.deepEqual(state.shortcuts, [true, false, true, false]);
    }
});

test("main-frame navigation clears Forward to settings, but subframes and our own history steps do not", () => {
    const state = app();

    state.gui.showing = "config";
    state.navigate("back");
    state.gui.server.webContents.emit("did-navigate-in-page", {}, "https://pocket.example/frame", false);
    assert.equal(state.gui.navigation.forwardConfig?.kind, "user");
    state.navigate("back");
    assert.deepEqual(state.historyCalls, ["back"]);
    state.commit();
    assert.equal(state.gui.navigation.forwardConfig?.kind, "user");
    state.gui.server.webContents.emit("did-navigate", {}, "https://pocket.example/other");
    assert.equal(state.gui.navigation.forwardConfig, undefined);
});

test("same canReturn condition as the button: no return from first run or another server's side", () => {
    const state = app();

    state.gui.showing = "config";
    state.gui.viewing = "local";
    state.navigate("back");
    assert.equal(state.gui.showing, "config");
    state.gui.viewing = "remote";
    state.gui.loadedUrl = undefined;
    state.navigate("back");
    assert.equal(state.gui.showing, "config");
    assert.equal(state.gui.connectionAttempt, 2);
    assert.equal(state.gui.navigation.forwardConfig, undefined);
});
