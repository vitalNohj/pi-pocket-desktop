import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type * as Preload from "../preload/server";

/** The preload's own exports, without Electron: with no bridge for this frame, it only defines them. */
function loadPreload(): typeof Preload {
    const exports = {} as typeof Preload;

    runInNewContext(readFileSync(join(__dirname, "..", "preload", "server.js"), "utf8"), {
        exports,
        URL,
        require: () => ({ contextBridge: {}, ipcRenderer: { sendSync: () => null } }),
    });

    return exports;
}

const { sessionLinkHere } = loadPreload();

const BASE = "http://127.0.0.1:8787/s/4";
const PLAIN = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

test("a plain click on a link to one of the server's sessions opens it here", () => {
    assert.equal(sessionLinkHere(PLAIN, "/s/12", BASE), "/s/12");
    assert.equal(sessionLinkHere(PLAIN, "/s/12/", BASE), "/s/12");
    assert.equal(sessionLinkHere(PLAIN, "http://127.0.0.1:8787/s/12", BASE), "/s/12");
});

test("\u2318, Ctrl, Shift, Alt, or another button leaves it to open a new window", () => {
    for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
        assert.equal(sessionLinkHere({ ...PLAIN, [key]: true }, "/s/12", BASE), null, key);
    }

    assert.equal(sessionLinkHere({ ...PLAIN, button: 1 }, "/s/12", BASE), null);
});

test("other links open as they did", () => {
    assert.equal(sessionLinkHere(PLAIN, null, BASE), null);
    assert.equal(sessionLinkHere(PLAIN, "https://example.com/s/12", BASE), null);
    assert.equal(sessionLinkHere(PLAIN, "/s/12/files", BASE), null);
    assert.equal(sessionLinkHere(PLAIN, "/api/c/12/download?path=a", BASE), null);
    assert.equal(sessionLinkHere(PLAIN, "src/app.ts", BASE), null);
    assert.equal(sessionLinkHere(PLAIN, "http://[bad", BASE), null);
});
