import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Input } from "electron";
import { defaultSettings } from "../main/core/settings";
import { HOLD_MS } from "../main/dictation/anywhere-keys";
import { setUpDictationKey } from "../main/dictation/dictation-key";
import type { PageMicAnswer } from "../main/dictation/page-mic";
import type { Settings } from "../shared/types";

/** A world for the key: where the focus is, the page's mic, and Dictate anywhere, with what each was asked. */
function world(options: { page?: boolean; mic?: boolean; anywhere?: boolean; hooked?: boolean; mode?: Settings["dictation"]["keyMode"] } = {}) {
    const settings = defaultSettings();

    settings.dictation.key = "CtrlRight";
    settings.dictation.keyMode = options.mode ?? "both";
    settings.anywhere.enabled = options.anywhere ?? false;

    const calls: string[] = [];
    const grabbed: { value: string | undefined } = { value: undefined };
    const place = { page: options.page ?? true };
    const mic = { found: options.mic ?? true, listening: false };
    let recording = false;
    const permits = { count: 0 };

    const key = setUpDictationKey({
        platform: "linux",
        settings: () => settings,
        pageInFront: () => place.page,
        pageMic: async (action): Promise<PageMicAnswer> => {
            calls.push(`page ${action}`);

            const answer = { ...mic };

            if (mic.found && (action === "toggle" || mic.listening)) {
                mic.listening = !mic.listening;
            }

            return answer;
        },
        anywhere: () => ({
            usable: () => settings.anywhere.enabled,
            hooked: () => options.hooked ?? false,
            recording: () => recording,
            start: () => {
                recording = true;
                calls.push("anywhere start");
            },
            stop: (drop) => {
                recording = false;
                calls.push(drop ? "anywhere drop" : "anywhere stop");
            },
            tap: (code) => calls.push(`tap ${code}`),
            permit: () => {
                permits.count++;
            },
        }),
        grab: (accelerator) => {
            grabbed.value = accelerator;
        },
    });

    return { key, calls, place, mic, settings, grabbed, permits };
}

const input = (type: "keyDown" | "keyUp", code = "ControlRight"): Input => ({ type, code, key: code, isAutoRepeat: false }) as Input;
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("in Pi Pocket's window, a tap turns the page's mic on, and the next tap off", async () => {
    const { key, calls, mic } = world();

    assert.equal(key.pageKey(), "ControlRight", "the page keeps this key from Pi Pocket");
    key.fromWindow(input("keyDown"));
    key.fromWindow(input("keyUp"));
    await settle();
    assert.ok(mic.listening);
    key.fromWindow(input("keyDown"));
    await settle();
    await settle();
    key.fromWindow(input("keyUp"));
    assert.deepEqual(calls, ["page toggle", "page stop"]);
    assert.ok(!mic.listening);
});

test("another key in the window is not the dictation key", () => {
    const { key, calls } = world();

    key.fromWindow(input("keyDown", "KeyA"));
    assert.deepEqual(calls, []);
});

test("held in the window: letting go turns the mic off", async () => {
    const { key, calls, mic } = world({ mode: "hold" });

    key.fromWindow(input("keyDown"));
    await settle();
    key.fromWindow(input("keyUp"));
    await settle();
    await settle();
    assert.deepEqual(calls, ["page toggle", "page stop"]);
    assert.ok(!mic.listening);
});

test("the mic turned off by its button: letting go does not turn it on again", async () => {
    const { key, calls, mic } = world({ mode: "hold" });

    key.fromWindow(input("keyDown"));
    await settle();
    mic.listening = false;
    key.fromWindow(input("keyUp"));
    await settle();
    await settle();
    assert.deepEqual(calls, ["page toggle", "page stop"]);
    assert.ok(!mic.listening);
});

test("the mic on by its button: a tap turns it off, and is not a recording", async () => {
    const { key, calls, mic } = world();

    mic.listening = true;
    key.fromWindow(input("keyDown"));
    await settle();
    key.fromWindow(input("keyUp"));
    key.fromWindow(input("keyDown"));
    await settle();
    assert.deepEqual(calls, ["page toggle", "page toggle"], "the second tap starts it again");
    assert.ok(mic.listening);
});

test("no mic in the page (a sheet open): Dictate anywhere's paste, when it is on", async () => {
    const off = world({ mic: false });

    off.key.fromWindow(input("keyDown"));
    await settle();
    assert.deepEqual(off.calls, ["page toggle"]);

    const on = world({ mic: false, anywhere: true });

    on.key.fromWindow(input("keyDown"));
    await settle();
    on.key.fromWindow(input("keyUp"));
    on.key.fromWindow(input("keyDown"));
    assert.deepEqual(on.calls, ["page toggle", "anywhere start", "anywhere stop"]);
});

test("in another app (the hook hears it): Dictate anywhere, held or tapped", () => {
    const { key, calls, place } = world({ anywhere: true, hooked: true });

    place.page = false;
    key.fromHook("down", 3613);
    key.fromHook("up", 3613);
    key.fromHook("down", 3613);
    key.fromHook("up", 3613);
    assert.deepEqual(calls, ["anywhere start", "anywhere stop"]);
});

test("with the hook on, the window takes the key but leaves the acting to the hook", async () => {
    const { key, calls } = world({ anywhere: true, hooked: true });

    key.fromWindow(input("keyDown"));
    assert.deepEqual(calls, []);
    key.fromHook("down", 3613);
    await settle();
    assert.deepEqual(calls, ["page toggle"]);
});

