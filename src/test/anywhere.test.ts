import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HOLD_MS, KEY, keptType, pasteText, pillPlace, pillWindowOptions, Trigger } from "../main/dictation/anywhere-keys";
import { bpeVocab, customWords, modelById, MODELS } from "../main/dictation/dictation-catalog";
import { defaultSettings, validateSettings } from "../main/core/settings";
import { BUNDLE_ID, resetAccessibility } from "../main/dictation/mac-accessibility";

const K = KEY.CtrlRight;

test("hold: a press starts, letting go stops, however short", () => {
    const trigger = new Trigger(K, "hold");

    assert.equal(trigger.down(K, 0), "start");
    assert.equal(trigger.down(K, 50), "none", "the keyboard's repeat");
    assert.equal(trigger.up(K, 100), "stop");
    assert.ok(!trigger.recording);
});

test("toggle: a press starts, the next press stops", () => {
    const trigger = new Trigger(K, "toggle");

    assert.equal(trigger.down(K, 0), "start");
    assert.equal(trigger.up(K, 2000), "none");
    assert.equal(trigger.down(K, 5000), "stop");
    assert.equal(trigger.up(K, 5100), "none");
    assert.ok(!trigger.recording);
});

test("both: a long press is held, a short one is a tap", () => {
    const trigger = new Trigger(K, "both");

    assert.equal(trigger.down(K, 0), "start");
    assert.equal(trigger.up(K, HOLD_MS + 1), "stop");

    assert.equal(trigger.down(K, 1000), "start");
    assert.equal(trigger.up(K, 1100), "none", "a tap: still recording");
    assert.ok(trigger.recording);
    assert.equal(trigger.down(K, 3000), "stop");
    assert.equal(trigger.up(K, 3050), "none");
});

test("another key with the trigger held makes it a shortcut: the recording is dropped", () => {
    const trigger = new Trigger(KEY.AltRight, "both");

    assert.equal(trigger.down(KEY.AltRight, 0), "start");
    assert.equal(trigger.down(18 /* E */, 40), "cancel");
    assert.equal(trigger.up(KEY.AltRight, 90), "none");
    assert.ok(!trigger.recording);
});

test("modifiers pressed with the key do not cancel it (the app's own Ctrl tap, or Shift)", () => {
    const trigger = new Trigger(KEY.AltRight, "hold");

    assert.equal(trigger.down(KEY.AltRight, 0), "start");
    assert.equal(trigger.down(KEY.Ctrl, 5), "none");
    assert.equal(trigger.up(KEY.AltRight, 1000), "stop");
});

test("typing while a tapped recording runs goes on; Escape drops it", () => {
    const trigger = new Trigger(K, "toggle");

    assert.equal(trigger.down(K, 0), "start");
    trigger.up(K, 50);
    assert.equal(trigger.down(30 /* A */, 500), "none");
    assert.ok(trigger.recording);
    assert.equal(trigger.down(KEY.Escape, 900), "cancel");
    assert.ok(!trigger.recording);
});

test("a recording ended elsewhere: the next press starts again", () => {
    const trigger = new Trigger(K, "toggle");

    trigger.down(K, 0);
    trigger.up(K, 10);
    trigger.reset();
    assert.equal(trigger.down(K, 100), "start");
});

test("pasted words: phrases joined, a space after a finished sentence", () => {
    assert.equal(pasteText(["Hello there.", " How are you?"]), "Hello there. How are you? ");
    assert.equal(pasteText(["no stop"]), "no stop");
    assert.equal(pasteText(["", "  "]), "");
});

test("custom words: Parakeet only, with beam search and the words as hotwords", () => {
    const parakeet = MODELS.find((model) => model.family === "parakeet")!;
    const whisper = MODELS.find((model) => model.family === "whisper")!;
    const words = customWords(parakeet, "/m", ["Pi Pocket", "a/b:c", "", "Pi Pocket"], join);

    assert.ok(words !== undefined);
    assert.equal(words.hotwords, "Pi Pocket/a b c");
    assert.deepEqual(words.model, { modelingUnit: "bpe", bpeVocab: join("/m", "bpe.vocab") });
    assert.equal(words.recognizer.decodingMethod, "modified_beam_search");
    assert.equal(customWords(parakeet, "/m", [], join), undefined);
    assert.equal(customWords(whisper, "/m", ["Pi Pocket"], join), undefined);
    assert.ok(modelById(parakeet.id) !== undefined);
});

test("the BPE vocabulary is each token with its negative id", () => {
    assert.equal(bpeVocab("<unk> 0\n▁t 1\n▁th 2\n"), "<unk>\t0\n▁t\t-1\n▁th\t-2\n");
});

