// Windows' window menu stays off right-clicks, and Alt+Space keeps it (src/main/window/system-menu.ts).
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { BaseWindow, WebContents } from "electron";
import { ALT_SPACE_MS, keepSystemMenuOffRightClicks, SystemMenuGate } from "../main/window/system-menu";

/** Ask `window` for its menu, as Electron does; says whether the app refused it. */
function ask(window: EventEmitter): boolean {
    let refused = false;

    window.emit("system-context-menu", { preventDefault: () => (refused = true) }, { x: 0, y: 0 });

    return refused;
}

function setUp(): {
    window: EventEmitter;
    server: EventEmitter;
    settings: EventEmitter;
} {
    const window = new EventEmitter();
    const server = new EventEmitter();
    const settings = new EventEmitter();

    keepSystemMenuOffRightClicks(window as unknown as BaseWindow, [server, settings] as unknown as WebContents[]);

    return { window, server, settings };
}

const altSpace = { type: "keyDown", alt: true, code: "Space" } as const;

test("a right-click on a bar is refused Windows' menu, every time", () => {
    const { window } = setUp();

    assert.equal(ask(window), true);
    assert.equal(ask(window), true);
});

test("Alt+Space in either page keeps Windows' menu, once for each press", () => {
    const { window, server, settings } = setUp();

    server.emit("before-input-event", {}, altSpace);
    assert.equal(ask(window), false, "the keyboard asked");
    assert.equal(ask(window), true, "a right-click after it is refused again");

    settings.emit("before-input-event", {}, altSpace);
    assert.equal(ask(window), false);
});

test("other keys do not keep the menu", () => {
    const { window, server } = setUp();

    server.emit("before-input-event", {}, { type: "keyDown", alt: false, code: "Space" });
    assert.equal(ask(window), true, "Space alone");
    server.emit("before-input-event", {}, { type: "keyDown", alt: true, code: "KeyF" });
    assert.equal(ask(window), true, "Alt with another key");
    server.emit("before-input-event", {}, { type: "keyUp", alt: true, code: "Space" });
    assert.equal(ask(window), true, "the key coming up");
});

test("an Alt+Space long ago does not let a later right-click through", () => {
    const gate = new SystemMenuGate();

    gate.key(altSpace, 1000);
    assert.equal(gate.fromKeyboard(1000 + ALT_SPACE_MS + 1), false);

    gate.key(altSpace, 5000);
    assert.equal(gate.fromKeyboard(5000 + ALT_SPACE_MS), true);
    // The clock went back: not counted as the keyboard's.
    gate.key(altSpace, 9000);
    assert.equal(gate.fromKeyboard(8000), false);
});
