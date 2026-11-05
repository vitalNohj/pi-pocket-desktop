/**
 * The dictation key as a combination: one key alone (Right Option, F13), modifiers alone (Ctrl + Right Alt), or
 * modifiers with one key (Ctrl+Shift+D). Pure, so the tests cover it without a keyboard.
 *
 * Written as the keys' KeyboardEvent.code names joined by "+", the way the settings keep it:
 * - with a key: its modifiers either side ("Control", "Alt", "Shift", "Meta"), then the key: "Control+Shift+KeyD";
 * - modifiers alone: each by its side, as pressed: "AltRight", "ControlLeft+AltLeft".
 */
import { KEY } from "./anywhere-keys";

/** uiohook's key codes by the window's names for the same keys (KeyboardEvent.code). */
export const HOOK_CODES: Readonly<Record<string, number>> = {
    Digit0: 11, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10,
    Backspace: 14, Tab: 15, Enter: 28, CapsLock: 58, Escape: 1, Space: 57, PageUp: 3657, PageDown: 3665, End: 3663,
    Home: 3655, ArrowLeft: 57419, ArrowUp: 57416, ArrowRight: 57421, ArrowDown: 57424, Insert: 3666, Delete: 3667,
    KeyA: 30, KeyB: 48, KeyC: 46, KeyD: 32, KeyE: 18, KeyF: 33, KeyG: 34, KeyH: 35, KeyI: 23, KeyJ: 36, KeyK: 37,
    KeyL: 38, KeyM: 50, KeyN: 49, KeyO: 24, KeyP: 25, KeyQ: 16, KeyR: 19, KeyS: 31, KeyT: 20, KeyU: 22, KeyV: 47,
    KeyW: 17, KeyX: 45, KeyY: 21, KeyZ: 44, Numpad0: 82, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad4: 75,
    Numpad5: 76, Numpad6: 77, Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadMultiply: 55, NumpadAdd: 78,
    NumpadSubtract: 74, NumpadDecimal: 83, NumpadDivide: 3637, NumpadEnter: 3612, F1: 59, F2: 60, F3: 61, F4: 62,
    F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88, F13: 91, F14: 92, F15: 93, F16: 99, F17: 100,
    F18: 101, F19: 102, F20: 103, F21: 104, F22: 105, F23: 106, F24: 107, Semicolon: 39, Equal: 13, Comma: 51,
    Minus: 12, Period: 52, Slash: 53, Backquote: 41, BracketLeft: 26, Backslash: 43, BracketRight: 27, Quote: 40,
    ControlLeft: 29, ControlRight: 3613, AltLeft: 56, AltRight: 3640, ShiftLeft: 42, ShiftRight: 54, MetaLeft: 3675,
    MetaRight: 3676, NumLock: 69, ScrollLock: 70, PrintScreen: 3639,
};

const BY_HOOK = new Map(Object.entries(HOOK_CODES).map(([code, hook]) => [hook, code]));

/** A key the hook heard, by the window's name for it; one with no name here is "Hook<n>", some other key. */
export function codeOfHook(hook: number): string {
    return BY_HOOK.get(hook) ?? `Hook${String(hook)}`;
}

const FAMILIES = ["Control", "Alt", "Shift", "Meta"] as const;

type Family = (typeof FAMILIES)[number];

/** The modifier family of a key's code ("ControlLeft" → "Control"), or undefined for any other key. */
export function familyOf(code: string): Family | undefined {
    const match = /^(Control|Alt|Shift|Meta)(Left|Right)?$/.exec(code);

    return match === null ? undefined : (match[1] as Family);
}

export interface Combo {
    /** With a key: families ("Control"). Alone: sided codes ("AltRight"). */
    mods: string[];
    /** The one key that is not a modifier. */
    main?: string;
}

/** Keys that are fine alone: they type nothing. */
const ALONE = /^(F([1-9]|1[0-9]|2[0-4])|Insert|PrintScreen|ScrollLock|Pause|NumLock)$/;

/** The key the setting "auto" picks: Right Option on macOS (it types nothing alone there), Right Ctrl elsewhere. */
export function defaultKey(platform: string): string {
    return platform === "darwin" ? "AltRight" : "ControlRight";
}

/** Settings from before combinations named Right Ctrl this way. */
const OLD_NAMES: Readonly<Record<string, string>> = { CtrlRight: "ControlRight" };

function known(code: string): boolean {
    return code in HOOK_CODES || (FAMILIES as readonly string[]).includes(code);
}

const order = (code: string): number => {
    const family = familyOf(code);

    return family === undefined ? 99 : FAMILIES.indexOf(family) * 3 + (code.endsWith("Left") ? 1 : code.endsWith("Right") ? 2 : 0);
};

