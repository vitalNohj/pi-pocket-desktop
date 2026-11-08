import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { DownloadItem, Event, Session, WebContents, WebFrameMain } from "electron";
import { NavigationResponses } from "../main/connection/connection";

type Security = typeof import("../main/core/security");
type Connect = typeof import("../main/connection/connect");
type Downloads = typeof import("../main/bridge/save-file");
const origin = "https://pocket.test";
const url = origin + "/api/c/1/download?path=notes.txt";

function guard() {
    const exports = {} as Security;
    const calls: { origin: string; trusted: boolean }[] = [];
    const session = Object.assign(new EventEmitter(), {
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {},
    });
    const contents = { mainFrame: {} } as WebContents;
    let serverOrigin = origin;

    runInNewContext(readFileSync(join(__dirname, "..", "main", "core", "security.js"), "utf8"), {
        exports, URL,
        require: (name: string) => {
            if (name === "electron") return { shell: {} };
            assert.equal(name, "../bridge/save-file");

            return { saveDownload: (_event: Event, _item: DownloadItem, _contents: WebContents, origin: string, trusted: boolean) => calls.push({ origin, trusted }) };
        },
    });
    exports.guardSession(session as unknown as Session, { server: () => serverOrigin, allowed: () => new Set([serverOrigin]) }, { contents: () => contents, notify() {} });

    return {
        calls, contents,
        changeOrigin: (next: string) => { serverOrigin = next; },
        download: (initiator = origin, sender = contents, frame: WebFrameMain | null = contents.mainFrame) => session.emit("will-download", {}, { getInitiatorOrigin: () => initiator }, sender, frame),
    };
}

test("will-download trusts only the server view, its top frame, and the original initiator origin", () => {
    const h = guard();

    h.download();
    h.download("https://elsewhere.test");
    h.download("null");
    h.download("");
    h.download(origin, { mainFrame: {} } as WebContents);
    h.download(origin, h.contents, {} as WebFrameMain);
    h.download(origin, h.contents, null);
    assert.deepEqual(h.calls.map((call) => call.trusted), [true, false, false, false, false, false, false]);
    h.changeOrigin("https://new-server.test");
    h.download();
    h.download("https://new-server.test");
    assert.equal(h.calls.at(-2)?.trusted, false);
    assert.equal(h.calls.at(-1)?.trusted, true);
    assert.equal(h.calls.at(-1)?.origin, "https://new-server.test");
});

interface Details {
    id: number;
    url: string;
    webContentsId?: number;
    frame?: unknown;
    initiatorOrigin?: string | undefined;
    resourceType?: string;
    statusCode?: number;
    responseHeaders?: Record<string, string[]>;
}
type Callback = (response: { cancel?: boolean }) => void;
type Hook = (details: Details, callback: Callback) => void;

function network() {
    const exports = {} as Connect;
    const hooks = new Map<string, Hook>();
    const starts: Parameters<Downloads["saveRequestStarted"]>[] = [];
    const responses: Parameters<Downloads["saveResponse"]>[] = [];
    const ended: number[] = [];
    const contents = Object.assign(new EventEmitter(), {
        id: 7, mainFrame: {},
        session: { webRequest: Object.fromEntries(["onBeforeRequest", "onHeadersReceived", "onCompleted", "onErrorOccurred"].map((event) => [event, (hook: Hook) => hooks.set(event, hook)])) },
    });
    let blocked = false;

    runInNewContext(readFileSync(join(__dirname, "..", "main", "connection", "connect.js"), "utf8"), {
        exports,
        require: (name: string) => {
            switch (name) {
                case "./connection": return { NavigationResponses };
                case "./address": return { currentOrigin: () => origin };
                case "../app/state": return { state: { gui: { server: { webContents: contents } } } };
                case "../bridge/save-file": return {
                    saveRequestStarted: (...args: Parameters<Downloads["saveRequestStarted"]>) => starts.push(args),
                    saveResponse: (...args: Parameters<Downloads["saveResponse"]>) => { responses.push(args); return blocked; },
                    saveRequestEnded: (id: number) => ended.push(id),
                };
                default: return {};
            }
        },
    });
    exports.watchServerView();
    const details: Details = { id: 1, url, webContentsId: contents.id, frame: contents.mainFrame, initiatorOrigin: origin };

    return {
        starts, responses, ended, details,
        block: () => { blocked = true; },
        emit: (event: string, patch: Partial<Details> = {}) => {
            let answer: { cancel?: boolean } | undefined;

            hooks.get(event)!({ ...details, ...patch }, (response) => { answer = response; });

            return answer;
        },
    };
}

test("the shared network hook tracks the request URL and contents only for the trusted view and initiator", () => {
    const h = network();

    h.emit("onBeforeRequest");
    h.emit("onBeforeRequest", { webContentsId: 8 });
    h.emit("onBeforeRequest", { frame: {} });
    h.emit("onBeforeRequest", { frame: null });
    h.emit("onBeforeRequest", { initiatorOrigin: "https://elsewhere.test" });
    h.emit("onBeforeRequest", { initiatorOrigin: undefined });
    assert.deepEqual(h.starts.map((args) => args[4]), [true, false, false, false, false, false]);
    assert.deepEqual(h.starts[0], [1, url, 7, origin, true]);
    h.emit("onCompleted");
    h.emit("onErrorOccurred", { id: 2 });
    assert.deepEqual(h.ended, [1, 2]);
});

test("the shared headers hook cancels failed downloads and allows only actual intermediate redirects", () => {
    const h = network();

    assert.equal(h.emit("onHeadersReceived", { statusCode: 302, responseHeaders: { Location: ["/next"] } })?.cancel, undefined);
    assert.equal(h.responses.at(-1)?.[3], true);
    h.emit("onHeadersReceived", { statusCode: 302 });
    assert.equal(h.responses.at(-1)?.[3], false);
    h.emit("onHeadersReceived", { statusCode: 304, responseHeaders: { location: ["/next"] } });
    assert.equal(h.responses.at(-1)?.[3], false);
    h.block();
    assert.equal(h.emit("onHeadersReceived", { statusCode: 404 })?.cancel, true);
});
