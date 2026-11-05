/**
 * The dictation key: one key, and where it dictates depends on where you are.
 *
 * - Pi Pocket's window in front, showing Pi Pocket: it presses the page's mic (src/main/dictation/page-mic.ts), so the
 *   session's dictation runs and its button shows it. The window hears the key itself, so this needs no keyboard hook
 *   and no permission. With no mic to press (a sheet open, no session), it dictates anywhere instead, if that is on.
 * - Any other app, with Dictate anywhere on: the keyboard hook hears it, and the words are pasted where the cursor is
 *   (src/main/dictation/anywhere.ts).
 * - GUI Settings in front: it dictates anywhere, if that is on, so the words go into the box you type in there.
 *
 * A recording belongs to where it started: the next press (or letting go) ends it there, wherever you are by then.
 */
import type { Input } from "electron";
import type { Settings } from "../../shared/types";
import { KEY, Trigger, type TriggerAction } from "./anywhere-keys";
import { accelerator, Chord, codeOfHook, comboOf, needsMask, TRIGGER, type Step } from "./key-combo";
import type { PageMicAction, PageMicAnswer } from "./page-mic";

export interface DictationKeyHost {
    platform: NodeJS.Platform;
    settings: () => Settings;
    /** Pi Pocket's window has the focus and shows Pi Pocket (not GUI Settings). */
    pageInFront: () => boolean;
    pageMic: (action: PageMicAction) => Promise<PageMicAnswer>;
    /** Takes this accelerator as the app's own shortcut (globalShortcut), or gives it back (undefined). */
    grab: (accelerator: string | undefined, pressed: () => void) => void;
    anywhere: () =>
        | {
              usable(): boolean;
              hooked(): boolean;
              recording(): boolean;
              start(): void;
              stop(drop: boolean): void;
              tap(code: number): void;
              /** macOS: asks again for Accessibility if it went missing. */
              permit(): void;
          }
        | undefined;
}

/** Where the recording the key started runs. */
type Target = { kind: "page"; started: Promise<boolean> } | { kind: "anywhere" };

