import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { DownloadItem, Event, WebContents } from "electron";
import * as inputRules from "../main/bridge/save-file-input";

type Downloads = typeof import("../main/bridge/save-file");
const origin = "https://pocket.test";
const url = origin + "/api/c/1/download?path=notes.txt";

/** The real main-process module, with only Electron and disk I/O replaced. */
function host() {
    const downloads = {} as Downloads;
    const files = new Set<string>();
    const shown: string[] = [];
    const notices: string[] = [];
    const contents = Object.assign(new EventEmitter(), { id: 7 });
    let revealError = false;

    runInNewContext(readFileSync(join(__dirname, "..", "main", "bridge", "save-file.js"), "utf8"), {
        exports: downloads,
        URL,
        setImmediate,
        require: (name: string) => {
            if (name === "electron") {
                return {
                    app: { getPath: (folder: string) => { assert.equal(folder, "downloads"); return join("tmp", "Downloads"); } },
                    shell: { showItemInFolder: (path: string) => { if (revealError) throw new Error("no file manager"); shown.push(path); } },
                };
            }
            if (name === "node:fs") {
                return { existsSync: (path: string) => files.has(path), rmSync: (path: string) => files.delete(path) };
            }
            if (name === "node:path") {
                return { basename };
            }
            assert.equal(name, "./save-file-input");

            return inputRules;
        },
    });

    const item = (firstUrl = url, filename = "notes.txt", chain = [firstUrl]) => {
        const download = Object.assign(new EventEmitter(), {
            path: "",
            cancelled: false,
            getURLChain: () => chain,
            getFilename: () => filename,
            setSavePath: (path: string) => { download.path = path; files.add(path); },
            cancel: () => { download.cancelled = true; download.emit("done", {}, "cancelled"); },
        });

        return download;
    };
    const notify = (message: string) => notices.push(message);
    const start = (download: ReturnType<typeof item>, trusted = true, event: { preventDefault: () => void } = { preventDefault: () => assert.fail("the item should be accepted") }) => downloads.saveDownload(
        event as unknown as Event,
        download as unknown as DownloadItem,
        contents as unknown as WebContents,
        origin,
        trusted,
        notify,
    );
    const request = (id: number, firstUrl = url, trusted = true, contentsId: number | undefined = contents.id) => downloads.saveRequestStarted(id, firstUrl, contentsId, origin, trusted);
    const response = (id: number, status: number, redirect = false) => downloads.saveResponse(id, status, notify, redirect);

    return { downloads, files, shown, notices, contents, item, start, request, response, revealFails: () => { revealError = true; } };
}

test("ordinary completed downloads use Downloads, reveal the file, and notify with the collision suffix", () => {
    const h = host();

    for (const expected of ["notes.txt", "notes (1).txt", "notes (2).txt"]) {
        const item = h.item();

        assert.equal(h.start(item), true);
        assert.equal(item.path, join("tmp", "Downloads", expected));
        item.emit("done", {}, "completed");
        assert.equal(h.shown.at(-1), item.path);
        assert.equal(h.notices.at(-1), `Saved ${expected} to Downloads`);
        assert.equal(h.contents.listenerCount("destroyed"), 0);
    }
});

test("unrelated downloads, foreign first URLs, missing chains, and other contents keep their dialog", () => {
    const h = host();

    for (const item of [h.item("https://elsewhere.test/file"), h.item(origin + "/api/c/1/files?path=a"), h.item("https://elsewhere.test/redirect", "notes.txt", ["https://elsewhere.test/redirect", url]), h.item(url, "notes.txt", [])]) {
        assert.equal(h.start(item), false);
        assert.equal(item.path, "");
    }

    const item = h.item();

    assert.equal(h.start(item, false), false);
    assert.equal(item.path, "");
    assert.deepEqual(h.notices, []);
});

test("simultaneous downloads of the same URL reserve different names before any bytes reach disk", () => {
    const h = host();
    const first = h.item(), second = h.item(), third = h.item();

    // No file on disk yet: the in-progress path alone must reserve the name.
    for (const item of [first, second, third]) {
        item.setSavePath = (path: string) => { item.path = path; };
        h.start(item);
    }

    assert.equal(first.path, join("tmp", "Downloads", "notes.txt"));
    assert.equal(second.path, join("tmp", "Downloads", "notes (1).txt"));
    assert.equal(third.path, join("tmp", "Downloads", "notes (2).txt"));
    for (const item of [first, second, third]) item.emit("done", {}, "cancelled");
});

test("the response filename is cleaned and an empty filename falls back to the path", () => {
    const h = host();
    const unsafe = h.item(url, "../x");
    const fallback = h.item(origin + "/api/c/1/download?path=%2Ftmp%2F.secret", "");

    h.start(unsafe);
    h.start(fallback);
    assert.equal(basename(unsafe.path), "_._x");
    assert.equal(basename(fallback.path), "_secret");
    unsafe.emit("done", {}, "completed");
    fallback.emit("done", {}, "completed");
});

