import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { BaseWindow, MenuItemConstructorOptions, WebContents } from "electron";
import type { HostEvent } from "../shared/types";
import type { DesktopHost, setUpDesktop } from "../main/bridge/desktop";
import { defaultSettings } from "../main/core/settings";
import { DEFAULT_THEME } from "../main/window/theme";

function bridge(platform = "linux") {
    class Window {
        visible = true;
        minimized = false;
        focused = false;
        overlays: unknown[] = [];
        isVisible() { return this.visible; }
        isMinimized() { return this.minimized; }
        isFocused() { return this.focused; }
        restore() { this.minimized = false; }
        show() { this.visible = true; }
        focus() { this.focused = true; }
        setOverlayIcon(icon: unknown) { this.overlays.push(icon); }
    }
    class Contents {
        dead = false;
        events: HostEvent[] = [];
        mainFrame: { parent: object | null; url: string } = { parent: null, url: "https://pocket.test/" };
        constructor(readonly id: number) {}
        isDestroyed() { return this.dead; }
        send(_channel: string, event: HostEvent) { this.events.push(JSON.parse(JSON.stringify(event)) as HostEvent); }
        focus() {}
        reload() { calls.push(`reload ${this.id}`); }
    }
    const main = { window: new Window(), contents: new Contents(1), origin: "https://pocket.test" };
    const other = { window: new Window(), contents: new Contents(2), origin: "https://pocket.test" };
    const popout = { window: new Window(), contents: new Contents(3), origin: "https://pocket.test" };
    const pages = [main, other];
    let last = other.window;
    let showingServer = true;
    let template: MenuItemConstructorOptions[] = [];
    const calls: string[] = [];
    const badgeCounts: number[] = [];
    const notifications: Notification[] = [];
    class Notification extends EventEmitter {
        static isSupported() { return true; }
        shown = false;
        constructor(readonly options: Record<string, unknown>) { super(); notifications.push(this); }
        show() { this.shown = true; }
        close() { this.emit("close", { reason: "closed" }); }
    }
    const image = { getSize: () => ({ width: 1, height: 1 }), toBitmap: () => Buffer.from([255, 255, 255, 255]) };
    const ipc = new EventEmitter();
    const host: DesktopHost = {
        assets: "/assets",
        window: () => main.window as unknown as BaseWindow,
        contents: () => main.contents as unknown as WebContents,
        pages: () => pages as unknown as ReturnType<DesktopHost["pages"]>,
        lastUsedWindow: () => last as unknown as BaseWindow,
        newWindow: () => calls.push("new window"),
        origin: () => "https://pocket.test",
        settings: defaultSettings,
        showingServer: () => showingServer,
        serverLoaded: () => true,
        showServer: () => { showingServer = true; return true; },
        tray: () => Object.assign(new EventEmitter(), {
            isDestroyed: () => false, setContextMenu() {}, setImage() {}, setToolTip() {},
        }) as unknown as ReturnType<DesktopHost["tray"]>,
        showWindow: () => { main.window.show(); calls.push("show main"); },
        toggleWindow() {}, openSettings: () => calls.push("settings"), reloadServer: () => calls.push("reload main"),
        reloadItem: () => undefined, quit() {}, updateItem: () => undefined,
        theme: () => DEFAULT_THEME, themeChanged: () => calls.push("theme"), dictation: () => true,
        dictationKey: () => "F6", pageRightClick: (contents) => calls.push(`context ${contents.id}`),
        dictateItem: () => undefined, copyDictationItem: () => undefined,
    };
    const exports = {} as { setUpDesktop: typeof setUpDesktop };

    runInNewContext(readFileSync(join(__dirname, "..", "main", "bridge", "desktop.js"), "utf8"), {
        exports, URL, Buffer, console, setTimeout, clearTimeout, process: { platform },
        require: (name: string) => {
            if (name === "node:path") return { join };
            if (name === "electron") return {
                app: { setBadgeCount: (count: number) => badgeCounts.push(count) }, ipcMain: ipc,
                Menu: { buildFromTemplate: (next: MenuItemConstructorOptions[]) => { template = next; return next; } },
                Notification, powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleState: () => "active" }),
                nativeImage: { createFromPath: () => image, createFromBitmap: () => image },
            };
            if (name === "../tray/tray-popup") return { setUpTrayPopup: () => ({ refresh() {} }) };
            if (name === "../diagnostics/stall-watchdog") return { activity() {}, diagnose() {} };

            return require(join(__dirname, "..", "main", "bridge", name));
        },
    });
    const desktop = exports.setUpDesktop(host);
    const emit = (channel: string, page = main, input?: unknown) => {
        const event = { sender: page.contents, senderFrame: page.contents.mainFrame, returnValue: undefined as unknown };

        ipc.emit(channel, event, input);

        return event;
    };

    return {
        desktop, emit, main, other, popout, pages, calls, badgeCounts, notifications,
        settingsScreen: () => { showingServer = false; }, lastMain: () => { last = main.window; },
        template: () => template,
    };
}

test("the bridge trusts every server page's top frame, but no pop-out, child, or foreign page", () => {
    const h = bridge();

    assert.equal(h.desktop.fromServerPage(h.emit("unused", h.main) as never), true);
    assert.equal(h.desktop.fromServerPage(h.emit("unused", h.other) as never), true);
    assert.equal(h.emit("host:hello", h.other).returnValue !== null, true);
    assert.equal(h.emit("host:hello", h.popout).returnValue, null);
    h.other.contents.mainFrame.parent = {};
    assert.equal(h.emit("host:hello", h.other).returnValue, null);
    h.other.contents.mainFrame.parent = null;
    h.other.contents.mainFrame.url = "https://sign-in.test/";
    assert.equal(h.emit("host:hello", h.other).returnValue, null);
});

