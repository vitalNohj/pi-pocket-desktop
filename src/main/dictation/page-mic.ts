/**
 * The mic in Pi Pocket's page, pressed for the dictation key: the server page's preload (src/preload/server.ts) finds
 * the mic Alt+V would use (PiP's while it shows, else the session's) and clicks it, so Pi Pocket's own dictation runs and
 * its button shows it. A click, not Alt+V: on a Mac, Pi Pocket takes no Option shortcuts while the caret is in a box.
 */
import { ipcMain, type WebContents } from "electron";

export type PageMicAction = "toggle" | "stop";

/** What the page answered: whether it has a mic to press, and whether that mic was listening before. */
export interface PageMicAnswer {
    found: boolean;
    listening: boolean;
}

/** The page has this long to answer; one that does not has no mic for the key. */
const ANSWER_MS = 400;

export function setUpPageMic(contents: () => WebContents | undefined) {
    let next = 0;
    const waiting = new Map<number, (answer: PageMicAnswer) => void>();

    ipcMain.on("host:dictate-answer", (event, n: unknown, answer: unknown) => {
        const page = contents();

        if (page === undefined || event.sender !== page || event.senderFrame !== page.mainFrame || typeof n !== "number") {
            return;
        }

        const record = typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : {};

        waiting.get(n)?.({ found: record.found === true, listening: record.listening === true });
        waiting.delete(n);
    });

    /** Presses the page's mic: `toggle` turns it on or off, `stop` turns it off if it listens. */
    return (action: PageMicAction): Promise<PageMicAnswer> => {
        const page = contents();

        if (page === undefined || page.isDestroyed()) {
            return Promise.resolve({ found: false, listening: false });
        }

        const n = ++next;

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                waiting.delete(n);
                resolve({ found: false, listening: false });
            }, ANSWER_MS);

            waiting.set(n, (answer) => {
                clearTimeout(timer);
                resolve(answer);
            });
            page.send("host:dictate", { n, action });
        });
    };
}
