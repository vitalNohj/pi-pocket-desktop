/**
 * The dictation key: which key it is, and what each press and release means. Pure, so the tests cover it without a
 * keyboard hook (src/main/dictation/anywhere.ts feeds it uiohook's key events, or the app window's own).
 */
import type { Settings, TriggerKeyName } from "../../shared/types";

/** uiohook's key codes (uiohook-napi's UiohookKey), for the keys used here. */
export const KEY = {
    Escape: 1,
    V: 47,
    Ctrl: 29,
    CtrlRight: 3613,
    Alt: 56,
    AltRight: 3640,
    Shift: 42,
    ShiftRight: 54,
    Meta: 3675,
    MetaRight: 3676,
    F13: 91,
    F14: 92,
    F15: 93,
} as const;

/** The key a setting names: "auto" is Right Option on macOS (it types nothing alone there) and Right Ctrl elsewhere. */
export function triggerKey(key: "auto" | TriggerKeyName, platform: string): number {
    if (key === "auto") {
        return platform === "darwin" ? KEY.AltRight : KEY.CtrlRight;
    }

    return KEY[key];
}

/** The key's name as this computer's keyboard prints it. */
export function keyLabel(key: "auto" | TriggerKeyName, platform: string): string {
    const mac = platform === "darwin";
    const code = triggerKey(key, platform);

    switch (code) {
        case KEY.AltRight:
            return mac ? "Right Option" : "Right Alt";
        case KEY.CtrlRight:
            return mac ? "Right Control" : "Right Ctrl";
        case KEY.MetaRight:
            return mac ? "Right Command" : platform === "win32" ? "Right Windows" : "Right Super";
        case KEY.ShiftRight:
            return "Right Shift";
        case KEY.F13:
            return "F13";
        case KEY.F14:
            return "F14";
        default:
            return "F15";
    }
}

/**
 * A modifier alone, pressed and let go, can do something of its own: Alt opens the menu bar on Windows, and the
 * Windows or Super key opens the start menu. A Ctrl tap while it is held turns that press into a combination.
 */
export function needsMask(code: number, platform: string): boolean {
    return platform !== "darwin" && (code === KEY.AltRight || code === KEY.MetaRight);
}

/** The keys used here as the window names them (Electron's `input.code`, the DOM's KeyboardEvent.code). */
export const DOM_CODES: Record<number, string> = {
    [KEY.Escape]: "Escape",
    [KEY.V]: "KeyV",
    [KEY.Ctrl]: "ControlLeft",
    [KEY.CtrlRight]: "ControlRight",
    [KEY.Alt]: "AltLeft",
    [KEY.AltRight]: "AltRight",
    [KEY.Shift]: "ShiftLeft",
    [KEY.ShiftRight]: "ShiftRight",
    [KEY.Meta]: "MetaLeft",
    [KEY.MetaRight]: "MetaRight",
    [KEY.F13]: "F13",
    [KEY.F14]: "F14",
    [KEY.F15]: "F15",
};

/** A key of the app's window as uiohook's code, for the same Trigger. Keys not named here are 0: some other key. */
export function domKey(code: string): number {
    const found = Object.entries(DOM_CODES).find(([, name]) => name === code);

    return found === undefined ? 0 : Number(found[0]);
}

export type TriggerMode = Settings["dictation"]["keyMode"];

/** What a key event means for the recording. */
export type TriggerAction = "start" | "stop" | "cancel" | "none";

const MODIFIERS = new Set<number>([KEY.Ctrl, KEY.CtrlRight, KEY.Alt, KEY.AltRight, KEY.Shift, KEY.ShiftRight, KEY.Meta, KEY.MetaRight]);

/** A press longer than this is held: letting go stops. A shorter one is a tap: the next press stops. */
export const HOLD_MS = 300;

/**
 * The key's meaning, press by press. Recording starts at once on a press, so no word is lost waiting to know whether
 * the key is held or tapped:
 * - hold: letting go stops;
 * - toggle: a press starts, the next press stops;
 * - both: a long press (HOLD_MS or more) is held, a short one toggles.
 * Another key pressed with the trigger held makes it a shortcut (such as Right Alt + E for "€"): the recording
 * that press started is dropped. Escape always drops it.
 */
