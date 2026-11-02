/** Saves requested by the server page, using its own WebContents and sign-in cookie. */
import { existsSync, rmSync } from "node:fs";
import { app, shell, type DownloadItem, type Event, type WebContents } from "electron";
import { readSaveFile, saveFileName, saveFilePath, type SaveFileResult } from "./save-file-input";

interface PendingSave {
    contents: WebContents;
    path: string;
    started: boolean;
    ended: boolean;
    item?: DownloadItem;
    result: Promise<SaveFileResult>;
    finish: (result: SaveFileResult) => void;
    fail: (reason: string) => void;
    startedDownload: () => void;
}

const pending = new Map<string, PendingSave>();
// Request IDs distinguish a late response from a new save of the same URL after a timeout.
const requests = new Map<number, PendingSave>();

/** Called only after the bridge checked the sending frame and origin. */
export function saveFile(input: unknown, contents: WebContents, origin: string): Promise<SaveFileResult> {
    return saveBefore(input, contents, origin, Date.now() + 30_000);
}

async function saveBefore(input: unknown, contents: WebContents, origin: string, deadline: number): Promise<SaveFileResult> {
    const value = readSaveFile(input);

    if (value === undefined) {
        return { ok: false, error: "That is not a file of this server." };
    }

    const name = saveFileName(value.name);
    let url: string;

    try {
        url = new URL(origin + value.url).href;
    } catch {
        return { ok: false, error: "That is not a file of this server." };
    }

    // Two requests for the same URL need distinct items and names. Start the next only after the first ends.
    const previous = pending.get(url);

    if (previous !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finished = await Promise.race([
            previous.result.then(() => true),
            new Promise<false>((done) => { timer = setTimeout(() => done(false), Math.max(1, deadline - Date.now())); }),
        ]);

        clearTimeout(timer);

        if (!finished) {
            return { ok: false, error: `Could not save ${name}: the download did not start within 30 seconds` };
        }

        return saveBefore(input, contents, origin, deadline);
    }

    if (Date.now() >= deadline) {
        return { ok: false, error: `Could not save ${name}: the download did not start within 30 seconds` };
    }

    let path: string;

    try {
        path = saveFilePath(app.getPath("downloads"), name, (candidate) =>
            existsSync(candidate) || Array.from(pending.values()).some((save) => save.path === candidate),
        );
    } catch (error) {
        return { ok: false, error: `Could not save ${name}: ${reasonOf(error)}` };
    }

    let resolve!: (result: SaveFileResult) => void;
    const result = new Promise<SaveFileResult>((done) => { resolve = done; });
    const timer = setTimeout(() => save.fail("the download did not start within 30 seconds"), Math.max(1, deadline - Date.now()));
    const destroyed = () => save.fail("the server page closed");
    const save: PendingSave = {
        contents,
        path,
        started: false,
        ended: false,
        result,
        finish: (answer) => {
            if (pending.get(url) !== save) {
                return;
            }

            save.ended = true;
            clearTimeout(timer);
            contents.removeListener("destroyed", destroyed);
            pending.delete(url);
            resolve(answer);
        },
        fail: (reason) => {
            if (pending.get(url) !== save) {
                return;
            }

            save.finish({ ok: false, error: `Could not save ${name}: ${reason}` });

            if (save.item !== undefined) {
                try {
                    save.item.cancel();
                } catch {
                    // An item Electron already destroyed cannot be cancelled again.
                }

                try {
                    rmSync(path, { force: true });
                } catch {
                    // The download can already have removed its partial file.
                }
            }
        },
        startedDownload: () => clearTimeout(timer),
    };

    pending.set(url, save);
    contents.once("destroyed", destroyed);

    try {
        contents.downloadURL(url);
    } catch (error) {
        save.fail(reasonOf(error));
    }

    return result;
}

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The session's will-download hook calls this first; all other downloads keep Electron's save dialog. */
export function saveDownload(event: Event, item: DownloadItem, contents: WebContents): boolean {
    const save = pending.get(item.getURLChain()[0] ?? item.getURL());

    if (save === undefined || save.contents !== contents || save.started) {
        return false;
    }

    save.started = true;
    save.item = item;
    save.startedDownload();

    try {
        item.setSavePath(save.path);
    } catch (error) {
        // preventDefault destroys this item; do not call its methods after that.
        delete save.item;
        event.preventDefault();
        save.fail(reasonOf(error));

        return true;
    }

    item.once("done", (_event, state) => {
        if (state !== "completed") {
            save.fail(state === "cancelled" ? "the download was cancelled" : "the download was interrupted");

            return;
        }

        try {
            shell.showItemInFolder(save.path);
            save.finish({ ok: true, path: save.path });
        } catch (error) {
            // The file was saved even if the file manager could not be opened. Do not remove it.
            save.finish({ ok: false, error: `Could not show the saved file: ${reasonOf(error)}` });
        }
    });
    item.on("updated", (_event, state) => {
        if (state === "interrupted") {
            save.fail("the download was interrupted");
        }
    });

    return true;
}

/** Associate the network request with this save, not a later save of the same URL. */
export function saveRequestStarted(id: number, url: string, contentsId: number | undefined): void {
    const save = pending.get(url);

    if (save !== undefined && save.contents.id === contentsId && !save.started) {
        requests.set(id, save);
    }
}

/** Stop HTTP errors, or a response after its save timed out, before Electron can save it. */
export function saveResponse(id: number, status: number): boolean {
    const save = requests.get(id);

    if (save === undefined) {
        return false;
    }

    if (save.ended) {
        return true;
    }

    if (save.started || status < 300) {
        return false;
    }

    save.fail(status === 404 ? "the file was not found (404)" : `the server returned HTTP ${status}`);

    return true;
}

/** Release network bookkeeping and report errors that happened before there was a DownloadItem. */
export function saveRequestEnded(id: number, error?: string): void {
    const save = requests.get(id);

    requests.delete(id);

    if (save !== undefined && !save.started && error !== undefined) {
        save.fail(error);
    }
}
