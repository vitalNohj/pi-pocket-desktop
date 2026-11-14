/**
 * This computer as a runner: the app runs `pi-pocket runner` (Pi Pocket's docs/runners.md) while it runs, so a Pi
 * Pocket server can run sessions' tools here: files and commands on this computer, the agent and its keys on the
 * server. It is the same runner as on any computer, and the server cannot tell the difference: the person links it in
 * the Runner card with the server's address and a one-time code from its Menu → Runners (`runner link`), the link
 * stays in the app's own folder, and the app starts the runner again when it stops, unless the server ended the link.
 *
 * The app only links, runs, and unlinks it. Who may use this computer, in which folders, and who approves a new one
 * are set on the server (its Menu → Runners): after the link, the runner trusts its server.
 *
 * The runner comes from the Pi Pocket runtime the app installs (src/main/local-server/local-server.ts): one is installed for it
 * when there is none yet, also when the app connects to another server.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunnerState } from "../../shared/types";
import { withPath } from "../core/env-path";
import { cleanLine } from "../local-server/local-versions";

/** `pi-pocket runner`'s exit code when the server ended the link for good: starting it again would not help. */
export const STOPPED_BY_SERVER = 3;
const LOG_LINES = 200;
const STOP_LIMIT_MS = 5000;
/** The most of a command's output the app keeps. */
const OUTPUT_LIMIT = 16000;
/** The most of a failed command's message the card shows. */
const ERROR_LIMIT = 600;

export interface RunnerHost {
    /** Where the link and its log go. */
    home: string;
    platform: NodeJS.Platform;
    /** Whether the person wants it running (the settings' runner.enabled). */
    enabled: () => boolean;
    setEnabled: (enabled: boolean) => Promise<void>;
    /** The installed runtime to run it from; undefined when there is none with the runner. */
    runtime: () => { node: string; launcher: string; bin: string } | undefined;
    /** Install Pi Pocket on this computer, or update it, so a runtime has the runner. */
    prepare: () => Promise<void>;
    environment: () => Promise<NodeJS.ProcessEnv>;
    changed: () => void;
}

/** What the app reads from `runner.json`; both keys stay in the file. */
interface Link {
    server: string;
    id: string;
    name: string;
    /** Made before the runner kept its server's key: that runner refuses it, so this computer must link again. */
    outdated: boolean;
}

/** A line the runner printed, without its time stamp's brackets doubled and without colors. */
function plain(line: string): string {
    return cleanLine(line).trimEnd();
}

/**
 * What a failed runner command said, for the card: the runner's own error, to the end of its paragraph. The launcher
 * may print a warning before it (an old Node.js), and the runner prints its whole help after some errors (an unknown
 * command): neither is a message for a person. Output without the runner's mark gives its first paragraph.
 */
export function runnerError(output: string, code: number | null): string {
    const MARK = "pi-pocket runner: ";
    const all = output.replace(/\r/g, "").split("\n").map(plain);
    const from = all.findIndex((line) => line.startsWith(MARK));
    const kept: string[] = [];

    for (const line of from < 0 ? all : all.slice(from)) {
        if (line.trim() === "") {
            if (kept.length > 0) {
                break;
            }
        } else {
            kept.push(line.startsWith(MARK) ? line.slice(MARK.length) : line);
        }
    }

    const text = kept.join("\n");

    if (text === "") {
        return `The runner stopped with code ${String(code)}.`;
    }

    return text.length > ERROR_LIMIT ? `${text.slice(0, ERROR_LIMIT).trimEnd()}…` : text;
}

/** What the card says for a link that the runner no longer accepts. */
export function outdatedLink(name: string): string {
    return `This link was made by an older Pi Pocket and no longer works. In Pi Pocket, open Menu → Runners, choose Link again on “${name}”, and enter the new code here.`;
}