/**
 * Checks a combination (as written in the settings, or as a person pressed it) and writes it the one way the settings
 * keep it. With a key, the modifiers count from either side.
 */
export function checkCombo(
    value: string,
    platform: string = process.platform,
): { ok: true; key: string; combo: Combo } | { ok: false; problem: string } {
    const meta = platform === "darwin" ? "⌘" : platform === "win32" ? "Windows" : "Super";

    const parts = [...new Set(value.split("+").map((part) => OLD_NAMES[part] ?? part.trim()))].filter((part) => part !== "");
    const unknown = parts.find((part) => !known(part));

    if (parts.length === 0 || unknown !== undefined) {
        return { ok: false, problem: unknown === undefined ? "Press a key." : `This key cannot be used (${unknown}).` };
    }

    const keys = parts.filter((part) => familyOf(part) === undefined);

    if (keys.length > 1) {
        return { ok: false, problem: `Use one key, with modifiers if you like: Ctrl, Alt, Shift, ${meta}.` };
    }

    const main = keys[0];

    if (main === "Escape") {
        return { ok: false, problem: "Escape cancels a dictation, so it cannot start one." };
    }

    if (main === undefined) {
        if (parts.length > 3 || parts.some((part) => (FAMILIES as readonly string[]).includes(part))) {
            return { ok: false, problem: "Use at most three modifiers." };
        }

        const mods = parts.sort((a, b) => order(a) - order(b));

        return { ok: true, key: mods.join("+"), combo: { mods } };
    }

    const mods = [...new Set(parts.filter((part) => part !== main).map((part) => familyOf(part)!))].sort(
        (a, b) => FAMILIES.indexOf(a) - FAMILIES.indexOf(b),
    );

    if (!ALONE.test(main) && !mods.some((family) => family !== "Shift")) {
        return { ok: false, problem: `This key types, so add Ctrl, Alt, or ${meta} to it.` };
    }

    return { ok: true, key: [...mods, main].join("+"), combo: { mods, main } };
}

/** The setting's combination for this computer ("auto" picks one), or undefined for "off" or one that is not valid. */
export function comboOf(setting: string, platform: string): { key: string; combo: Combo } | undefined {
    if (setting === "off") {
        return undefined;
    }

    const checked = checkCombo(setting === "auto" ? defaultKey(platform) : setting, platform);

    return checked.ok ? { key: checked.key, combo: checked.combo } : undefined;
}

const MAC_SYMBOLS: Record<Family, string> = { Control: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };

function familyName(family: Family, platform: string): string {
    if (platform === "darwin") {
        return { Control: "Control", Alt: "Option", Shift: "Shift", Meta: "Command" }[family];
    }

    return { Control: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: platform === "win32" ? "Windows" : "Super" }[family];
}

const PUNCTUATION: Readonly<Record<string, string>> = {
    Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";",
    Quote: "'", Comma: ",", Period: ".", Slash: "/", ArrowLeft: "←", ArrowUp: "↑", ArrowRight: "→", ArrowDown: "↓",
    NumpadAdd: "Num +", NumpadSubtract: "Num -", NumpadMultiply: "Num *", NumpadDivide: "Num /", NumpadDecimal: "Num .",
    NumpadEnter: "Num Enter", PageUp: "Page Up", PageDown: "Page Down", PrintScreen: "Print Screen",
    ScrollLock: "Scroll Lock", NumLock: "Num Lock", CapsLock: "Caps Lock",
};

function keyName(code: string, platform: string): string {
    const letter = /^(?:Key|Digit)(.)$/.exec(code);

    if (letter !== null) {
        return letter[1]!;
    }

    const numpad = /^Numpad(\d)$/.exec(code);

    if (numpad !== null) {
        return `Num ${numpad[1]!}`;
    }

    if (code === "Enter" && platform === "darwin") {
        return "Return";
    }

    return PUNCTUATION[code] ?? code;
}

/** The combination's name as this computer's keyboard prints it: "Right Option", "⌃⇧D", "Ctrl+Shift+D". */
export function comboLabel(combo: Combo, platform: string): string {
    if (combo.main === undefined) {
        return combo.mods
            .map((code) => `${code.endsWith("Left") ? "Left" : "Right"} ${familyName(familyOf(code)!, platform)}`)
            .join(" + ");
    }

    const mods = combo.mods as Family[];

    return platform === "darwin"
        ? mods.map((family) => MAC_SYMBOLS[family]).join("") + keyName(combo.main, platform)
        : [...mods.map((family) => familyName(family, platform)), keyName(combo.main, platform)].join("+");
}

const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
    Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";",
    Quote: "'", Comma: ",", Period: ".", Slash: "/", ArrowLeft: "Left", ArrowUp: "Up", ArrowRight: "Right",
    ArrowDown: "Down", NumpadAdd: "numadd", NumpadSubtract: "numsub", NumpadMultiply: "nummult", NumpadDivide: "numdiv",
    NumpadDecimal: "numdec", Enter: "Return", ScrollLock: "Scrolllock", NumLock: "Numlock", CapsLock: "Capslock",
};

