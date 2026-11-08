/** Inputs for saving a server file. Kept free of Electron so the rules can be tested on their own. */
import { extname, join } from "node:path";

export interface SaveFileInput {
    url: string;
    name: string;
}

export function readSaveFile(input: unknown): SaveFileInput | undefined {
    if (typeof input !== "object" || input === null) {
        return undefined;
    }

    const { url, name } = input as Record<string, unknown>;

    return typeof url === "string" && /^\/api\/c\/[^/?#]+\/download\?path=/.test(url) && typeof name === "string"
        ? { url, name }
        : undefined;
}

/** Only a download of this server's file, from its own view, may skip the save dialog. */
export function readFileDownload(
    firstUrl: string | undefined,
    serverOrigin: string,
    isServerView: boolean,
    filename: string,
    platform: NodeJS.Platform = process.platform,
): SaveFileInput | undefined {
    if (!isServerView || firstUrl === undefined) {
        return undefined;
    }

    let url: URL;

    try {
        url = new URL(firstUrl);
    } catch {
        return undefined;
    }

    if (url.origin === "null" || url.origin !== serverOrigin) {
        return undefined;
    }

    const fallback = (url.searchParams.get("path") ?? "").split(/[/\\]/).at(-1) ?? "";
    const input = readSaveFile({ url: url.pathname + url.search, name: filename || fallback });

    return input === undefined ? undefined : { ...input, name: saveFileName(input.name, platform) };
}

/** A file name, never a path, a hidden file, or a Windows device/alternate data stream. */
export function saveFileName(name: string, platform: NodeJS.Platform = process.platform): string {
    let safe = name.replace(/[/\\\x00-\x1f\x7f-\x9f]/g, "_").replace(/^\./, "_");

    if (platform === "win32") {
        safe = safe.replace(/[<>:"|?*]/g, "_");
    }

    safe = safe.slice(0, 200);

    if (platform === "win32") {
        // Truncation and trimming can themselves produce a device name. Check their final result.
        safe = safe.replace(/[. ]+$/, "");

        if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])[ ]*(?:\.|$)/i.test(safe)) {
            safe = ("_" + safe).slice(0, 200).replace(/[. ]+$/, "");
        }
    }

    return safe || "download";
}

/** The next unused name, with the count before the last extension. `taken` includes downloads still in progress. */
export function saveFilePath(folder: string, name: string, taken: (path: string) => boolean): string {
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length);
    let path = join(folder, name);
    let count = 0;

    while (taken(path)) {
        count += 1;
        path = join(folder, `${stem} (${count})${extension}`);
    }

    return path;
}
