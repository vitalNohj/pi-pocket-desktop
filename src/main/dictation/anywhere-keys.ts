/**
 * What each press and release of the dictation key means (Trigger), and Dictate anywhere's small pure helpers. Pure, so
 * the tests cover them without a keyboard hook. The key itself, a combination, is in src/main/dictation/key-combo.ts.
 */
import type { Settings } from "../../shared/types";

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
            // Modifiers alone change nothing: the Ctrl the app taps itself (needsMask), or one pressed after the key.
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

export const PILL = { width: 340, height: 72 };

/**
 * The pill's window: frameless, see-through, never focused, over everything. Tiling window managers on macOS (AeroSpace)
 * must take it for a popup, not a window, or they give it a workspace and move it there each time it shows. They do so
 * for a window with no title and no window buttons. A frameless macOS window keeps hidden close, minimize, and zoom
 * buttons unless its corners are square: roundedCorners false makes it borderless. The pill draws its own round corners.
 */
export const pillWindowOptions = (platform: NodeJS.Platform) => ({
    ...PILL,
    show: false,
    title: "",
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Never takes focus: the app you type in keeps it, and gets the words.
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    ...(platform === "darwin" ? { type: "panel", roundedCorners: false } : {}),
});