test("a recording belongs to where it started: switching into the window, the key still ends it there", async () => {
    const { key, calls, place } = world({ anywhere: true, hooked: true, mode: "toggle" });

    place.page = false;
    key.fromHook("down", 3613);
    key.fromHook("up", 3613);
    place.page = true;
    key.fromHook("down", 3613);
    await settle();
    assert.deepEqual(calls, ["anywhere start", "anywhere stop"]);
});

test("GUI Settings in front: the key dictates anywhere, heard by the hook or by the window", () => {
    const hooked = world({ anywhere: true, hooked: true });

    hooked.place.page = false;
    hooked.key.fromHook("down", 3613);
    hooked.key.fromHook("up", 3613);
    hooked.key.fromHook("down", 3613);
    hooked.key.fromHook("up", 3613);
    assert.deepEqual(hooked.calls, ["anywhere start", "anywhere stop"]);

    const unhooked = world({ anywhere: true, hooked: false });

    unhooked.place.page = false;
    unhooked.key.fromWindow(input("keyDown"));
    unhooked.key.fromWindow(input("keyUp"));
    assert.deepEqual(unhooked.calls, ["anywhere start"]);
});

test("Escape drops a recording anywhere; the tray's recording ends with the key", () => {
    const { key, calls, place } = world({ anywhere: true, hooked: true });

    place.page = false;
    key.fromHook("down", 3613);
    key.fromHook("up", 3613);
    key.fromHook("down", 1);
    assert.deepEqual(calls, ["anywhere start", "anywhere drop"]);
});

test("the window losing the focus while the key is held lets it go", async () => {
    const { key, calls } = world({ mode: "both" });

    key.fromWindow(input("keyDown"));
    await settle();
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS + 20));
    key.windowBlurred();
    await settle();
    await settle();
    assert.deepEqual(calls, ["page toggle", "page stop"]);
});

test("no key: nothing is taken", () => {
    const { key } = world();
    const settings = defaultSettings();

    settings.dictation.key = "off";

    const none = setUpDictationKey({
        platform: "linux",
        settings: () => settings,
        pageInFront: () => true,
        pageMic: async () => ({ found: true, listening: false }),
        anywhere: () => undefined,
        grab: () => undefined,
    });

    assert.equal(none.pageKey(), undefined);
    assert.ok(key !== undefined);
});

test("a combination with a key: Ctrl+Shift+D dictates anywhere, and is taken as the app's shortcut while hooked", () => {
    const { key, calls, place, settings, grabbed } = world({ anywhere: true, hooked: true, mode: "toggle" });

    settings.dictation.key = "Control+Shift+KeyD";
    key.settingsChanged();
    assert.equal(grabbed.value, "Control+Shift+D");
    assert.equal(key.pageKey(), "Control+Shift+KeyD");

    place.page = false;

    const tap = () => {
        key.fromHook("down", 29);
        key.fromHook("down", 42);
        key.fromHook("down", 32);
        key.fromHook("up", 32);
        key.fromHook("up", 42);
        key.fromHook("up", 29);
    };

    tap();
    tap();
    // D alone, or Ctrl+D: not the key.
    key.fromHook("down", 32);
    key.fromHook("up", 32);
    key.fromHook("down", 29);
    key.fromHook("down", 32);
    key.fromHook("up", 32);
    key.fromHook("up", 29);
    assert.deepEqual(calls, ["anywhere start", "anywhere stop"]);
});

test("recording a new key pauses the current one, and gives its shortcut back", () => {
    const { key, calls, place, settings, grabbed } = world({ anywhere: true, hooked: true });

    settings.dictation.key = "Control+Shift+KeyD";
    key.settingsChanged();
    place.page = false;
    key.pause(true);
    assert.equal(grabbed.value, undefined);
    key.fromHook("down", 29);
    key.fromHook("down", 42);
    key.fromHook("down", 32);
    key.fromHook("up", 32);
    key.fromHook("up", 42);
    key.fromHook("up", 29);
    key.pause(false);
    assert.equal(grabbed.value, "Control+Shift+D");
    assert.deepEqual(calls, []);
});

test("modifiers alone: Left Ctrl + Left Alt held dictates; with another key it is a shortcut", async () => {
    const { key, calls, place, settings } = world({ anywhere: true, hooked: true, mode: "hold" });

    settings.dictation.key = "ControlLeft+AltLeft";
    key.settingsChanged();
    place.page = false;
    key.fromHook("down", 29);
    key.fromHook("down", 56);
    key.fromHook("up", 56);
    key.fromHook("up", 29);
    key.fromHook("down", 29);
    key.fromHook("down", 56);
    key.fromHook("down", 20);
    key.fromHook("up", 20);
    key.fromHook("up", 56);
    key.fromHook("up", 29);
    assert.deepEqual(calls, ["anywhere start", "anywhere stop", "anywhere start", "anywhere drop"]);
});

test("each press that starts dictation where the app sees it asks for a missing permission (macOS)", async () => {
    const { key, permits } = world();

    key.fromWindow(input("keyDown"));
    key.fromWindow(input("keyUp"));
    await settle();
    assert.equal(permits.count, 1);

    // The press that stops it does not ask.
    key.fromWindow(input("keyDown"));
    key.fromWindow(input("keyUp"));
    await settle();
    assert.equal(permits.count, 1);
});
