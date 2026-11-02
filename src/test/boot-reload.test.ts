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
        require: () => ({ contextBridge: {}, ipcRenderer: { sendSync: () => null } }),
    });

    return exports;
}

const { BootWait, BOOT_RELOAD_DELAY_MS, showsFullScreenBoot } = loadPreload();

/** Fake timers: `tick(ms)` moves time on and runs what is due. */
function clock() {
    let now = 0;
    let next = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();

    return {
        timers: {
            set: (callback: () => void, ms: number) => {
                timers.set(++next, { at: now + ms, callback });

                return next;
            },
            clear: (handle: unknown) => {
                timers.delete(handle as number);
            },
        },
        pending: () => timers.size,
        tick: (ms: number) => {
            now += ms;

            for (const [id, timer] of [...timers]) {
                if (timer.at <= now) {
                    timers.delete(id);
                    timer.callback();
                }
            }
        },
    };
}

function setUp() {
    const time = clock();
    const events: string[] = [];
    const wait = new BootWait(BOOT_RELOAD_DELAY_MS, time.timers, () => events.push("show"), () => events.push("hide"));

    return { time, events, wait };
}

test("the button waits 5 s", () => {
    assert.equal(BOOT_RELOAD_DELAY_MS, 5_000);
});

test("no button before 5 s of boot screen; the button at 5 s", () => {
    const { time, events, wait } = setUp();

    wait.update(true);
    time.tick(4_999);
    assert.deepEqual(events, []);
    time.tick(1);
    assert.deepEqual(events, ["show"]);
});

test("the button goes at once with the boot screen", () => {
    const { time, events, wait } = setUp();

    wait.update(true);
    time.tick(6_000);
    wait.update(false);
    assert.deepEqual(events, ["show", "hide"]);
});

test("a boot screen that goes before 5 s never shows the button", () => {
    const { time, events, wait } = setUp();

    wait.update(true);
    time.tick(3_000);
    wait.update(false);
    time.tick(10_000);
    assert.deepEqual(events, []);
    assert.equal(time.pending(), 0);
});

test("a new boot screen waits 5 s from its own start", () => {
    const { time, events, wait } = setUp();

    wait.update(true);
    time.tick(4_000);
    wait.update(false);
    wait.update(true);
    time.tick(4_000);
    assert.deepEqual(events, []);
    time.tick(1_000);
    assert.deepEqual(events, ["show"]);
});

test("repeated reports of the same state change nothing", () => {
    const { time, events, wait } = setUp();

    wait.update(false);
    wait.update(true);
    time.tick(3_000);
    // A DOM change elsewhere while the boot screen still shows: the wait goes on.
    wait.update(true);
    time.tick(2_000);
    wait.update(true);
    assert.deepEqual(events, ["show"]);
    assert.equal(time.pending(), 0);
    wait.update(false);
    wait.update(false);
    assert.deepEqual(events, ["show", "hide"]);
});

test("only a full-screen boot screen counts", () => {
    const boot = (part: string | null, ...classes: string[]) => ({
        classList: { contains: (name: string) => ["boot", ...classes].includes(name) },
        getAttribute: (name: string) => (name === "data-part" ? part : null),
    });

    assert.equal(showsFullScreenBoot([]), false);
    assert.equal(showsFullScreenBoot([boot("boot")]), true);
    assert.equal(showsFullScreenBoot([boot("boot", "inline")]), false);
    assert.equal(showsFullScreenBoot([boot(null)]), false);
    assert.equal(showsFullScreenBoot([boot("boot", "inline"), boot("boot")]), true);
});
