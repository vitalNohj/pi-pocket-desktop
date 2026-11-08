/** Saves ordinary downloads of the server's file route, without a renderer bridge call. */
import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { app, shell, type DownloadItem, type Event, type WebContents } from "electron";
import { readFileDownload, saveFilePath } from "./save-file-input";

const paths = new Set<string>();
// Keep the first URL's decision across redirects, including requests that must retain their dialog.
const requests = new Map<number, { url: string; contentsId: number; name: string; failed: boolean } | undefined>();

type Notify = (message: string) => void;

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The session's will-download hook calls this; all other downloads keep Electron's save dialog. */
export function saveDownload(
    event: Event,
    item: DownloadItem,
    contents: WebContents,
    serverOrigin: string,
    isServerView: boolean,
    notify: Notify,
): boolean {
    const input = readFileDownload(item.getURLChain()[0], serverOrigin, isServerView, item.getFilename());

    if (input === undefined) {
        return false;
    }

    let path: string;

    try {
        path = saveFilePath(app.getPath("downloads"), input.name, (candidate) => existsSync(candidate) || paths.has(candidate));
    } catch (error) {
        event.preventDefault();
        notify(`Could not save ${input.name}: ${reasonOf(error)}`);

        return true;
    }

    paths.add(path);
    const name = basename(path);
    let ended = false;
    const release = () => {
        paths.delete(path);
        contents.removeListener("destroyed", destroyed);
    };
    const fail = (reason: string, cancel = true) => {
        if (ended) {
            return;
        }

        ended = true;

        if (cancel) {
            try {
                item.cancel();
            } catch {
                // An item Electron already destroyed cannot be cancelled again.
            }
        }

        try {
            rmSync(path, { force: true });
        } catch {
            // The download can already have removed its partial file.
        }

        release();
        notify(`Could not save ${name}: ${reason}`);
    };
    const destroyed = () => fail("the server page closed");

    contents.once("destroyed", destroyed);

    try {
        item.setSavePath(path);
    } catch (error) {
        // preventDefault destroys this item; do not call its methods after that.
        event.preventDefault();
        fail(reasonOf(error), false);

        return true;
    }

    item.once("done", (_event, state) => {
        if (ended) {
            return;
        }

        if (state !== "completed") {
            fail(state === "cancelled" ? "the download was cancelled" : "the download was interrupted", false);

            return;
        }

        ended = true;
        release();

        try {
            shell.showItemInFolder(path);
        } catch (error) {
            // The file was saved even if the file manager could not be opened. Do not remove it.
            notify(`Could not show the saved file: ${reasonOf(error)}`);

            return;
        }

        notify(`Saved ${name} to Downloads`);
    });
    item.on("updated", (_event, state) => {
        if (state === "interrupted") {
            // Cancelling inside Chromium's update notification re-enters its observer list.
            setImmediate(() => fail("the download was interrupted"));
        }
    });

    return true;
}

/** Track a request's first URL and WebContents id, not a pending bridge call. */
export function saveRequestStarted(
    id: number,
    url: string,
    contentsId: number | undefined,
    serverOrigin: string,
    isServerView: boolean,
): void {
    if (requests.has(id)) {
        return;
    }

    const input = readFileDownload(url, serverOrigin, isServerView, "");

    requests.set(id, input === undefined || contentsId === undefined ? undefined : { url, contentsId, name: input.name, failed: false });
}

/** Stop non-2xx responses before Electron can save them. Intermediate redirects may continue. */
export function saveResponse(id: number, status: number, notify: Notify, redirect = false): boolean {
    const request = requests.get(id);

    if (request === undefined || (status >= 200 && status < 300) || redirect) {
        return false;
    }

    if (!request.failed) {
        request.failed = true;
        notify(`Could not save ${request.name}: ${status === 404 ? "the file was not found (404)" : `the server returned HTTP ${status}`}`);
    }

    return true;
}

/** The request ended; the DownloadItem owns any later failure and partial-file cleanup. */
export function saveRequestEnded(id: number): void {
    requests.delete(id);
}
