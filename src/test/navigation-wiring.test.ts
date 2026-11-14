import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as rules from "../main/window/navigation-state";
import * as windowRules from "../main/window/window-rules";
import type { ConfigReason } from "../shared/types";
import type * as Navigation from "../main/window/navigation";
import type { MenuItemConstructorOptions } from "electron";
import type * as AppMenu from "../main/app/menu";

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
    let otherIndex = 2;
    const otherCalls: string[] = [];
    const other = { window: new EventEmitter(), origin: "https://pocket.example", view: { webContents: contents() } };
    other.view.webContents.navigationHistory = {
        ...history,
        getActiveIndex: () => otherIndex,
        canGoBack: () => otherIndex > 0,
        canGoForward: () => otherIndex < entries.length - 1,
        goBack: () => { otherCalls.push("back"); otherIndex--; },
        goForward: () => { otherCalls.push("forward"); otherIndex++; },
    };
    const ipcMain = new EventEmitter();
    const electronApp = new EventEmitter();
    const exports = {} as typeof Navigation;
    const openSettings: ConfigReason[] = [];

    runInNewContext(readFileSync(join(__dirname, "..", "main", "window", "navigation.js"), "utf8"), {
        exports,
        process: { platform },
        require: (name: string) => {
            switch (name) {
                case "electron": return { app: electronApp, ipcMain };
                case "../app/state": return { state: { gui } };
                case "./navigation-state": return rules;
                case "./other-windows": return {
                    otherWindow: (window: unknown) => window === other.window ? other : undefined,
                    serverPage: (contents: unknown) => contents === other.view.webContents ? { window: other.window, contents, origin: other.origin } : undefined,
                };
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
    exports.setUpOtherNavigation(other.window as unknown as import("electron").BaseWindow);

    return { gui, other, otherCalls, ipcMain, electronApp, historyCalls, shortcuts, openSettings, navigate: exports.navigate, commit: () => gui.server.webContents.emit("did-navigate-in-page", {}, entries[index], true) };
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

test("pop-out navigation keys are delivered to their page, not the primary view's menu shortcut", () => {
    const state = app("darwin");
    const ignored: boolean[] = [];
    const popout = Object.assign(new EventEmitter(), { setIgnoreMenuShortcuts: (ignore: boolean) => ignored.push(ignore) });
    const event = { prevented: false, preventDefault() { this.prevented = true; } };

    state.electronApp.emit("web-contents-created", {}, popout);
    popout.emit("before-input-event", event, { key: "[", meta: true, alt: false, control: false, shift: false });
    popout.emit("before-input-event", event, { key: "r", meta: true, alt: false, control: false, shift: false });
    assert.deepEqual(ignored, [true, false]);
    assert.equal(event.prevented, false);
    assert.equal(state.historyCalls.length, 0);
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

test("the View menu shows the platform keys, and its actions never move the primary view from a pop-out", () => {
    for (const platform of ["linux", "win32", "darwin"]) {
        const gui = { window: {}, pageHang: { hung: false } };
        const other = {};
        const calls: string[] = [];
        const exports = {} as typeof AppMenu;
        let menu: MenuItemConstructorOptions[] = [];

        runInNewContext(readFileSync(join(__dirname, "..", "main", "app", "menu.js"), "utf8"), {
            exports, process: { platform },
            require: (name: string) => {
                switch (name) {
                    case "electron": return { Menu: { buildFromTemplate: (items: MenuItemConstructorOptions[]) => items, setApplicationMenu: (items: MenuItemConstructorOptions[]) => { menu = items; } } };
                    case "./state": return { state: { gui } };
                    case "../window/navigation": return {
                        navigate: (direction: string) => calls.push(direction),
                        navigateOtherWindow: (direction: string, window: unknown) => { if (window === other) calls.push(`other-${direction}`); },
                    };
                    case "../window/window-rules": return windowRules;
                    case "../bridge/new-session": return { newSessionMenuItem: () => ({ label: "New Session" }) };
                    case "./links": return { LINKS: {} };
                    default: return {};
                }
            },
        });
        exports.buildMenu();
        const items = menu.find((item) => item.label === "View")!.submenu as MenuItemConstructorOptions[];
        const back = items.find((item) => item.label === "Back")!;
        const forward = items.find((item) => item.label === "Forward")!;

        assert.equal(back.accelerator, platform === "darwin" ? "Command+[" : "Alt+Left");
        assert.equal(forward.accelerator, platform === "darwin" ? "Command+]" : "Alt+Right");
        assert.equal(back.registerAccelerator, false);
        const click = (item: MenuItemConstructorOptions, window: object) => (item.click as (item: object, window: object) => void)(item, window);

        click(back, {});
        click(forward, {});
        assert.deepEqual(calls, []);
        click(back, gui.window);
        click(forward, gui.window);
        assert.deepEqual(calls, ["back", "forward"]);
        click(back, other);
        click(forward, other);
        assert.deepEqual(calls, ["back", "forward", "other-back", "other-forward"]);
    }
});

test("Reload and Developer tools act on the window in front: an other window's page, a pop-out's own, else the main window", () => {
    const calls: string[] = [];
    const page = (name: string) => ({ isDestroyed: () => false, reload: () => calls.push(`${name}-reload`), toggleDevTools: () => calls.push(`${name}-tools`) });
    const gui = { window: {}, pageHang: { hung: false }, showing: "server", server: { webContents: page("server") }, config: { webContents: page("config") } };
    const other = { view: { webContents: page("other") } };
    const otherFront = {};
    const popOut = { webContents: page("pop-out") };
    // The tray's menu or the dictation pill: a window of the app that is neither.
    const small = { webContents: page("small") };
    const exports = {} as typeof AppMenu;
    let menu: MenuItemConstructorOptions[] = [];

    runInNewContext(readFileSync(join(__dirname, "..", "main", "app", "menu.js"), "utf8"), {
        exports, process: { platform: "linux" },
        require: (name: string) => {
            switch (name) {
                case "electron": return { Menu: { buildFromTemplate: (items: MenuItemConstructorOptions[]) => items, setApplicationMenu: (items: MenuItemConstructorOptions[]) => { menu = items; } } };
                case "./state": return { state: { gui } };
                case "../window/navigation": return { navigate() {}, navigateOtherWindow() {} };
                case "../window/other-windows": return {
                    otherWindow: (window: unknown) => (window === otherFront ? other : undefined),
                    isPopOut: (window: unknown) => window === popOut,
                };
                case "../window/window-rules": return windowRules;
                case "../bridge/new-session": return { newSessionMenuItem: () => ({ label: "New Session" }) };
                case "../connection/health": return { reloadServer: () => calls.push("server-reload") };
                case "./links": return { LINKS: {} };
                default: return {};
            }
        },
    });
    exports.buildMenu();
    const items = menu.find((item) => item.label === "View")!.submenu as MenuItemConstructorOptions[];
    const reload = items.find((item) => item.label === "Reload")!;
    const tools = items.find((item) => item.label === "Developer tools")!;
    const click = (item: MenuItemConstructorOptions, window: object | undefined) => (item.click as (item: object, window: object | undefined) => void)(item, window);

    for (const front of [otherFront, popOut, gui.window, small, undefined]) {
        click(reload, front);
        click(tools, front);
    }

    assert.deepEqual(calls, [
        "other-reload", "other-tools",
        "pop-out-reload", "pop-out-tools",
        "server-reload", "server-tools",
        "server-reload", "server-tools",
        "server-reload", "server-tools",
    ]);

    calls.length = 0;
    gui.showing = "config";
    click(reload, gui.window);
    click(tools, gui.window);
    assert.deepEqual(calls, ["config-reload", "config-tools"]);
});

test("an other window navigates its own safe history, with top-frame and origin checks", () => {
    const state = app();
    const sender = state.other.view.webContents;
    const frame = { parent: null, url: "https://pocket.example/" };
    const send = (senderFrame: unknown = frame, direction = "back") => state.ipcMain.emit("window:navigate", { sender, senderFrame }, direction);

    send(null);
    send({ ...frame, parent: {} });
    send({ ...frame, url: "https://other.example/" });
    send(frame, "other");
    assert.deepEqual(state.otherCalls, []);
    state.gui.showing = "config";
    send();
    send(); // about:blank is never safe.
    assert.deepEqual(state.otherCalls, ["back"]);
    state.other.window.emit("app-command", {}, "browser-forward");
    assert.deepEqual(state.otherCalls, ["back", "forward"]);
    assert.deepEqual(state.historyCalls, []);
    assert.equal(state.gui.showing, "config");

    const mac = app("darwin");

    mac.other.window.emit("swipe", {}, "left");
    mac.other.window.emit("swipe", {}, "right");
    assert.deepEqual(mac.otherCalls, ["back", "forward"]);
    assert.deepEqual(mac.historyCalls, []);
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
