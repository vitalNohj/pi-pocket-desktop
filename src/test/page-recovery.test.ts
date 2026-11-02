import { strict as assert } from "node:assert";
import { test } from "node:test";
import { HangWatch, lookWithin, PageRecovery, type HangTimers, type PageLook } from "../main/page-recovery";

const STUCK = 15_000;

/** Health ticks every 10 s: [time, server up, look] → the step at each. */
function ticks(recovery: PageRecovery, rows: Array<[number, boolean, PageLook]>): string[] {
    return rows.map(([at, up, look]) => recovery.check(at, up, look));
}

test("a page that leaves the boot screen is never reloaded", () => {
    const recovery = new PageRecovery(STUCK);

    assert.deepEqual(
        ticks(recovery, [
            [0, true, "boot"],
            [10_000, true, "ready"],
            [20_000, true, "ready"],
            [30_000, true, "ready"],
        ]),
        ["none", "none", "none", "none"],
    );
});

test("a page stuck on the boot screen while the server answers is reloaded once, then its renderer is replaced", () => {
    const recovery = new PageRecovery(STUCK);

    assert.deepEqual(
        ticks(recovery, [
            [0, true, "boot"],
            [10_000, true, "boot"],
            [20_000, true, "boot"],
            [30_000, true, "boot"],
            [40_000, true, "silent"],
            [50_000, true, "boot"],
            [60_000, true, "boot"],
            [70_000, true, "boot"],
            [80_000, true, "boot"],
        ]),
        ["none", "none", "reload", "none", "force-reload", "none", "none", "none", "none"],
    );
});

test("a page waiting while the server is down is left alone, and counts again from when it comes back", () => {
    const recovery = new PageRecovery(STUCK);

    assert.deepEqual(
        ticks(recovery, [
            [0, true, "ready"],
            // The server restarts: the page shows the boot screen, rightly.
            [10_000, false, "boot"],
            [20_000, false, "boot"],
            [30_000, false, "boot"],
            // Back: the page has 15 s to leave the boot screen by itself.
            [40_000, true, "boot"],
            [50_000, true, "boot"],
            [60_000, true, "boot"],
        ]),
        ["none", "none", "none", "none", "none", "none", "reload"],
    );
});

test("after both steps, a server that goes away and comes back allows them again", () => {
    const recovery = new PageRecovery(STUCK);

    ticks(recovery, [
        [0, true, "boot"],
        [20_000, true, "boot"],
        [40_000, true, "boot"],
    ]);

    assert.deepEqual(
        ticks(recovery, [
            [50_000, true, "boot"],
            [60_000, false, "boot"],
            [70_000, true, "boot"],
            [90_000, true, "boot"],
        ]),
        ["none", "none", "none", "reload"],
    );
});

test("a server its launcher restarted counts from the restart", () => {
    const recovery = new PageRecovery(STUCK);

    assert.equal(recovery.check(0, true, "boot"), "none");
    assert.equal(recovery.check(10_000, true, "boot"), "none");
    recovery.serverRestarted(12_000);
    // Stuck from the first look after the restart, not from before it.
    assert.equal(recovery.check(20_000, true, "boot"), "none");
    assert.equal(recovery.check(30_000, true, "boot"), "none");
    assert.equal(recovery.check(35_000, true, "boot"), "reload");
});

test("an empty view (its first load never finished) is reloaded too", () => {
    const recovery = new PageRecovery(STUCK);

    assert.deepEqual(
        ticks(recovery, [
            [0, true, "empty"],
            [10_000, true, "empty"],
            [20_000, true, "empty"],
        ]),
        ["none", "none", "reload"],
    );
});

/** Timers that run only when the test says time passed. */
function fakeTimers(): HangTimers & { advance: (ms: number) => void } {
    let now = 0;
    let next = 0;
    const pending = new Map<number, { at: number; run: () => void }>();

    return {
        set: (run, ms) => {
            next += 1;
            pending.set(next, { at: now + ms, run });

            return next;
        },
        clear: (handle) => {
            pending.delete(handle as number);
        },
        advance: (ms) => {
            now += ms;

            for (const [id, timer] of [...pending]) {
                if (timer.at <= now) {
                    pending.delete(id);
                    timer.run();
                }
            }
        },
    };
}

test("a page that stays unresponsive for 10 s is hung; responsive ends it", () => {
    const timers = fakeTimers();
    const changes: boolean[] = [];
    const watch = new HangWatch((hung) => changes.push(hung), timers, 10_000);

    watch.unresponsive();
    timers.advance(5000);
    // Repeated reports do not restart the wait.
    watch.unresponsive();
    timers.advance(4999);
    assert.equal(watch.hung, false);
    timers.advance(1);
    assert.equal(watch.hung, true);
    watch.unresponsive();
    watch.responsive();
    assert.equal(watch.hung, false);
    assert.deepEqual(changes, [true, false]);
});

test("a page that answers again within 10 s is never hung", () => {
    const timers = fakeTimers();
    const changes: boolean[] = [];
    const watch = new HangWatch((hung) => changes.push(hung), timers, 10_000);

    watch.unresponsive();
    timers.advance(9000);
    watch.responsive();
    timers.advance(60_000);
    assert.equal(watch.hung, false);
    assert.deepEqual(changes, []);
});

test("a look the page does not answer in time is silent; an answer or an error is not", async () => {
    assert.equal(await lookWithin(() => new Promise(() => undefined), 20), "silent");
    assert.equal(await lookWithin(() => Promise.resolve("boot"), 20), "boot");
    assert.equal(await lookWithin(() => Promise.resolve("ready"), 20), "ready");
    assert.equal(await lookWithin(() => Promise.reject(new Error("navigated")), 20), "ready");
});