test("settings: Dictate anywhere is off by default, and its values are checked", () => {
    const defaults = defaultSettings();

    assert.equal(defaults.anywhere.enabled, false);
    assert.equal(defaults.dictation.key, "auto");
    assert.equal(defaults.dictation.keyMode, "both");
    assert.deepEqual(defaults.dictation.words, []);

    const good = validateSettings({ anywhere: { enabled: true, output: "copy", sound: false }, dictation: { key: "F13", keyMode: "hold", words: [" Pi Pocket ", "", "Pi Pocket", "Tribble"] } });

    assert.deepEqual(good.problems, []);
    assert.equal(good.settings.dictation.key, "F13");
    assert.equal(validateSettings({ dictation: { key: "off" } }).settings.dictation.key, "off");
    assert.deepEqual(good.settings.dictation.words, ["Pi Pocket", "Tribble"]);

    const bad = validateSettings({ anywhere: { output: "type" }, dictation: { key: "KeyA", keyMode: "sometimes", words: "Pi" } });

    assert.deepEqual(
        bad.problems.map((problem) => problem.path).sort(),
        ["anywhere.output", "dictation.key", "dictation.keyMode", "dictation.words"],
    );
});

test("the clipboard keeps content types, not X11's protocol targets or portal handles", () => {
    const raw = (name: string) => `electron application/osclipboard;format="${name}"`;

    assert.ok(keptType("text/plain"));
    assert.ok(keptType("image/png"));
    assert.ok(keptType(raw("x-special/gnome-copied-files")));
    assert.ok(keptType(raw("UTF8_STRING")));
    assert.ok(!keptType(raw("TARGETS")));
    assert.ok(!keptType(raw("TIMESTAMP")));
    assert.ok(!keptType(raw("MULTIPLE")));
    assert.ok(!keptType(raw("SAVE_TARGETS")));
    assert.ok(!keptType(raw("application/vnd.portal.files")));
});

test("resume: a press that would stop starts after all, and letting go then stops", () => {
    const trigger = new Trigger(K, "both");

    trigger.down(K, 0);
    trigger.up(K, 100);
    assert.equal(trigger.down(K, 1000), "stop");
    trigger.resume(1000);
    assert.ok(trigger.recording);
    assert.equal(trigger.up(K, 1000 + HOLD_MS + 1), "stop");
});

test("the pill goes to the top when the pointer is in the screen's lower half", () => {
    const area = { x: 0, y: 25, width: 1440, height: 875 };
    const size = { width: 340, height: 72 };

    assert.deepEqual(pillPlace(area, { x: 300, y: 200 }, size), { x: 550, y: 788, edge: "bottom" });
    assert.deepEqual(pillPlace(area, { x: 300, y: 700 }, size), { x: 550, y: 65, edge: "top" });
    // A second screen to the right, above the first.
    assert.equal(pillPlace({ x: 1440, y: -400, width: 1920, height: 1080 }, { x: 2000, y: 300 }, size).edge, "top");
    assert.equal(pillPlace({ x: 1440, y: -400, width: 1920, height: 1080 }, { x: 2000, y: 0 }, size).edge, "bottom");
});

test("the pill is a popup to window managers: no title, no window buttons, on macOS no hidden ones either", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
        const options = pillWindowOptions(platform);

        assert.equal(options.title, "");
        assert.equal(options.frame, false);
        assert.equal(options.focusable, false);
        assert.equal(options.minimizable, false);
        assert.equal(options.maximizable, false);
        assert.equal(options.fullscreenable, false);
        // A window that cannot close keeps macOS from quitting the app.
        assert.equal("closable" in options, false);
    }

    assert.deepEqual(
        { type: pillWindowOptions("darwin").type, roundedCorners: pillWindowOptions("darwin").roundedCorners },
        { type: "panel", roundedCorners: false },
    );
    assert.equal("roundedCorners" in pillWindowOptions("win32"), false);
});

test("macOS Accessibility: tccutil removes the app's own entry, and nothing runs elsewhere", async () => {
    const calls: string[][] = [];
    const run = ((file: string, args: string[], _options: unknown, done: (error: Error | null) => void) => {
        calls.push([file, ...args]);
        done(null);
    }) as unknown as typeof import("node:child_process").execFile;

    assert.equal(await resetAccessibility("darwin", run), true);
    assert.deepEqual(calls, [["/usr/bin/tccutil", "reset", "Accessibility", BUNDLE_ID]]);
    assert.equal(await resetAccessibility("linux", run), false);
    assert.equal(calls.length, 1);

    const failing = ((_file: string, _args: string[], _options: unknown, done: (error: Error | null) => void) => done(new Error("no"))) as unknown as typeof import("node:child_process").execFile;

    assert.equal(await resetAccessibility("darwin", failing), false);
});

test("the bundle id tccutil resets is the app's own", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as { build: { appId: string } };

    assert.equal(BUNDLE_ID, pkg.build.appId);
});
