import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { navigationKey } from "../main/window/navigation-state";
import type * as Preload from "../preload/navigation";

function page(platform = "linux", isMainFrame = true) {
    const listeners = new Map<string, (event: unknown) => void>();
    const messages: unknown[][] = [];
    const document = { activeElement: null as unknown };
    const exports = {} as typeof Preload;

    runInNewContext(readFileSync(join(__dirname, "..", "preload", "navigation.js"), "utf8"), {
        exports,
        process: { platform, isMainFrame },
        document,
        window: { addEventListener: (name: string, listener: (event: unknown) => void, capture: boolean) => {
            assert.equal(capture, true);
            listeners.set(name, listener);
        } },
        require: (name: string) => {
            assert.equal(name, "electron");

            return { ipcRenderer: { send: (...args: unknown[]) => messages.push(args) } };
        },
    });

    return { exports, document, messages, listeners };
}

function key(key = "ArrowLeft", modifiers: { altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = { altKey: true }) {
    return {
        key, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...modifiers,
        prevented: false,
        stopped: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
    };
}

const input = (editable: boolean, shadowRoot?: unknown) => ({ matches: () => editable, isContentEditable: false, shadowRoot });

test("both views' shared preload sends one IPC per navigation key outside an editable element", () => {
    for (const platform of ["linux", "win32", "darwin"]) {
        const pageState = page(platform);

        for (const direction of ["back", "forward"] as const) {
            const event = key(platform === "darwin" ? (direction === "back" ? "[" : "]") : (direction === "back" ? "ArrowLeft" : "ArrowRight"),
                platform === "darwin" ? { metaKey: true } : { altKey: true });

            pageState.listeners.get("keydown")!(event);
            assert.equal(event.prevented, true);
            assert.equal(event.stopped, true);
        }
        assert.deepEqual(pageState.messages, [["window:navigate", "back"], ["window:navigate", "forward"]]);
    }
});

test("editable inputs, textareas, and inherited contenteditable keep both keys, including shadow-root focus", () => {
    for (const platform of ["linux", "win32", "darwin"]) {
        const pageState = page(platform);

        for (const active of [input(true), { ...input(false), isContentEditable: true }, input(false, { activeElement: input(true) })]) {
            pageState.document.activeElement = active;
            const event = key(platform === "darwin" ? "[" : "ArrowLeft", platform === "darwin" ? { metaKey: true } : { altKey: true });

            pageState.listeners.get("keydown")!(event);
            assert.equal(event.prevented, false);
            assert.equal(event.stopped, false);
            assert.equal(pageState.messages.length, 0);
        }
    }
});

test("noneditable focus still permits navigation", () => {
    const pageState = page();

    pageState.document.activeElement = input(false);
    pageState.listeners.get("keydown")!(key());
    assert.deepEqual(pageState.messages, [["window:navigate", "back"]]);
});

test("only the documented keys and modifiers are taken; main and preload recognize exactly the same keys", () => {
    for (const platform of ["linux", "win32", "darwin"]) {
        const { exports } = page(platform);

        for (const name of ["ArrowLeft", "ArrowRight", "[", "]", "a"]) {
            for (let mask = 0; mask < 16; mask++) {
                const event = key(name, { altKey: Boolean(mask & 1), metaKey: Boolean(mask & 2), ctrlKey: Boolean(mask & 4), shiftKey: Boolean(mask & 8) });
                const direction = exports.keyDirection(event as unknown as KeyboardEvent, platform);

                assert.equal(direction, navigationKey({ key: name, alt: event.altKey, meta: event.metaKey, control: event.ctrlKey, shift: event.shiftKey }, platform));
                if (mask !== (platform === "darwin" ? 2 : 1)) assert.equal(direction, undefined);
            }
        }
    }
});

test("only macOS installs the mouse fallback; it sends one message for buttons 3 and 4", () => {
    assert.equal(page("linux").listeners.has("mouseup"), false);
    assert.equal(page("win32").listeners.has("mouseup"), false);
    const mac = page("darwin");

    for (const button of [0, 1, 2, 3, 4]) {
        const event = { ...key(), button };

        mac.listeners.get("mouseup")!(event);
        assert.equal(event.prevented, button === 3 || button === 4);
    }
    assert.deepEqual(mac.messages, [["window:navigate", "back"], ["window:navigate", "forward"]]);
});

test("subframes never install keyboard or mouse handlers", () => {
    assert.equal(page("darwin", false).listeners.size, 0);
    assert.equal(page("linux", false).listeners.size, 0);
});