/**
 * The combination as an Electron accelerator, so the app can take it for itself (globalShortcut) and the app in front
 * does not act on it too. Only a combination with a key has one: modifiers alone cannot be taken. Letters follow the
 * keyboard's layout in an accelerator but not in the hook, so on a layout other than QWERTY a letter may take another key.
 */
export function accelerator(combo: Combo): string | undefined {
    if (combo.main === undefined) {
        return undefined;
    }

    const letter = /^(?:Key|Digit)(.)$/.exec(combo.main);
    const numpad = /^Numpad(\d)$/.exec(combo.main);
    const key = letter?.[1] ?? (numpad === null ? undefined : `num${numpad[1]!}`) ?? ACCELERATOR_KEYS[combo.main] ?? combo.main;
    const names: Record<string, string> = { Control: "Control", Alt: "Alt", Shift: "Shift", Meta: "Super" };

    return [...combo.mods.map((family) => names[family]!), key].join("+");
}

/**
 * Alt or the Windows key alone, pressed and let go, opens a menu off macOS: a Ctrl tap while it is held turns that press
 * into a combination. Only for modifiers alone, without Ctrl among them.
 */
export function needsMask(combo: Combo, platform: string): boolean {
    const families = combo.mods.map((code) => familyOf(code));

    return platform !== "darwin" && combo.main === undefined && families.some((family) => family === "Alt" || family === "Meta") && !families.includes("Control");
}

/** The combination pressed or let go, for Trigger: its own code. */
export const TRIGGER = -1;

/** What a key means for Trigger: the combination (TRIGGER), Escape, a modifier, or some other key (0). */
export interface Step {
    type: "down" | "up";
    code: number;
}

function stepCode(code: string): number {
    return code === "Escape" ? KEY.Escape : familyOf(code) !== undefined ? KEY.Ctrl : 0;
}

/**
 * Turns key presses into the combination's own presses: it is down once all its keys are, with no other modifier (and,
 * for modifiers alone, no other key), and up when any of them goes up. Other keys pass through as Trigger's codes.
 */
export class Chord {
    readonly #down = new Set<string>();
    #active = false;

    constructor(readonly combo: Combo) {}

    get active(): boolean {
        return this.#active;
    }

    /** A key of the combination is down: a paste now would carry its modifiers. */
    held(): boolean {
        return [...this.#down].some((code) => this.#part(code));
    }

    #part(code: string): boolean {
        if (code === this.combo.main || this.combo.mods.includes(code)) {
            return true;
        }

        const family = familyOf(code);

        return this.combo.main !== undefined && family !== undefined && this.combo.mods.includes(family);
    }

    #matches(code: string): boolean {
        const down = [...this.#down];
        const others = down.filter((each) => familyOf(each) === undefined);
        const mods = down.filter((each) => familyOf(each) !== undefined);

        if (this.combo.main !== undefined) {
            const families = new Set(mods.map((each) => familyOf(each)));

            return (
                code === this.combo.main &&
                others.length === 1 &&
                families.size === this.combo.mods.length &&
                this.combo.mods.every((family) => families.has(family as Family))
            );
        }

        return familyOf(code) !== undefined && others.length === 0 && mods.length === this.combo.mods.length && this.combo.mods.every((each) => this.#down.has(each));
    }

    down(code: string): Step[] {
        // The keyboard repeats a held key; the combination's own keys are part of it while it is down.
        if (this.#down.has(code) || (this.#active && this.#part(code))) {
            this.#down.add(code);

            return [];
        }

        this.#down.add(code);

        if (!this.#active && this.#matches(code)) {
            this.#active = true;

            return [{ type: "down", code: TRIGGER }];
        }

        return [{ type: "down", code: stepCode(code) }];
    }

    up(code: string): Step[] {
        this.#down.delete(code);

        if (this.#active && this.#part(code)) {
            this.#active = false;

            return [{ type: "up", code: TRIGGER }];
        }

        return [{ type: "up", code: stepCode(code) }];
    }

    /** The combination's shortcut fired (globalShortcut) and no key event said so: it is pressed now. */
    press(): Step[] {
        if (this.#active) {
            return [];
        }

        this.#active = true;

        if (this.combo.main !== undefined) {
            this.#down.add(this.combo.main);
        }

        return [{ type: "down", code: TRIGGER }];
    }

    /** No key is down any more (the window lost the focus): lets the combination go. */
    release(): Step[] {
        this.#down.clear();

        if (!this.#active) {
            return [];
        }

        this.#active = false;

        return [{ type: "up", code: TRIGGER }];
    }
}
