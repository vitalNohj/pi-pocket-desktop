/**
 * The search path of an environment for a child process, with a folder added. On Windows the variable is named `Path`
 * (any case works for Windows), but a copy of `process.env` is a plain object, where `env.PATH` is undefined and a new
 * `PATH` key sits beside `Path`. Windows then takes one of the two (the first in sort order, `PATH`), and the person's
 * whole path, `C:\Windows\System32` too, is lost. This keeps one key, under the name the environment already used.
 */
export function withPath(
    env: NodeJS.ProcessEnv,
    folder: string,
    where: "first" | "last",
    platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
    const separator = platform === "win32" ? ";" : ":";
    const keys = platform === "win32" ? Object.keys(env).filter((key) => key.toUpperCase() === "PATH") : ["PATH"];
    const name = keys.find((key) => env[key] !== undefined && env[key] !== "") ?? keys[0] ?? "PATH";
    const current = env[name] ?? "";
    const result: NodeJS.ProcessEnv = { ...env };

    for (const key of keys) {
        delete result[key];
    }

    result[name] =
        current === ""
            ? folder
            : where === "first"
              ? `${folder}${separator}${current}`
              : `${current}${separator}${folder}`;

    return result;
}