test("HTTP errors, including a folder's 404, stop before Electron can create a file", () => {
    for (const status of [100, 304, 400, 401, 403, 404, 500, 503]) {
        const h = host();

        h.request(1);
        assert.equal(h.response(1, status), true);
        assert.equal(h.response(1, status), true);
        assert.equal(h.notices.length, 1, "a failed request reports only once");
        assert.match(h.notices[0]!, new RegExp(String(status)));
        assert.equal(h.files.size, 0);
        assert.deepEqual(h.shown, []);
        h.downloads.saveRequestEnded(1);
        assert.equal(h.response(1, status), false);
    }
});

test("2xx responses and intermediate redirects continue, but the redirected HTTP error is stopped", () => {
    const h = host();

    for (const status of [200, 201, 206, 299]) {
        h.request(status);
        assert.equal(h.response(status, status), false);
        h.downloads.saveRequestEnded(status);
    }

    h.request(1);
    assert.equal(h.response(1, 302, true), false);
    h.request(1, "https://elsewhere.test/response", false);
    assert.equal(h.response(1, 500), true, "the first URL's decision survives a redirect");
    assert.match(h.notices[0]!, /notes.txt:.*500/);
    h.downloads.saveRequestEnded(1);
});

test("an untrusted first URL or contents cannot become an automatic save by redirecting", () => {
    const h = host();

    for (const [id, firstUrl, trusted, contentsId] of [[1, "https://elsewhere.test/redirect", true, 7], [2, url, false, 8], [3, url, false, 7], [4, url, true, undefined]] as const) {
        h.downloads.saveRequestStarted(id, firstUrl, contentsId, origin, trusted);
        h.request(id);
        assert.equal(h.response(id, 404), false);
        h.downloads.saveRequestEnded(id);
    }
    assert.deepEqual(h.notices, []);
});

test("concurrent requests for the same URL have separate HTTP outcomes and ended requests cannot claim later ones", () => {
    const h = host();

    h.request(1);
    h.request(2, url, false, 8);
    h.request(3);
    assert.equal(h.response(2, 404), false);
    assert.equal(h.response(1, 404), true);
    h.downloads.saveRequestEnded(1);
    assert.equal(h.response(3, 200), false);
    assert.equal(h.response(1, 500), false);
    assert.equal(h.notices.length, 1);
});

test("cancelled and interrupted downloads report once, remove the partial file, and release the name", () => {
    for (const state of ["cancelled", "interrupted"]) {
        const h = host();
        const item = h.item();

        h.start(item);
        item.emit(state === "interrupted" ? "updated" : "done", {}, state);
        item.emit("done", {}, "interrupted");
        assert.equal(h.files.size, 0);
        assert.deepEqual(h.shown, []);
        assert.equal(h.notices.length, 1);
        assert.match(h.notices[0]!, /Could not save notes.txt:/);
        assert.equal(h.contents.listenerCount("destroyed"), 0);
        const next = h.item();

        h.start(next);
        assert.equal(next.path, item.path);
        next.emit("done", {}, "completed");
    }
});

test("an interrupted update cancels after Chromium finishes its observer notification", async () => {
    const h = host();
    const item = h.item();
    let updating = false;
    const cancel = item.cancel;

    item.cancel = () => { assert.equal(updating, false, "cancellation must not re-enter the update observer list"); cancel(); };
    h.start(item);
    updating = true;
    item.emit("updated", {}, "interrupted");
    updating = false;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(item.cancelled, true);
    assert.equal(h.files.size, 0);
    assert.equal(h.notices.length, 1);
});

test("a closed server page cancels its active download and removes the partial file", () => {
    const h = host();
    const item = h.item();

    h.start(item);
    h.contents.emit("destroyed");
    assert.equal(item.cancelled, true);
    assert.equal(h.files.size, 0);
    assert.deepEqual(h.shown, []);
    assert.match(h.notices[0]!, /server page closed/);
});

test("a save-path error prevents the download without calling a destroyed item", () => {
    const h = host();
    const item = h.item();
    let prevented = false;

    item.setSavePath = () => { throw new Error("no Downloads folder"); };
    item.cancel = () => assert.fail("preventDefault already destroys the item");
    assert.equal(h.start(item, true, { preventDefault: () => { prevented = true; } }), true);
    assert.equal(prevented, true);
    assert.match(h.notices[0]!, /no Downloads folder/);
    assert.equal(h.files.size, 0);
    assert.equal(h.contents.listenerCount("destroyed"), 0);
});

test("a file-manager error does not remove the completed file", () => {
    const h = host();
    const item = h.item();

    h.start(item);
    h.revealFails();
    item.emit("done", {}, "completed");
    item.emit("updated", {}, "interrupted");
    assert.equal(h.files.has(item.path), true);
    assert.match(h.notices[0]!, /Could not show the saved file/);
    assert.equal(h.notices.length, 1);
});
