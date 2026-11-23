import { stat } from "node:fs/promises";
import { win32 } from "node:path";

async function isFile(path: string): Promise<boolean> {
    return stat(path).then((info) => info.isFile(), () => false);
}

/** Pi can use Git Bash in its usual locations, or another bash.exe on PATH. */
export async function missingGitBash(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    fileExists: (path: string) => Promise<boolean> = isFile,
): Promise<boolean> {
    if (platform !== "win32") {
        return false;
    }

    // A copy of the Windows environment is case-sensitive: PATH may be spelled Path.
    const entries = Object.entries(env);
    const get = (name: string) => entries.find(([key, value]) => key.toUpperCase() === name && value)?.[1] ?? "";
    const programFiles = [get("PROGRAMFILES"), get("PROGRAMFILES(X86)"), get("PROGRAMW6432")];
    const folders = [
        ...get("PATH").split(";").map((folder) => folder.trim().replace(/^"(.*)"$/, "$1")),
        ...programFiles.filter(win32.isAbsolute).map((root) => win32.join(root, "Git", "bin")),
        get("LOCALAPPDATA") === "" ? "" : win32.join(get("LOCALAPPDATA"), "Programs", "Git", "bin"),
    ];

    for (const folder of new Set(folders.filter(win32.isAbsolute))) {
        if (await fileExists(win32.join(folder, "bash.exe"))) {
            return false;
        }
    }

    return true;
}