export function setUpDictationKey(host: DictationKeyHost) {
    let trigger: Trigger | undefined;
    let chord: Chord | undefined;
    let target: Target | undefined;
    let applied = "";
    /** GUI Settings records a new key: this one does nothing meanwhile. */
    let paused = false;

    const apply = (): void => {
        const { key, keyMode } = host.settings().dictation;
        const next = JSON.stringify([key, keyMode]);

        if (next === applied) {
            return;
        }

        applied = next;

        const combo = comboOf(key, host.platform);

        chord = combo === undefined ? undefined : new Chord(combo.combo);
        trigger = combo === undefined ? undefined : new Trigger(TRIGGER, keyMode);
        target = undefined;
    };

    const hooked = (): boolean => host.anywhere()?.hooked() === true;

    /**
     * While the hook hears the keys, a combination with a key (Ctrl+Shift+D) is taken as the app's shortcut, so the app
     * in front does not act on it too. Without the hook the window hears it itself, and a shortcut would hide it there.
     */
    const grab = (): void => {
        const combo = chord?.combo;

        host.grab(combo !== undefined && hooked() && !paused ? accelerator(combo) : undefined, shortcutPressed);
    };

    /** When the shortcut fired, the hook heard the key too, or not long after. */
    let matchedAt = 0;
    const SHORTCUT_WAIT_MS = 80;

    /**
     * The shortcut fired. The hook hears the same press, unless the system keeps a shortcut's keys from it: then the
     * shortcut alone is the press, a tap (with no key events, no release can be known).
     */
    const shortcutPressed = (): void => {
        setTimeout(() => {
            if (chord === undefined || paused || chord.active || Date.now() - matchedAt < 500) {
                return;
            }

            steps([...chord.press(), ...chord.release()]);
        }, SHORTCUT_WAIT_MS);
    };

    /** Starts where you are: the page's mic, else anywhere. */
    const start = (): void => {
        const anywhere = host.anywhere();

        // The tray's Dictate started a recording: the key ends it.
        if (anywhere?.recording() === true) {
            trigger?.reset();
            anywhere.stop(false);

            return;
        }

        if (host.pageInFront()) {
            const started = host.pageMic("toggle").then((answer) => {
                if (answer.found && !answer.listening) {
                    return true;
                }

                // Its mic was on already (the button), and this press turned it off; or there is no mic here.
                if (answer.found) {
                    if (target?.kind === "page" && target.started === started) {
                        target = undefined;
                    }

                    trigger?.reset();

                    return false;
                }

                if (target?.kind === "page" && target.started === started) {
                    startAnywhere();
                }

                return false;
            });

            target = { kind: "page", started };

            return;
        }

        startAnywhere();
    };

    const startAnywhere = (): void => {
        const anywhere = host.anywhere();

        if (anywhere === undefined || !anywhere.usable()) {
            target = undefined;
            trigger?.reset();

            return;
        }

        target = { kind: "anywhere" };
        anywhere.start();
    };

    /** Ends the recording where it started. `drop`: Escape or a shortcut, so its words are not wanted. */
    const stop = (drop: boolean, at: number): void => {
        const ending = target;

        target = undefined;

        if (ending?.kind === "anywhere") {
            host.anywhere()?.stop(drop);

            return;
        }

        if (ending?.kind === "page") {
            void ending.started.then(async (started) => {
                if (!started) {
                    return;
                }

                const answer = await host.pageMic("stop");

                // The mic was turned off in the page already: this press starts it again, as a press with it off does.
                if (!drop && answer.found && !answer.listening && trigger?.held === true && host.pageInFront()) {
                    trigger.resume(at);
                    target = { kind: "page", started: host.pageMic("toggle").then((again) => again.found && !again.listening) };
                }
            });
        }
    };

    const act = (action: TriggerAction, at: number): void => {
        switch (action) {
            case "start":
                // Pressed where the app sees it while macOS took its permission away: ask again now.
                host.anywhere()?.permit();

                // Alt or the Windows key alone opens a menu off macOS: a Ctrl tap makes this press a combination.
                if (chord !== undefined && needsMask(chord.combo, host.platform)) {
                    host.anywhere()?.tap(KEY.Ctrl);
                }

                start();
                break;
            case "stop":
                stop(false, at);
                break;
            case "cancel":
                stop(true, at);
                break;
            case "none":
                break;
        }
    };

    const steps = (list: Step[]): void => {
        for (const step of list) {
            if (trigger === undefined) {
                return;
            }

            const at = Date.now();

            act(step.type === "down" ? trigger.down(step.code, at) : trigger.up(step.code, at), at);
        }
    };

    /** A key went down or up, by the window's name for it (KeyboardEvent.code). */
    const key = (type: "down" | "up", code: string): void => {
        if (chord === undefined || paused) {
            return;
        }

        const list = type === "down" ? chord.down(code) : chord.up(code);

        if (list.some((step) => step.code === TRIGGER && step.type === "down")) {
            matchedAt = Date.now();
        }

        steps(list);
    };

    apply();
    grab();

    return {
        /** A key the keyboard hook heard, in any app. */
        fromHook(type: "down" | "up", code: number): void {
            key(type, codeOfHook(code));
        },

        /**
         * A key in Pi Pocket's window (its before-input-event), acted on here only when no hook hears the keys. The
         * key still reaches the page, whose preload keeps it from Pi Pocket (pageKey): a key stopped here would never
         * report its release.
         */
        fromWindow(input: Input): void {
            if ((input.type === "keyDown" || input.type === "keyUp") && !hooked() && !input.isAutoRepeat) {
                key(input.type === "keyDown" ? "down" : "up", input.code);
            }
        },

        /** The dictation key as the settings write it ("AltRight", "Control+Shift+KeyD"), for the page's preload to keep from Pi Pocket. */
        pageKey(): string | undefined {
            return chord === undefined ? undefined : comboOf(host.settings().dictation.key, host.platform)?.key;
        },

        /** GUI Settings records a new key: the current one does nothing until it is done. */
        pause(on: boolean): void {
            paused = on;
            steps(chord?.release() ?? []);
            grab();
        },

        /** The window lost the focus while it heard the key itself: the key's release goes elsewhere. */
        windowBlurred(): void {
            if (chord !== undefined && !hooked()) {
                steps(chord.release());
            }
        },

        /** A key of the dictation key is down now: a paste would carry it. */
        held: (): boolean => chord?.held() === true,

        /** The keyboard hook started or stopped: take the key's shortcut for the app, or give it back. */
        hookChanged: (): void => grab(),

        /** Dictate anywhere's recording ended some other way (the tray, an error, the time limit). */
        ended(): void {
            if (target === undefined || target.kind === "anywhere") {
                target = undefined;
                trigger?.reset();
            }
        },

        settingsChanged(): void {
            apply();
            grab();
        },
    };
}
