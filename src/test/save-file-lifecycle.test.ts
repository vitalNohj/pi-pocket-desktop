import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { DownloadItem, Event, WebContents } from "electron";
import * as inputRules from "../main/bridge/save-file-input";

type Bridge = typeof import("../main/bridge/save-file");
const origin = "https://pocket.test";
const input = { url: "/api/c/1/download?path=notes.txt", name: "notes.txt" };

/** The real main-process module, with only Electron, disk I/O, and its 30-second timer replaced. */
function host() {
    const bridge = {} as Bridge;
    const files = new Set<string>();
    const shown: string[] = [];
    const downloads: string[] = [];
    const timers = new Set<() => void>();
    const contents = Object.assign(new EventEmitter(), {
        id: 7,
        downloadURL: (url: string) => downloads.push(url),
    });

    runInNewContext(readFileSync(join(__dirname, "..", "main", "bridge", "save-file.js"), "utf8"), {
        exports: bridge,
        URL,
        require: (name: string) => {
            if (name === "electron") {
                return { app: { getPath: () => join("tmp", "Downloads") }, shell: { showItemInFolder: (path: string) => shown.push(path) } };
            }
            if (name === "node:fs") {
                return { existsSync: (path: string) => files.has(path), rmSync: (path: string) => files.delete(path) };
            }
            assert.equal(name, "./save-file-input");

            return inputRules;
        },
        setTimeout: (callback: () => void, ms: number) => {
            assert.ok(ms > 0 && ms <= 30_000);
            timers.add(callback);

            return callback;
        },
        clearTimeout: (callback: () => void) => timers.delete(callback),
    });

    const item = (url = origin + input.url) => {
        const download = Object.assign(new EventEmitter(), {
            path: "",
            cancelled: false,
            getURL: () => url,
            getURLChain: () => [url],
            setSavePath: (path: string) => {
                download.path = path;
                files.add(path);
            },
            cancel: () => {
                download.cancelled = true;
                download.emit("done", {}, "cancelled");
            },
        });

        return download;
    };
    const start = (download: ReturnType<typeof item>, sender = contents) => bridge.saveDownload(
        { preventDefault: () => assert.fail("the item should be accepted") } as unknown as Event,
        download as unknown as DownloadItem,
        sender as unknown as WebContents,
    );
    const save = (value = input) => bridge.saveFile(value, contents as unknown as WebContents, origin);

    return { bridge, files, shown, downloads, timers, contents, item, start, save };
}

test("a completed save uses Downloads, reveals the file, and the next save gets (1)", async () => {
    const h = host();

    for (const expected of ["notes.txt", "notes (1).txt"]) {
        const answer = h.save();
        const item = h.item();

        assert.equal(h.start(item), true);
        assert.equal(h.timers.size, 0, "a started download no longer has the start timeout");
        assert.equal(item.path, join("tmp", "Downloads", expected));
        item.emit("done", {}, "completed");
        const result = await answer;

        assert.equal(result.ok, true);
        assert.equal(result.ok && result.path, item.path);
        assert.equal(h.shown.at(-1), item.path);
    }
});

test("unrelated downloads retain their dialog and another view cannot claim a pending save", async () => {
    const h = host();
    const plain = h.item("https://elsewhere.test/file");

    assert.equal(h.start(plain), false);
    assert.equal(plain.path, "");
    const answer = h.save();
    const item = h.item();

    assert.equal(h.start(item, Object.assign(new EventEmitter(), { id: 8, downloadURL: () => 0 })), false);
    assert.equal(item.path, "");
    h.start(item);
    item.emit("done", {}, "completed");
    assert.equal((await answer).ok, true);
});

test("pending names do not collide, and repeated saves of one URL start in order", async () => {
    const h = host();
    const first = h.save();
    const second = h.save();
    const other = h.save({ ...input, url: "/api/c/1/download?path=other.txt" });

    assert.equal(h.downloads.length, 2);
    const one = h.item();
    const two = h.item(origin + "/api/c/1/download?path=other.txt");

    h.start(one);
    h.start(two);
    assert.notEqual(one.path, two.path);
    one.emit("done", {}, "completed");
    await first;
    await Promise.resolve();
    assert.equal(h.downloads.length, 3);
    const three = h.item();

    h.start(three);
    assert.notEqual(three.path, one.path);
    assert.notEqual(three.path, two.path);
    two.emit("done", {}, "completed");
    three.emit("done", {}, "completed");
    assert.equal((await second).ok, true);
    assert.equal((await other).ok, true);
});

test("HTTP errors, including a folder's 404, fail before a file can be saved", async () => {
    const h = host();
    const answer = h.save();

    h.bridge.saveRequestStarted(1, origin + input.url, h.contents.id);
    assert.equal(h.bridge.saveResponse(1, 404), true);
    h.bridge.saveRequestEnded(1, "net::ERR_BLOCKED_BY_CLIENT");
    const result = await answer;

    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /Could not save notes.txt:.*404/);
    assert.equal(h.files.size, 0);
    assert.deepEqual(h.shown, []);
    assert.equal(h.timers.size, 0);
});

test("cancelled and interrupted downloads report an error and remove the partial file", async () => {
    for (const state of ["cancelled", "interrupted"]) {
        const h = host();
        const answer = h.save();
        const item = h.item();

        h.start(item);
        item.emit(state === "interrupted" ? "updated" : "done", {}, state);
        const result = await answer;

        assert.equal(result.ok, false);
        assert.match(!result.ok ? result.error : "", /Could not save notes.txt:/);
        assert.equal(h.files.size, 0);
        assert.deepEqual(h.shown, []);
    }
});

test("a late response after 30 seconds cannot open a dialog or steal a new save of the URL", async () => {
    const h = host();
    const first = h.save();

    h.bridge.saveRequestStarted(1, origin + input.url, h.contents.id);
    [...h.timers].forEach((timeout) => timeout());
    const result = await first;

    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /30 seconds/);
    const second = h.save();

    h.bridge.saveRequestStarted(2, origin + input.url, h.contents.id);
    assert.equal(h.bridge.saveResponse(1, 200), true, "the expired request is cancelled");
    h.bridge.saveRequestEnded(1, "cancelled");
    assert.equal(h.bridge.saveResponse(2, 200), false, "the new request can continue");
    const item = h.item();

    h.start(item);
    item.emit("done", {}, "completed");
    assert.equal((await second).ok, true);
    h.bridge.saveRequestEnded(2);
});

test("a repeated save waiting for the same URL also has a 30-second start timeout", async () => {
    const h = host();
    const first = h.save();
    const item = h.item();

    h.start(item);
    const second = h.save();

    [...h.timers].forEach((timeout) => timeout());
    assert.equal((await second).ok, false);
    assert.equal(h.downloads.length, 1);
    item.emit("done", {}, "completed");
    assert.equal((await first).ok, true);
});

test("a network error or a closed server page ends a save before the start timeout", async () => {
    for (const close of [false, true]) {
        const h = host();
        const answer = h.save();

        h.bridge.saveRequestStarted(1, origin + input.url, h.contents.id);
        if (close) {
            h.contents.emit("destroyed");
        } else {
            h.bridge.saveRequestEnded(1, "net::ERR_CONNECTION_RESET");
        }
        assert.equal((await answer).ok, false);
        assert.equal(h.timers.size, 0);
        assert.equal(h.files.size, 0);
    }
});
