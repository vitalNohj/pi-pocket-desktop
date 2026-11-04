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
import { DOM_CODES, domKey, KEY, needsMask, Trigger, triggerKey, type TriggerAction } from "./anywhere-keys";
import type { PageMicAction, PageMicAnswer } from "./page-mic";

export interface DictationKeyHost {
    platform: NodeJS.Platform;
    settings: () => Settings;
    /** Pi Pocket's window has the focus and shows Pi Pocket (not GUI Settings). */
    pageInFront: () => boolean;
    pageMic: (action: PageMicAction) => Promise<PageMicAnswer>;
    anywhere: () =>
        | {
              usable(): boolean;
              hooked(): boolean;
              recording(): boolean;
              start(): void;
              stop(drop: boolean): void;
              tap(code: number): void;
          }
        | undefined;
}

/** Where the recording the key started runs. */
type Target = { kind: "page"; started: Promise<boolean> } | { kind: "anywhere" };

export function setUpDictationKey(host: DictationKeyHost) {
    let trigger: Trigger | undefined;
    let target: Target | undefined;
    let applied = "";

    const apply = (): void => {
        const { key, keyMode } = host.settings().dictation;
        const next = JSON.stringify([key, keyMode]);

        if (next === applied) {
            return;
        }

        applied = next;
        trigger = key === "off" ? undefined : new Trigger(triggerKey(key, host.platform), keyMode);
        target = undefined;
    };

    const hooked = (): boolean => host.anywhere()?.hooked() === true;

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
                // Alt or the Windows key alone opens a menu off macOS: a Ctrl tap makes this press a combination.
                if (trigger !== undefined && needsMask(trigger.key, host.platform)) {
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

    const key = (type: "down" | "up", code: number): void => {
        if (trigger === undefined) {
            return;
        }

        const at = Date.now();

        act(type === "down" ? trigger.down(code, at) : trigger.up(code, at), at);
    };

    apply();

    return {
        /** A key the keyboard hook heard, in any app. */
        fromHook: key,

        /**
         * A key in Pi Pocket's window (its before-input-event), acted on here only when no hook hears the keys. The
         * key still reaches the page, whose preload keeps it from Pi Pocket (pageKey): a key stopped here would never
         * report its release.
         */
        fromWindow(input: Input): void {
            if (trigger !== undefined && (input.type === "keyDown" || input.type === "keyUp") && !hooked() && !input.isAutoRepeat) {
                key(input.type === "keyDown" ? "down" : "up", domKey(input.code));
            }
        },

        /** The dictation key as the page names it (KeyboardEvent.code), for its preload to keep from Pi Pocket. */
        pageKey(): string | undefined {
            return trigger === undefined ? undefined : DOM_CODES[trigger.key];
        },

        /** The window lost the focus while it heard the key itself: the key's release goes elsewhere. */
        windowBlurred(): void {
            if (trigger?.held === true && !hooked()) {
                key("up", trigger.key);
            }
        },

        /** The dictation key is down now. */
        held: (): boolean => trigger?.held === true,

        /** Dictate anywhere's recording ended some other way (the tray, an error, the time limit). */
        ended(): void {
            if (target === undefined || target.kind === "anywhere") {
                target = undefined;
                trigger?.reset();
            }
        },

        settingsChanged: apply,
    };
}
