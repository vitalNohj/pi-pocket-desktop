// A watchdog for the main process, and the diagnostics log it writes to.
//
// The main process owns the window, the tray, and the menus: when its event loop stops, the tray ignores clicks and
// nothing on screen can say why. A worker thread cannot be stopped by that: main writes a heartbeat into shared memory
// every BEAT_MS, and the worker notices when it stays old for STALL_MS. It then appends a line to diagnostics.log with
// the stall's length and the last "activity" main said it started (a server stop, a page load, a tray popup...).
//
// The worker is the only writer of the log: main sends its own lines (page events, server restarts) to it, so main
// never waits on the file, and the lines of a stall still land while main is stuck.

import { Worker } from "node:worker_threads";

/** How often main writes its heartbeat. */
export const BEAT_MS = 500;
/** How long main may go without a heartbeat before the worker logs a stall. */
export const STALL_MS = 3000;
/** How often the worker looks at the heartbeat. */
export const CHECK_MS = 250;
/** The largest the log may grow; past it, the older half goes. */
export const LOG_CAP_BYTES = 1024 * 1024;
/** The longest activity label kept, in bytes. */
const LABEL_BYTES = 240;

/** What the worker remembers between two checks (see stallStep). */
export interface StallState {
    /** When the worker last checked; a much longer gap means the worker itself (or the whole machine) slept. */
    lastCheck: number;
    /** The heartbeat of the stall being reported, or 0 when main is not stalled. */
    stalledBeat: number;
    /** The stall length at which to say "still stalled" next. */
    nextReport: number;
    /** Heartbeats before this moment do not count: the machine slept, and main did not stall. */
    ignoreBefore: number;
}

export type StallEvent =
    | { kind: "stalled"; forMs: number }
    | { kind: "still"; forMs: number }
    | { kind: "ended"; forMs: number };

export function newStallState(now: number): StallState {
    return { lastCheck: now, stalledBeat: 0, nextReport: 0, ignoreBefore: now };
}

/**
 * One look at the heartbeat. `beat` is the last time main wrote it. Reports a stall once when it passes stallMs, again
 * each time its length doubles, and its end with its full length. A sleep of the machine (the worker's own checks stop
 * too) is not a stall: the time before it does not count.
 *
 * This function and appendCapped run inside the worker from their source text (see WORKER_SOURCE): they must use
 * nothing outside their own body.
 */
export function stallStep(state: StallState, now: number, beat: number, stallMs: number): StallEvent | undefined {
    const gap = now - state.lastCheck;

    state.lastCheck = now;

    if (gap > stallMs) {
        // The worker did not run either: the machine slept or was suspended. Start counting again from now.
        state.ignoreBefore = now;

        if (state.stalledBeat !== 0 && beat !== state.stalledBeat) {
            const forMs = beat - state.stalledBeat;

            state.stalledBeat = 0;

            return { kind: "ended", forMs };
        }

        return undefined;
    }

    const since = Math.max(beat, state.ignoreBefore);
    const age = now - since;

    if (state.stalledBeat !== 0) {
        if (beat !== state.stalledBeat) {
            const forMs = Math.max(0, beat - Math.max(state.stalledBeat, state.ignoreBefore));

            state.stalledBeat = 0;

            return { kind: "ended", forMs };
        }

        if (age >= state.nextReport) {
            state.nextReport *= 2;

            return { kind: "still", forMs: age };
        }

        return undefined;
    }

    if (age > stallMs) {
        state.stalledBeat = beat;
        state.nextReport = stallMs * 2;

        return { kind: "stalled", forMs: age };
    }

    return undefined;
}

/** The file system calls appendCapped needs (node:fs, or a fake in tests). */
export interface LogFs {
    appendFileSync(file: string, text: string): void;
    statSync(file: string): { size: number };
    readFileSync(file: string, encoding: "utf8"): string;
    writeFileSync(file: string, text: string): void;
}

/** Appends to the log, and when it grew past cap, keeps only its newest half (from a line start). Never throws. */
export function appendCapped(fs: LogFs, file: string, text: string, cap: number): void {
    try {
        fs.appendFileSync(file, text);

        if (fs.statSync(file).size <= cap) {
            return;
        }

        const all = fs.readFileSync(file, "utf8");
        const tail = all.slice(Math.floor(all.length / 2));
        const start = tail.indexOf("\n");

        fs.writeFileSync(file, start === -1 ? "" : tail.slice(start + 1));
    } catch {
        // A log that cannot be written must not take anything down with it.
    }
}

