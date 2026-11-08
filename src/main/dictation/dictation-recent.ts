/**
 * The last dictations, kept so their words can be copied again when something went wrong: the message box lost them, a
 * paste went nowhere, or the speech model stopped halfway. Desktop Settings → Dictation lists them, and the tray copies
 * the last one. Only in memory: nothing is written to disk, and quitting the app forgets them.
 *
 * Pure (no Electron): offline dictation (src/main/dictation/dictation.ts) passes on what each dictation hears.
 */
import type { RecentDictation } from "../../shared/types";
import type { PageMessage } from "./dictation";
import { pasteText } from "./anywhere-keys";

/** How many dictations are kept, newest first. */
export const RECENT_LIMIT = 5;

interface Take {
    phrases: string[];
    error?: string;
    dropped?: boolean;
}

export function createRecent(now: () => number = Date.now, limit = RECENT_LIMIT) {
    /** Dictations that still listen, by their id (the page's are positive, the app's own negative). */
    const open = new Map<number, Take>();
    let kept: RecentDictation[] = [];
    let counter = 0;

    /** Ends a dictation: kept when it heard words. Whether the list changed. */
    const finish = (id: number): boolean => {
        const take = open.get(id);

        open.delete(id);

        const text = take === undefined ? "" : pasteText(take.phrases).trimEnd();

        if (take === undefined || text === "") {
            return false;
        }

        const done: RecentDictation = {
            id: ++counter,
            text,
            at: now(),
            where: id > 0 ? "pi-pocket" : "anywhere",
            ...(take.error === undefined ? {} : { error: take.error }),
            ...(take.dropped === true ? { dropped: true as const } : {}),
        };

        kept = [done, ...kept].slice(0, limit);

        return true;
    };

    const takeOf = (id: number): Take => {
        let take = open.get(id);

        if (take === undefined) {
            take = { phrases: [] };
            open.set(id, take);
        }

        return take;
    };

    return {
        /**
         * A dictation starts. One still open with the same id never ended (the page reloaded and counts from 1 again):
         * it ends first, so the two do not run together. Whether the list changed.
         */
        start(id: number): boolean {
            const changed = finish(id);

            open.set(id, { phrases: [] });

            return changed;
        },

        /** What a dictation heard: its settled phrases, an error, its end. Whether the list changed. */
        heard(message: PageMessage): boolean {
            switch (message.type) {
                case "result":
                    // Words so far are corrected at the pause; only the settled phrase counts.
                    if (message.final) {
                        takeOf(message.id).phrases.push(message.text);
                    }

                    return false;
                case "error":
                    // "aborted" is a dictation dropped on purpose, not a failure.
                    if (message.error !== "aborted") {
                        takeOf(message.id).error = message.error;
                    }

                    return false;
                case "end":
                    return finish(message.id);
            }
        },

        /**
         * The person drops a dictation of Dictate anywhere (Esc): it is kept all the same, marked, since an Esc pressed
         * by mistake is one of the things to recover from. The page's own drops are not marked: it drops the words not
         * settled yet as a message is sent, which is no mistake.
         */
        dropped(id: number): void {
            const take = open.get(id);

            if (take !== undefined) {
                take.dropped = true;
            }
        },

        /** The kept dictations, newest first. */
        list(): RecentDictation[] {
            return kept.map((each) => ({ ...each }));
        },

        last(): RecentDictation | undefined {
            const first = kept[0];

            return first === undefined ? undefined : { ...first };
        },

        /** Forgets the kept dictations. One that listens now is still kept when it ends. */
        clear(): boolean {
            const changed = kept.length > 0;

            kept = [];

            return changed;
        },
    };
}
