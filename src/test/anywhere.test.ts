import { strict as assert } from "node:assert";
import { join } from "node:path";
import { test } from "node:test";
import { HOLD_MS, KEY, keyLabel, needsMask, pasteText, Trigger, triggerKey } from "../main/dictation/anywhere-keys";
import { bpeVocab, customWords, modelById, MODELS } from "../main/dictation/dictation-catalog";
import { defaultSettings, validateSettings } from "../main/core/settings";

const K = KEY.CtrlRight;

test("the automatic key is Right Option on macOS and Right Ctrl elsewhere", () => {
    assert.equal(triggerKey("auto", "darwin"), KEY.AltRight);
    assert.equal(triggerKey("auto", "win32"), KEY.CtrlRight);
    assert.equal(triggerKey("auto", "linux"), KEY.CtrlRight);
    assert.equal(triggerKey("F13", "linux"), KEY.F13);
    assert.equal(keyLabel("auto", "darwin"), "Right Option");
    assert.equal(keyLabel("AltRight", "win32"), "Right Alt");
    assert.equal(keyLabel("MetaRight", "darwin"), "Right Command");
});

test("Alt and the Windows key are masked off macOS: alone they would open a menu", () => {
    assert.ok(needsMask(KEY.AltRight, "win32"));
    assert.ok(needsMask(KEY.MetaRight, "linux"));
    assert.ok(!needsMask(KEY.AltRight, "darwin"));
    assert.ok(!needsMask(KEY.CtrlRight, "win32"));
});

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
    assert.equal(defaults.anywhere.key, "auto");
    assert.deepEqual(defaults.dictation.words, []);

    const good = validateSettings({ anywhere: { enabled: true, key: "F13", mode: "hold", output: "copy", sound: false }, dictation: { words: [" Pi Pocket ", "", "Pi Pocket", "Tribble"] } });

    assert.deepEqual(good.problems, []);
    assert.equal(good.settings.anywhere.key, "F13");
    assert.deepEqual(good.settings.dictation.words, ["Pi Pocket", "Tribble"]);

    const bad = validateSettings({ anywhere: { key: "Space", mode: "sometimes" }, dictation: { words: "Pi" } });

    assert.deepEqual(
        bad.problems.map((problem) => problem.path).sort(),
        ["anywhere.key", "anywhere.mode", "dictation.words"],
    );
});