/** The worker's whole program. It reads the shared heartbeat and writes the log; see the top of this file. */
function watchdogMain(): void {
    // Inside the worker: plain require, from its own context.
    const { parentPort, workerData } = require("node:worker_threads") as typeof import("node:worker_threads");
    const fs = require("node:fs") as typeof import("node:fs");
    const data = workerData as { buffer: SharedArrayBuffer; file: string; stallMs: number; checkMs: number; cap: number; labelBytes: number };
    const times = new BigInt64Array(data.buffer, 0, 2);
    const length = new Int32Array(data.buffer, 16, 1);
    const bytes = new Uint8Array(data.buffer, 20, data.labelBytes);
    const write = (line: string): void => appendCapped(fs, data.file, `${new Date().toISOString()} ${line}\n`, data.cap);
    const label = (): string => {
        const size = Math.min(Atomics.load(length, 0), data.labelBytes);
        const since = Number(Atomics.load(times, 1));
        const text = Buffer.from(bytes.slice(0, size)).toString("utf8");

        return text === "" ? "none" : `"${text}" (started ${((Date.now() - since) / 1000).toFixed(1)} s ago)`;
    };
    const state = newStallState(Date.now());

    parentPort?.on("message", (message: unknown) => {
        if (typeof message === "string") {
            write(message);
        }
    });

    setInterval(() => {
        const event = stallStep(state, Date.now(), Number(Atomics.load(times, 0)), data.stallMs);

        if (event === undefined) {
            return;
        }

        const seconds = (event.forMs / 1000).toFixed(1);

        if (event.kind === "stalled") {
            write(`main process stalled: no heartbeat for ${seconds} s; last activity ${label()}`);
        } else if (event.kind === "still") {
            write(`main process still stalled: ${seconds} s; last activity ${label()}`);
        } else {
            write(`main process stall ended after ${seconds} s`);
        }
    }, data.checkMs);
}

/** The source the worker runs: the functions above, from their compiled text, then a call of watchdogMain. */
export const WORKER_SOURCE = [newStallState, stallStep, appendCapped, watchdogMain].map((fn) => fn.toString()).join("\n\n") + "\n\nwatchdogMain();\n";

interface Running {
    worker: Worker;
    beat: NodeJS.Timeout;
    times: BigInt64Array;
    length: Int32Array;
    bytes: Uint8Array;
}

let running: Running | undefined;
let logFile: string | undefined;

/** Starts the watchdog and the log. Safe to call once; a failure only means no diagnostics. */
export function startDiagnostics(file: string): void {
    if (running !== undefined) {
        return;
    }

    logFile = file;

    try {
        const buffer = new SharedArrayBuffer(20 + LABEL_BYTES);
        const times = new BigInt64Array(buffer, 0, 2);
        const now = BigInt(Date.now());

        Atomics.store(times, 0, now);
        Atomics.store(times, 1, now);

        // eval: the source is a string, so the worker needs no file of its own (none inside the app's asar archive).
        const worker = new Worker(WORKER_SOURCE, {
            eval: true,
            workerData: { buffer, file, stallMs: STALL_MS, checkMs: CHECK_MS, cap: LOG_CAP_BYTES, labelBytes: LABEL_BYTES },
            name: "stall-watchdog",
        });

        // The watchdog must never keep the app from quitting.
        worker.unref();
        worker.on("error", () => undefined);

        const beat = setInterval(() => Atomics.store(times, 0, BigInt(Date.now())), BEAT_MS);

        beat.unref();
        running = { worker, beat, times, length: new Int32Array(buffer, 16, 1), bytes: new Uint8Array(buffer, 20, LABEL_BYTES) };
    } catch {
        running = undefined;
    }
}

/** Says what main starts now, so a stall that follows can name it. Cheap: a few writes into shared memory. */
export function activity(label: string): void {
    if (running === undefined) {
        return;
    }

    const encoded = Buffer.from(label, "utf8").subarray(0, LABEL_BYTES);

    running.bytes.set(encoded);
    Atomics.store(running.times, 1, BigInt(Date.now()));
    Atomics.store(running.length, 0, encoded.length);
}

/** Adds a line to the log (the worker writes it, with the time). */
export function diagnose(line: string): void {
    running?.worker.postMessage(line.replace(/\s+/g, " ").trim());
}

/** Where the log is (undefined before startDiagnostics). */
export function diagnosticsFile(): string | undefined {
    return logFile;
}

export function stopDiagnostics(): void {
    if (running === undefined) {
        return;
    }

    clearInterval(running.beat);
    void running.worker.terminate();
    running = undefined;
}
