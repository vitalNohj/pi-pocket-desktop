/** Inputs for saving a server file. Kept free of Electron so the rules can be tested on their own. */
import { extname, join } from "node:path";

export interface SaveFileInput {
    url: string;
    name: string;
}

export type SaveFileResult = { ok: true; path: string } | { ok: false; error: string };

export function readSaveFile(input: unknown): SaveFileInput | undefined {
    if (typeof input !== "object" || input === null) {
        return undefined;
    }

    const { url, name } = input as Record<string, unknown>;

    return typeof url === "string" && url.startsWith("/api/c/") && url.includes("/download?path=") && typeof name === "string"
        ? { url, name }
        : undefined;
}

/** A file name, never a path or a hidden file. */
export function saveFileName(name: string): string {
    return name.replace(/[/\\\x00-\x1f\x7f-\x9f]/g, "_").replace(/^\./, "_").slice(0, 200) || "download";
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
