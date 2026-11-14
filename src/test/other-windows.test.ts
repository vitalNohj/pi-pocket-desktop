import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { BaseWindow } from "electron";
import type { OtherWindow } from "../main/window/other-windows";

type Registry = typeof import("../main/window/other-windows");

function registry() {
    const exports = {} as Registry;
    const closed: { id: number; automatic: boolean | undefined }[] = [];
    class Window {
        constructor(readonly id: number) {}
        isDestroyed() { return false; }
        close() {
            const window = this as unknown as BaseWindow;

            closed.push({ id: this.id, automatic: exports.otherWindow(window)?.automaticClose });
            exports.removeOtherWindow(window);
        }
    }
    class Contents {
        url = "https://pocket.test/s/1";
        reloads = 0;
        constructor(readonly id: number) {}
        isDestroyed() { return false; }
        getURL() { return this.url; }
        reload() { this.reloads++; }
        loadURL(url: string) { this.url = url; this.reloads++; return Promise.resolve(); }
    }
    const main = { window: new Window(1), server: { webContents: new Contents(1) }, loadedUrl: "https://pocket.test/base" };

    runInNewContext(readFileSync(join(__dirname, "..", "main", "window", "other-windows.js"), "utf8"), {
        exports,
        require: (name: string) => {
            if (name === "../app/state") return { state: { gui: main } };
            assert.equal(name, "../connection/address");

            return { currentOrigin: () => "https://pocket.test" };
        },
    });
    const add = (id: number, origin = "https://pocket.test") => {
        const window = new Window(id), contents = new Contents(id);
        const other = { window, view: { webContents: contents }, origin, failed: false, offset: () => 0, appearance: {} } as unknown as OtherWindow;

        exports.addOtherWindow(other);

        return { other, window, contents };
    };

    return { api: exports, main, add, closed };
}

test("registry pages are main first, exclude pop-outs, and remember focus only while the other window is open", () => {
    const h = registry();
    const one = h.add(2), two = h.add(3);
    const mainWindow = h.main.window as unknown as BaseWindow;

    assert.deepEqual(Array.from(h.api.serverPages(), (page) => page.contents.id), [1, 2, 3]);
    assert.equal(h.api.isServerPage(one.other.view.webContents), true);
    assert.equal(h.api.isServerPage({} as never), false);
    assert.equal(h.api.serverPageWindow(one.other.view.webContents), one.other.window);
    h.api.windowFocused(one.other.window);
    assert.equal(h.api.lastUsedWindow(), one.other.window);
    h.api.windowFocused(mainWindow);
    assert.equal(h.api.lastUsedWindow(), mainWindow);
    h.api.windowFocused(two.other.window);
    two.window.close();
    assert.equal(h.api.lastUsedWindow(), mainWindow);
});

test("server cleanup marks an automatic close before the closed handler can apply the user-close rule", () => {
    const h = registry();
    const keep = h.add(2);

    h.add(3, "https://old.test");
    h.api.closeOtherWindows("https://pocket.test");
    assert.deepEqual(h.closed, [{ id: 3, automatic: true }]);
    assert.equal(h.api.otherWindows().length, 1);
    assert.equal(keep.other.automaticClose, undefined);
    h.api.closeOtherWindows();
    assert.deepEqual(h.closed, [{ id: 3, automatic: true }, { id: 2, automatic: true }]);
    assert.equal(h.api.otherWindows().length, 0);
});

test("server return reloads only failed pages on that origin, including an empty page after a crash", () => {
    const h = registry();
    const healthy = h.add(2), failed = h.add(3), blank = h.add(4), foreign = h.add(5, "https://old.test");

    failed.other.failed = true;
    blank.other.failed = true;
    blank.contents.url = "";
    foreign.other.failed = true;
    h.api.reloadFailedOtherWindows();
    assert.equal(healthy.contents.reloads, 0);
    assert.equal(failed.contents.reloads, 1);
    assert.equal(blank.contents.reloads, 1);
    assert.equal(blank.contents.url, "https://pocket.test/base/");
    assert.equal(foreign.contents.reloads, 0);
    h.api.reloadFailedOtherWindows();
    assert.equal(failed.contents.reloads, 1);
});