export class Trigger {
    /** The trigger key is down now. */
    held = false;
    #recording = false;
    /** The press that started the recording, while it is still held. */
    #pressedAt: number | undefined;
    /** Another key went down while the trigger was held: a shortcut. */
    #combined = false;

    constructor(
        readonly key: number,
        readonly mode: TriggerMode,
    ) {}

    get recording(): boolean {
        return this.#recording;
    }

    /** The recording ended some other way (the tray, an error, a time limit). */
    reset(): void {
        this.#recording = false;
        this.#pressedAt = undefined;
    }

    /**
     * The press that `down` called a stop starts a recording after all: what it would have stopped had already ended
     * (the mic in Pi Pocket's page, turned off there). Letting go then means what it means after a start.
     */
    resume(at: number): void {
        this.#recording = true;
        this.#pressedAt = this.held ? at : undefined;
    }

    down(code: number, at: number): TriggerAction {
        if (code !== this.key) {
            // Modifiers alone change nothing: Shift with the key, or the Ctrl the app taps itself (needsMask).
            if (MODIFIERS.has(code)) {
                return "none";
            }

            if (this.held) {
                this.#combined = true;
            }

            if (!this.#recording) {
                return "none";
            }

            if (code === KEY.Escape || this.#pressedAt !== undefined) {
                // Escape, or a shortcut with the key that started this recording.
                this.reset();

                return "cancel";
            }

            // Typing while a tapped recording runs: it goes on.
            return "none";
        }

        // The keyboard repeats a held key.
        if (this.held) {
            return "none";
        }

        this.held = true;
        this.#combined = false;

        if (this.#recording) {
            this.reset();

            return "stop";
        }

        this.#recording = true;
        this.#pressedAt = at;

        return "start";
    }

    up(code: number, at: number): TriggerAction {
        if (code !== this.key) {
            return "none";
        }

        this.held = false;

        const pressedAt = this.#pressedAt;

        this.#pressedAt = undefined;

        if (!this.#recording || pressedAt === undefined) {
            return "none";
        }

        // A shortcut that started without another key yet (rare): the release ends it as a hold would.
        if (this.#combined) {
            this.reset();

            return "cancel";
        }

        if (this.mode === "hold" || (this.mode === "both" && at - pressedAt >= HOLD_MS)) {
            this.reset();

            return "stop";
        }

        return "none";
    }
}

/** The words as they go into another app: phrases joined by a space, and a space after a finished sentence. */
export function pasteText(phrases: readonly string[]): string {
    const text = phrases
        .map((phrase) => phrase.trim())
        .filter((phrase) => phrase !== "")
        .join(" ");

    return /[.!?。！？]$/.test(text) ? `${text} ` : text;
}

/**
 * Whether a clipboard type is content worth giving back. X11 lists its own protocol targets (TARGETS, TIMESTAMP,
 * MULTIPLE, SAVE_TARGETS) and portal handles among the types; they describe the old owner, and written back they break
 * what an app reads (a copied file loses its text/uri-list).
 */
export function keptType(type: string): boolean {
    return !/format="(TARGETS|TIMESTAMP|MULTIPLE|SAVE_TARGETS|DELETE|INCR|application\/vnd\.portal\.[^"]*)"/.test(type);
}

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Room left between the pill and the screen's edge. */
const PILL_MARGIN = 40;

/**
 * Where Dictate anywhere's pill goes on the screen: centred, at the bottom, or at the top when the pointer is in the
 * lower half, where the pill could cover what you type.
 */
export function pillPlace(
    area: Rect,
    pointer: { x: number; y: number },
    size: { width: number; height: number },
): { x: number; y: number; edge: "top" | "bottom" } {
    const x = Math.round(area.x + (area.width - size.width) / 2);
    const top = pointer.y >= area.y + area.height / 2;

    return top
        ? { x, y: Math.round(area.y + PILL_MARGIN), edge: "top" }
        : { x, y: Math.round(area.y + area.height - size.height - PILL_MARGIN), edge: "bottom" };
}