test("visibility belongs to each page, including the main window's settings view", () => {
    const h = bridge();

    h.desktop.visibilityChanged();
    assert.deepEqual(h.main.contents.events, [{ type: "visibility", visible: true }]);
    assert.deepEqual(h.other.contents.events, [{ type: "visibility", visible: true }]);
    h.settingsScreen();
    h.desktop.visibilityChanged();
    assert.deepEqual(h.main.contents.events.at(-1), { type: "visibility", visible: false });
    assert.equal(h.other.contents.events.length, 1);
    h.other.window.minimized = true;
    h.desktop.visibilityChanged();
    assert.deepEqual(h.other.contents.events.at(-1), { type: "visibility", visible: false });
    h.desktop.visibilityChanged();
    assert.equal(h.other.contents.events.length, 2, "unchanged visibility sends no event");
});

test("New Session uses the last other page only after that document names the event", () => {
    const h = bridge();

    h.emit("host:events", h.main, ["newSession"]);
    h.emit("host:events", h.other, ["newSession"]);
    h.other.window.visible = false;
    h.other.window.minimized = true;
    h.desktop.newSession();
    assert.equal(h.other.window.visible, true);
    assert.equal(h.other.window.minimized, false);
    assert.deepEqual(h.other.contents.events, [{ type: "newSession" }]);
    assert.deepEqual(h.main.contents.events, []);
    h.desktop.reset(h.other.contents as unknown as WebContents);
    h.desktop.newSession();
    assert.deepEqual(h.main.contents.events, [{ type: "newSession" }]);
    assert.deepEqual(h.calls, ["show main"]);
});

test("reset keeps pins and badge until the last subscribed document leaves", () => {
    const h = bridge();

    h.emit("host:events", h.main, ["open"]);
    h.emit("host:events", h.other, ["open"]);
    h.emit("host:badge", h.other, 4);
    h.emit("host:pinned", h.other, [{ id: 1, title: "Pinned session", label: "", state: "seen", url: "/s/1" }]);
    h.desktop.reset(h.main.contents as unknown as WebContents);
    assert.deepEqual(h.badgeCounts, [4]);
    assert.ok(h.template().some((item) => item.label?.includes("Pinned session")));
    h.desktop.reset(h.other.contents as unknown as WebContents);
    assert.deepEqual(h.badgeCounts, [4, 0]);
    assert.equal(h.template().some((item) => item.label?.includes("Pinned session")), false);
    assert.deepEqual(Array.from(h.template().slice(0, 3), (item) => item.label), ["Open Pi Pocket", "New session", "New window"]);
    (h.template()[2]!.click as () => void)();
    assert.deepEqual(h.calls, ["new window"]);
});

test("notifications show once across pages, answer the source page, and fall back when it closes", () => {
    const h = bridge();
    const message = { tag: "approval", title: "Allow?", body: "A tool needs you", url: "/s/1", approval: { id: "request", call: "echo test", may: true } };

    h.emit("host:notify", h.other, message);
    h.emit("host:notify", h.main, message);
    assert.equal(h.notifications.length, 1);
    h.notifications[0]!.emit("action", { actionIndex: 0 });
    assert.equal(h.other.contents.events.at(-1)?.type, "approve");
    assert.equal(h.main.contents.events.length, 0);
    h.emit("host:notify", h.other, message); // Same page can repeat.
    h.pages.pop();
    h.other.contents.dead = true;
    h.notifications[1]!.emit("action", { actionIndex: 0 });
    assert.equal(h.main.contents.events.at(-1)?.type, "approve");
});

test("notification and pin clicks open in the last other window, then fall back to the main window", () => {
    const h = bridge();

    h.emit("host:notify", h.main, { tag: "one", title: "Notice", url: "/s/4" });
    h.other.window.visible = false;
    h.notifications[0]!.emit("click");
    assert.equal(h.other.window.visible, true);
    assert.deepEqual(h.other.contents.events.at(-1), { type: "open", url: "/s/4" });
    h.emit("host:pinned", h.main, [{ id: 1, title: "Pinned", url: "/s/5" }]);
    const pin = h.template().find((item) => item.label === "○  Pinned")!;

    (pin.click as () => void)();
    assert.deepEqual(h.other.contents.events.at(-1), { type: "open", url: "/s/5" });
    h.lastMain();
    (pin.click as () => void)();
    assert.deepEqual(h.main.contents.events.at(-1), { type: "open", url: "/s/5" });
});

test("page reload and context menu use their own contents; Windows overlays reach every registered window", () => {
    const h = bridge("win32");

    h.emit("host:reload", h.other);
    h.emit("host:reload", h.main);
    h.emit("host:reload", h.popout);
    h.emit("host:context-menu", h.other, {});
    assert.deepEqual(h.calls, ["reload 2", "reload main", "context 2"]);
    h.emit("host:badge", h.other, 3);
    assert.equal(h.main.window.overlays.length, 1);
    assert.equal(h.other.window.overlays.length, 1);
    assert.equal(h.popout.window.overlays.length, 0);
    h.desktop.windowsChanged();
    assert.equal(h.other.window.overlays.length, 2);
});
