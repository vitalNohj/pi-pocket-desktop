import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { appendCapped, newStallState, stallStep, WORKER_SOURCE, type StallEvent } from "../main/stall-watchdog";

const STALL = 3000;

/** Runs the worker's checks every 250 ms from `from` to `to`, with main's heartbeat at `beatAt(now)`. */
function run(from: number, to: number, beatAt: (now: number) => number): Array<{ at: number; event: StallEvent }> {
    const state = newStallState(from);
    const events: Array<{ at: number; event: StallEvent }> = [];

    for (let now = from + 250; now <= to; now += 250) {
        const event = stallStep(state, now, beatAt(now), STALL);

        if (event !== undefined) {
            events.push({ at: now, event });
        }
    }

    return events;
}

/** A heartbeat every 500 ms, except from `stop` to `resume`. */
function beats(stop: number, resume: number): (now: number) => number {
    return (now) => (now >= stop && now < resume ? stop : Math.floor(now / 500) * 500);
}

test("a main process that beats is never reported", () => {
    assert.deepEqual(run(0, 60_000, beats(Infinity, Infinity)), []);
});

test("a stall of 2 s is not reported", () => {
    assert.deepEqual(run(0, 20_000, beats(5000, 7000)), []);
});

test("a stall over 3 s is reported once at 3 s, again as it doubles, and at its end with its length", () => {
    const events = run(0, 30_000, beats(5000, 19_000));

    assert.deepEqual(
        events.map(({ at, event }) => [at, event.kind, event.forMs]),
        [
            [8250, "stalled", 3250],
            [11_000, "still", 6000],
            [17_000, "still", 12_000],
            [19_000, "ended", 14_000],
        ],
    );
});

test("two stalls are two reports", () => {
    const first = beats(2000, 6000);
    const second = beats(10_000, 15_000);
    const events = run(0, 20_000, (now) => (now < 8000 ? first(now) : second(now)));

    assert.deepEqual(
        events.map(({ event }) => event.kind),
        ["stalled", "ended", "stalled", "ended"],
    );
});

test("a sleep of the whole machine (the worker paused too) is not a stall", () => {
    const state = newStallState(0);

    assert.equal(stallStep(state, 250, 0, STALL), undefined);
    // The machine slept for 10 minutes: the worker's next check comes late, and main's heartbeat is old.
    assert.equal(stallStep(state, 600_250, 0, STALL), undefined);
    assert.equal(stallStep(state, 600_500, 0, STALL), undefined);
    // Main beats again right after.
    assert.equal(stallStep(state, 600_750, 600_600, STALL), undefined);
    assert.equal(stallStep(state, 601_000, 600_600, STALL), undefined);
});

test("a stall that goes on after a sleep counts only from the wake", () => {
    const state = newStallState(0);

    stallStep(state, 600_000, 0, STALL);

    assert.equal(stallStep(state, 602_000, 0, STALL), undefined);
    assert.deepEqual(stallStep(state, 603_250, 0, STALL), { kind: "stalled", forMs: 3250 });
});

test("the log keeps its newest half, from a line start, past its cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "stall-log-"));
    const file = join(dir, "diagnostics.log");
    const fs = { appendFileSync, statSync, readFileSync, writeFileSync };

    try {
        for (let index = 0; index < 100; index++) {
            appendCapped(fs, file, `line ${String(index).padStart(3, "0")}\n`, 400);
        }

        const text = readFileSync(file, "utf8");

        assert.ok(Buffer.byteLength(text) <= 400);
        assert.match(text, /^line \d{3}\n/);
        assert.match(text, /line 099\n$/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a log that cannot be written does not throw", () => {
    const fs = {
        appendFileSync: () => {
            throw new Error("read-only");
        },
        statSync: () => ({ size: 0 }),
        readFileSync: () => "",
        writeFileSync: () => undefined,
    };

    assert.doesNotThrow(() => appendCapped(fs, "/nowhere/diagnostics.log", "x\n", 10));
});

test("the worker writes a stall of a blocked thread to the log, with the last activity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stall-worker-"));
    const file = join(dir, "diagnostics.log");
    const labelBytes = 64;
    const buffer = new SharedArrayBuffer(20 + labelBytes);
    const times = new BigInt64Array(buffer, 0, 2);
    const label = Buffer.from("local server: stop", "utf8");

    Atomics.store(times, 0, BigInt(Date.now()));
    Atomics.store(times, 1, BigInt(Date.now()));
    new Uint8Array(buffer, 20, labelBytes).set(label);
    Atomics.store(new Int32Array(buffer, 16, 1), 0, label.length);

    const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { buffer, file, stallMs: 300, checkMs: 50, cap: 1024 * 1024, labelBytes },
    });

    try {
        await new Promise((resolve) => worker.once("online", resolve));
        worker.postMessage("page: unresponsive");

        // Block this thread as a stuck main process would: no beat, no timers.
        const until = Date.now() + 700;

        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, until - Date.now());

        // Beat again, and give the worker a moment to see the end.
        Atomics.store(times, 0, BigInt(Date.now()));
        await new Promise((resolve) => setTimeout(resolve, 300));

        const text = readFileSync(file, "utf8");

        assert.match(text, /^\S+Z page: unresponsive$/m);
        assert.match(text, /main process stalled: no heartbeat for \d+\.\d s; last activity "local server: stop" \(started \d+\.\d s ago\)/);
        assert.match(text, /main process stall ended after \d+\.\d s/);
    } finally {
        await worker.terminate();
        rmSync(dir, { recursive: true, force: true });
    }
});
