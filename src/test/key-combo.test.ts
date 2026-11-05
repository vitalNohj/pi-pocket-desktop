import { strict as assert } from "node:assert";
import { test } from "node:test";
import { KEY } from "../main/dictation/anywhere-keys";
import { accelerator, Chord, checkCombo, codeOfHook, comboLabel, comboOf, HOOK_CODES, needsMask, TRIGGER } from "../main/dictation/key-combo";

const combo = (keys: string) => {
    const checked = checkCombo(keys);

    assert.ok(checked.ok, `${keys}: ${checked.ok ? "" : checked.problem}`);

    return checked;
};

test("a combination is written one way: modifiers by family before the key, or by side when alone", () => {
    assert.equal(combo("KeyD+ShiftLeft+ControlRight").key, "Control+Shift+KeyD");
    assert.equal(combo("Control+Shift+KeyD").key, "Control+Shift+KeyD");
    assert.equal(combo("AltLeft+ControlLeft").key, "ControlLeft+AltLeft");
    assert.equal(combo("AltRight").key, "AltRight");
    assert.equal(combo("F13").key, "F13");
    assert.equal(combo("ShiftLeft+F5").key, "Shift+F5");
    // Settings from before combinations.
    assert.equal(combo("CtrlRight").key, "ControlRight");
});

test("a key that types needs Ctrl, Alt, or ⌘; Escape and two keys are refused", () => {
    assert.equal(checkCombo("KeyA").ok, false);
    assert.equal(checkCombo("ShiftLeft+KeyA").ok, false);
    assert.equal(checkCombo("Space").ok, false);
    assert.equal(checkCombo("Escape").ok, false);
    assert.equal(checkCombo("ControlLeft+KeyA+KeyB").ok, false);
    assert.equal(checkCombo("Control+Shift+Alt+Meta").ok, false);
    assert.equal(checkCombo("Nope").ok, false);
    assert.equal(checkCombo("").ok, false);
    assert.equal(combo("AltLeft+Space").key, "Alt+Space");
});

test("the refusal names this computer's command key", () => {
    const problem = (platform: string): string => {
        const checked = checkCombo("KeyA", platform);

        return checked.ok ? "" : checked.problem;
    };

    assert.match(problem("darwin"), /⌘/);
    assert.match(problem("win32"), /Windows/);
    assert.match(problem("linux"), /Super/);
});

test("auto is Right Option on macOS and Right Ctrl elsewhere; off is none", () => {
    assert.equal(comboOf("auto", "darwin")?.key, "AltRight");
    assert.equal(comboOf("auto", "win32")?.key, "ControlRight");
    assert.equal(comboOf("off", "linux"), undefined);
    assert.equal(comboOf("KeyA", "linux"), undefined);
});

test("labels follow the keyboard", () => {
    assert.equal(comboLabel(combo("AltRight").combo, "darwin"), "Right Option");
    assert.equal(comboLabel(combo("AltRight").combo, "win32"), "Right Alt");
    assert.equal(comboLabel(combo("MetaRight").combo, "win32"), "Right Windows");
    assert.equal(comboLabel(combo("ControlLeft+AltLeft").combo, "linux"), "Left Ctrl + Left Alt");
    assert.equal(comboLabel(combo("Control+Shift+KeyD").combo, "darwin"), "⌃⇧D");
    assert.equal(comboLabel(combo("Meta+Shift+Digit1").combo, "darwin"), "⇧⌘1");
    assert.equal(comboLabel(combo("Control+Shift+KeyD").combo, "win32"), "Ctrl+Shift+D");
    assert.equal(comboLabel(combo("Alt+Space").combo, "linux"), "Alt+Space");
    assert.equal(comboLabel(combo("F13").combo, "darwin"), "F13");
});

test("a combination with a key has an accelerator; modifiers alone have none", () => {
    assert.equal(accelerator(combo("Control+Shift+KeyD").combo), "Control+Shift+D");
    assert.equal(accelerator(combo("Meta+Alt+Digit1").combo), "Alt+Super+1");
    assert.equal(accelerator(combo("Control+ArrowUp").combo), "Control+Up");
    assert.equal(accelerator(combo("F13").combo), "F13");
    assert.equal(accelerator(combo("AltRight").combo), undefined);
});

test("Alt or the Windows key alone is masked off macOS, not with Ctrl, a key, or on macOS", () => {
    assert.ok(needsMask(combo("AltRight").combo, "win32"));
    assert.ok(needsMask(combo("MetaRight").combo, "linux"));
    assert.ok(!needsMask(combo("AltRight").combo, "darwin"));
    assert.ok(!needsMask(combo("ControlRight").combo, "win32"));
    assert.ok(!needsMask(combo("ControlLeft+AltLeft").combo, "win32"));
    assert.ok(!needsMask(combo("Alt+KeyD").combo, "win32"));
});

test("the hook's codes have the window's names", () => {
    assert.equal(codeOfHook(KEY.AltRight), "AltRight");
    assert.equal(codeOfHook(KEY.CtrlRight), "ControlRight");
    assert.equal(codeOfHook(HOOK_CODES.KeyD!), "KeyD");
    assert.equal(codeOfHook(12345), "Hook12345");
});

test("chord with a key: down when the key goes down under exactly its modifiers, up when any part goes up", () => {
    const chord = new Chord(combo("Control+Shift+KeyD").combo);

    assert.deepEqual(chord.down("ControlLeft"), [{ type: "down", code: KEY.Ctrl }]);
    assert.deepEqual(chord.down("ShiftRight"), [{ type: "down", code: KEY.Ctrl }]);
    assert.deepEqual(chord.down("KeyD"), [{ type: "down", code: TRIGGER }]);
    assert.deepEqual(chord.down("KeyD"), [], "a repeat");
    assert.ok(chord.held());
    assert.deepEqual(chord.up("KeyD"), [{ type: "up", code: TRIGGER }]);
    assert.deepEqual(chord.up("ShiftRight"), [{ type: "up", code: KEY.Ctrl }]);
    assert.deepEqual(chord.up("ControlLeft"), [{ type: "up", code: KEY.Ctrl }]);
    assert.ok(!chord.held());

    // An extra modifier, or the key without Shift: not the combination.
    chord.down("ControlLeft");
    chord.down("AltLeft");
    chord.down("ShiftLeft");
    assert.deepEqual(chord.down("KeyD"), [{ type: "down", code: 0 }]);
});

test("chord of modifiers alone: down when all are, never with another key", () => {
    const chord = new Chord(combo("ControlLeft+AltLeft").combo);

    assert.deepEqual(chord.down("ControlLeft"), [{ type: "down", code: KEY.Ctrl }]);
    assert.deepEqual(chord.down("AltLeft"), [{ type: "down", code: TRIGGER }]);
    assert.deepEqual(chord.down("KeyE"), [{ type: "down", code: 0 }], "a shortcut: Trigger cancels");
    assert.deepEqual(chord.up("AltLeft"), [{ type: "up", code: TRIGGER }]);
    chord.up("KeyE");
    chord.up("ControlLeft");

    const right = new Chord(combo("AltRight").combo);

    assert.deepEqual(right.down("AltLeft"), [{ type: "down", code: KEY.Ctrl }], "the other side is another key");
    right.up("AltLeft");
    assert.deepEqual(right.down("AltRight"), [{ type: "down", code: TRIGGER }]);
    assert.deepEqual(right.release(), [{ type: "up", code: TRIGGER }]);
});
