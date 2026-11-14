import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { defaultSettings } from "../main/core/settings";
import * as rules from "../main/window/window-rules";
import type * as NewWindow from "../main/window/new-window";

function app() {
    const calls: string[] = [];
    class Window extends EventEmitter {
        destroyed = false;
        visible = true;
        title = "";
        bounds = { x: 10, y: 20, width: 600, height: 500 };
        contentView = { addChildView() {} };
        constructor(readonly options: Record<string, unknown> = {}) { super(); }
        getNormalBounds() { return this.bounds; }
        getContentBounds() { return this.bounds; }
        isDestroyed() { return this.destroyed; }
        isVisible() { return this.visible; }
        isMinimized() { return false; }
        show() { this.visible = true; calls.push("show"); }
        focus() {}
        setTitle(title: string) { this.title = title; }
        close() { this.destroyed = true; this.emit("closed"); }
    }
    class Contents extends EventEmitter {
        id = 9;
        destroyed = false;
        guarded = false;
        wired = false;
        isDestroyed() { return this.destroyed; }
        focus() {}
        close() { this.destroyed = true; }
        loadURL(url: string) {
            assert.equal(others[0]?.view.webContents, this, "registered before the preload's synchronous hello");
            assert.equal(this.guarded, true);
            assert.equal(this.wired, true);
            calls.push(url);

            return Promise.resolve();
        }
    }
    class View {
        webContents = new Contents();
        bounds: unknown;
        setBounds(bounds: unknown) { this.bounds = bounds; }
    }
    const main = new Window();
    const gui = {
        window: main,
        loadedUrl: "https://pocket.test" as string | undefined,
        unverified: false,
        settings: defaultSettings(),
        theme: { colors: { bg: "#123456" } },
        titleBarAtStart: "seamless",
        translucentAtStart: false,
        quitting: false,
        titleBar: { addWindow: () => () => 32 },
        desktop: { reset: () => calls.push("reset"), windowsChanged: () => calls.push("badge"), visibilityChanged() {} },
    };
    const others: { window: Window; view: View; failed: boolean; automaticClose?: boolean }[] = [];
    const exports = {} as typeof NewWindow;

    runInNewContext(readFileSync(join(__dirname, "..", "main", "window", "new-window.js"), "utf8"), {
        exports,
        process: { platform: "linux", getSystemVersion: () => "6" },
        require: (name: string) => {
            switch (name) {
                case "node:path": return { join };
                case "electron": return { BaseWindow: Window, WebContentsView: View, session: { fromPartition: () => ({}) }, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) } };
                case "../app/state": return { state: { gui }, SERVER_PARTITION: "persist:server" };
                case "../app/menu": return { quit: () => calls.push("quit"), openSettings() {} };
                case "../connection/address": return { currentOrigin: () => "https://pocket.test", originOf: (url: string) => new URL(url).origin };
                case "../connection/connect": return { openServerWindow() {}, wireServerKeys: (contents: Contents) => { contents.wired = true; } };
                case "../core/security": return { guardContents: (contents: Contents) => { contents.guarded = true; } };
                case "../core/paths": return { ASSETS: "/assets" };
                case "./appearance": return { windowOptions: (_platform: string, options: { translucent: boolean }) => ({ transparent: options.translucent }), setUpAppearance: () => ({ apply() {}, pageLoaded() {} }) };
                case "./other-windows": return {
                    addOtherWindow: (other: typeof others[number]) => others.push(other),
                    otherWindows: () => others,
                    removeOtherWindow: (window: Window) => others.splice(others.findIndex((other) => other.window === window), 1),
                    lastUsedWindow: () => main,
                    windowFocused() {},
                };
                case "./page-menu": return { contextMenuEventAt: new Map(), openContextMenu() {} };
                case "./server-preferences": return { serverPreferences: () => ({}) };
                case "./system-menu": return {};
                case "./titlebar": return { titleBarOptions: () => ({}) };
                case "./window-rules": return rules;
                case "./navigation": return { setUpOtherNavigation() {} };
                case "./views": return { showWindow: () => calls.push("main") };
                default: throw new Error(`Unexpected import: ${name}`);
            }
        },
    });

    return { gui, calls, others, newWindow: exports.newWindow };
}

test("New Window only shows the main window without a loaded, verified server", () => {
    const h = app();

    h.gui.loadedUrl = undefined;
    h.newWindow();
    h.gui.loadedUrl = "https://pocket.test";
    h.gui.unverified = true;
    h.newWindow();
    assert.deepEqual(h.calls, ["main", "main"]);
    assert.equal(h.others.length, 0);
});

test("a registered, guarded, wired server view loads home before its window shows", () => {
    const h = app();

    h.gui.settings.appearance.translucent = true; // Pending restart: the main window was opaque.
    h.newWindow();
    assert.deepEqual(h.calls, ["badge", "https://pocket.test/", "show"]);
    const other = h.others[0]!;

    assert.equal(other.window.options.transparent, false);
    assert.equal(other.window.options.minWidth, 360);
    assert.equal(other.window.options.minHeight, 480);
    assert.deepEqual(JSON.parse(JSON.stringify(other.view.bounds)), { x: 0, y: 32, width: 600, height: 468 });
    other.view.webContents.emit("page-title-updated", {}, "The second session");
    assert.equal(other.window.title, "The second session");
    other.window.close();
    assert.equal(h.others.length, 0);
    assert.equal(other.view.webContents.destroyed, true);
    assert.equal(h.calls.includes("quit"), false);
});

test("a finished network-error document does not clear failure; a successful new main-frame load does", () => {
    const h = app();

    h.newWindow();
    const other = h.others[0]!;
    const contents = other.view.webContents;
    const start = () => contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    const fail = (code: number, main = true) => contents.emit("did-fail-load", {}, code, "failed", "https://pocket.test/", main);

    start();
    fail(-3);
    fail(-102, false);
    assert.equal(other.failed, false);
    fail(-102);
    assert.equal(other.failed, true);
    contents.emit("did-finish-load"); // Chromium's error document finishes too.
    assert.equal(other.failed, true);
    start();
    assert.equal(other.failed, true);
    contents.emit("did-finish-load");
    assert.equal(other.failed, false);
    contents.emit("render-process-gone");
    assert.equal(other.failed, true);
    start();
    contents.emit("did-finish-load");
    assert.equal(other.failed, false);
});

test("only a user close can quit after the hidden main window; server cleanup never does", () => {
    for (const automatic of [false, true]) {
        const h = app();

        h.gui.settings.window.closeToTray = false;
        h.newWindow();
        h.gui.window.visible = false;
        h.others[0]!.automaticClose = automatic;
        h.others[0]!.window.close();
        assert.equal(h.others.length, 0);
        assert.equal(h.calls.includes("quit"), !automatic);
    }
});