export function setUpRunner(host: RunnerHost) {
    const linkFile = join(host.home, "runner.json");
    let child: ChildProcess | undefined;
    let status: RunnerState["status"] = "off";
    let message: string | undefined;
    let lines: string[] = [];
    let failures = 0;
    let restartTimer: NodeJS.Timeout | undefined;
    let runningFrom: string | undefined;
    let busy: string | undefined;
    let quitting = false;
    /** A step (linking, unlinking) stopped it on purpose: what it does next is the step's to decide. */
    let holding = false;
    let starting: Promise<void> | undefined;
    let generation = 0;

    const readLink = (): Link | undefined => {
        try {
            const value = JSON.parse(readFileSync(linkFile, "utf8")) as Partial<Link> & { serverKey?: unknown };

            return typeof value.server === "string" && typeof value.id === "string" && typeof value.name === "string"
                ? { server: value.server, id: value.id, name: value.name, outdated: typeof value.serverKey !== "string" }
                : undefined;
        } catch {
            return undefined;
        }
    };

    const set = (next: RunnerState["status"], text?: string) => {
        status = next;
        message = text;
        host.changed();
    };

    const log = (line: string) => {
        lines.push(plain(line));

        if (lines.length > LOG_LINES) {
            lines = lines.slice(-LOG_LINES);
        }
    };

    /** Runs the launcher with these runner arguments to its end: what it printed, or what it said went wrong. */
    const runOnce = async (args: string[]): Promise<string> => {
        const runtime = host.runtime();

        if (runtime === undefined) {
            throw new Error("The runner is not installed on this computer.");
        }

        const env = await host.environment();
        const proc = spawn(runtime.node, [runtime.launcher, "runner", ...args, "--config", linkFile], {
            cwd: homedir(),
            env: { ...env, NO_COLOR: "1" },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });

        return new Promise((done, fail) => {
            let printed = "";
            let problem = "";

            proc.stdout.setEncoding("utf8");
            proc.stderr.setEncoding("utf8");
            proc.stdout.on("data", (chunk: string) => {
                printed = `${printed}${chunk}`.slice(0, OUTPUT_LIMIT);
            });
            // Its error comes first on stderr; anything after it (the help) may be cut.
            proc.stderr.on("data", (chunk: string) => {
                problem = `${problem}${chunk}`.slice(0, OUTPUT_LIMIT);
            });
            proc.on("error", fail);
            proc.on("close", (code) => {
                if (code === 0) {
                    done(printed.split("\n").map(plain).filter(Boolean).join("\n"));
                } else {
                    fail(new Error(runnerError(problem.trim() === "" ? printed : problem, code)));
                }
            });
        });
    };

    const startRunner = async (): Promise<void> => {
        const attempt = generation;

        if (child !== undefined || quitting || holding || !host.enabled()) {
            return;
        }

        const link = readLink();

        if (link === undefined) {
            set("unlinked");

            return;
        }

        // The runner would stop at once, again and again: say what to do instead.
        if (link.outdated) {
            set("ended", outdatedLink(link.name));

            return;
        }

        const runtime = host.runtime();

        if (runtime === undefined) {
            set("failed", "Install or update Pi Pocket under This computer on Home to use the runner.");

            return;
        }

        const env = await host.environment();

        if (attempt !== generation || child !== undefined || quitting || holding || !host.enabled()) {
            return;
        }

        log(`— ${new Date().toISOString()} runner for ${link.server}, as "${link.name}"`);
        set("connecting", `Connecting to ${link.server}…`);

        const proc = spawn(runtime.node, [runtime.launcher, "runner", "start", "--config", linkFile], {
            cwd: homedir(),
            // The person's tools first, as in their terminal; the runtime's Node and npm after.
            env: { ...withPath(env, runtime.bin, "last", host.platform), NO_COLOR: "1", PI_POCKET_DESKTOP_APP: "1" },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });

        child = proc;
        runningFrom = runtime.launcher;

        const onLine = (line: string) => {
            // Lines for a program (`PI-POCKET-ACTIVITY {…}`), not for a person: the app does not use them.
            if (line.startsWith("PI-POCKET-")) {
                return;
            }

            log(line);

            if (child !== proc) {
                return;
            }

            // The runner's own words (Pi Pocket's src/runner/runner.ts): connected, back after a drop, dropped, and
            // why it cannot connect yet.
            if (/\] (Connected|Reconnected) to /.test(line)) {
                failures = 0;
                set("connected");
            } else if (/\] Disconnected/.test(line)) {
                set("connecting", "Reconnecting. Sessions must wait for the server.");
            } else if (/\] Connection error \(/.test(line) && status !== "connected") {
                set("connecting", `Cannot reach the server: ${/\] Connection error \((.*)\)\. /.exec(plain(line))?.[1] ?? "no connection"}.`);
            } else if (/ returned HTTP \d+\. /.test(line) && status !== "connected") {
                set("connecting", plain(line).replace(/^\[[^\]]*\] /, ""));
            }
        };

        readLines(proc.stdout, onLine);
        readLines(proc.stderr, onLine);
        proc.on("error", (error) => log(`Could not start: ${error.message}`));
        proc.on("close", (code, signal) => {
            if (child !== proc) {
                return;
            }

            child = undefined;
            runningFrom = undefined;

            if (quitting || status === "stopping" || !host.enabled()) {
                set(readLink() === undefined ? "unlinked" : "off");

                // Turned on again while it was stopping: start it now, as the setting says.
                if (!quitting && !holding && host.enabled()) {
                    void start();
                }

                return;
            }

            const last = lines.at(-1)?.replace(/^pi-pocket runner: /, "") ?? "";

            if (code === STOPPED_BY_SERVER) {
                set("ended", last || "The server ended this computer's link. Link it again.");

                return;
            }

            failures += 1;
            const wait = Math.min(60, 2 ** Math.min(failures, 6));

            set("failed", `The runner stopped (${signal ?? `code ${String(code)}`}). Restarting in ${String(wait)} s. ${last}`.trim());
            restartTimer = setTimeout(() => void start(), wait * 1000);
        });
    };

    /** Coalesce starts while the link and environment are being read. */
    const start = (): Promise<void> => {
        clearTimeout(restartTimer);
        starting ??= startRunner().finally(() => {
            starting = undefined;
        });

        return starting;
    };

    const stop = async (): Promise<void> => {
        clearTimeout(restartTimer);
        generation += 1;
        await starting;
        const proc = child;

        if (proc === undefined || proc.exitCode !== null) {
            return;
        }

        set("stopping");
        // It says goodbye to the server and stops its daemon; Windows has no SIGTERM, and it ends there at once.
        proc.kill("SIGTERM");

        const timer = setTimeout(() => proc.kill("SIGKILL"), STOP_LIMIT_MS);

        await new Promise<void>((resolve) => {
            if (proc.exitCode !== null || proc.signalCode !== null) {
                resolve();
            } else {
                proc.once("close", () => resolve());
            }
        });
        clearTimeout(timer);
    };

    /** Work that takes a while, one at a time, shown while it runs. */
    const step = async <T>(text: string, work: () => Promise<T>): Promise<T> => {
        if (busy !== undefined) {
            throw new Error(`${busy} Wait for it to end.`);
        }

        busy = text;
        host.changed();

        try {
            return await work();
        } finally {
            busy = undefined;
            host.changed();
        }
    };

    /** The link for the card: where and as what, never a key. */
    const shownLink = (): RunnerState["link"] => {
        const link = readLink();

        return link === undefined ? undefined : { server: link.server, id: link.id, name: link.name };
    };

    return {
        state(): RunnerState {
            const link = shownLink();

            return {
                status,
                ...(message === undefined ? {} : { message }),
                ...(link === undefined ? {} : { link }),
                ...(busy === undefined ? {} : { busy }),
                enabled: host.enabled(),
                available: host.runtime() !== undefined,
                log: lines.slice(-40),
            };
        },
        /** The saved link: which server, and as which computer. */
        link: shownLink,
        /** At the app's start: run it when it is on and linked. */
        boot: (): void => {
            const link = readLink();

            if (link === undefined) {
                set("unlinked");
            } else if (link.outdated) {
                set("ended", outdatedLink(link.name));
            } else if (host.enabled()) {
                void start();
            } else {
                set("off");
            }
        },
        /**
         * Link this computer to `server` with a one-time code from it, then run the runner. Installs or updates Pi
         * Pocket on this computer first when it has no runner. `allowHttp`: the person allows plain HTTP to a server
         * that is not this computer or on their tailnet, for this link; the runner keeps it in the link file.
         */
        linkTo: (server: string, code: string, allowHttp: boolean): Promise<void> =>
            step("Linking this computer…", async () => {
                if (host.runtime() === undefined) {
                    busy = "Installing the runner…";
                    host.changed();
                    await host.prepare();

                    if (host.runtime() === undefined) {
                        throw new Error("The runner is not available. Update Pi Pocket under This computer on Home, then try again.");
                    }
                }

                holding = true;

                try {
                    await stop();
                    await mkdir(host.home, { recursive: true });
                    busy = "Linking this computer…";
                    host.changed();
                    log(await runOnce(["link", server, code, ...(allowHttp ? ["--allow-http"] : [])]));
                    failures = 0;
                    await host.setEnabled(true);
                } finally {
                    // Linked, or not: the link there is now (the new one, or the one before) runs again.
                    holding = false;
                    await start();
                }
            }),
        /** Forget the link; the computer stays listed on the server until removed there. */
        unlink: (): Promise<void> =>
            step("Unlinking…", async () => {
                holding = true;

                try {
                    await stop();
                    await rm(linkFile, { force: true });
                    set("unlinked");
                } finally {
                    holding = false;
                }
            }),
        /** Turn running it on or off (the setting already changed). */
        enabledChanged: (): void => {
            if (host.enabled()) {
                if (status === "ended") {
                    return;
                }

                void start();
            } else {
                void stop().then(() => {
                    if (!host.enabled()) {
                        const link = readLink();

                        if (link === undefined) {
                            set("unlinked");
                        } else if (!link.outdated) {
                            set("off");
                        }
                    } else if (!quitting && !holding) {
                        void start();
                    }
                });
            }
        },
        restart: async (): Promise<void> => {
            await stop();
            failures = 0;
            await start();
        },
        /** The runtimes changed (an update): run from the new one, since the old one goes away. */
        runtimeChanged: (): void => {
            const now = host.runtime()?.launcher;

            if (child !== undefined && now !== undefined && now !== runningFrom) {
                void stop().then(start);
            } else if (child === undefined && status === "failed" && now !== undefined && host.enabled()) {
                void start();
            }
        },
        linked: (): boolean => existsSync(linkFile),
        quit: async (): Promise<void> => {
            quitting = true;
            await stop();
        },
    };
}

function readLines(stream: NodeJS.ReadableStream, listener: (line: string) => void): void {
    let buffer = "";

    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");

        while (newline !== -1) {
            listener(buffer.slice(0, newline).replace(/\r$/, ""));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
        }
    });
    stream.on("end", () => {
        if (buffer !== "") {
            listener(buffer);
        }
    });
}
