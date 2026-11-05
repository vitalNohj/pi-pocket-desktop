import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_MS, FinishNotices, groupNotice, isFinish, LISTED, type IdleState, type Notice } from "../main/bridge/notice-group";
import type { HostNotification } from "../shared/types";

function finish(id: number, title = `Session ${id}`): HostNotification {
    return { title: `Pi finished · ${title}`, body: `Answer ${id}`, url: `/s/${id}`, tag: `done-${id}`, urgency: "normal" };
}

/** FinishNotices with a computer whose idle state the test sets, and a timer the test runs. */
function notices(state: IdleState = "active") {
    const shown: Notice[] = [];
    const timers = new Map<number, () => void>();
    let next = 0;
    const computer = { state };
    const group = new FinishNotices({
        idle: () => computer.state,
        show: (notice) => shown.push(notice),
        setTimer: (run, ms) => {
            assert.equal(ms, CHECK_MS);
            timers.set(++next, run);

            return next;
        },
        clearTimer: (timer) => timers.delete(timer as number),
    });
    const tick = () => {
        const runs = [...timers.values()];

        timers.clear();
        runs.forEach((run) => run());
    };

    return { group, shown, timers, computer, tick };
}

test("only a session's finish is grouped: approvals, limits, and untagged notifications are not", () => {
    assert.equal(isFinish(finish(1)), true);
    assert.equal(isFinish({ ...finish(1), title: "Pi stopped with an error · A" }), true);
    const approval = { id: "7", call: "ls", may: true, allow: true };

    assert.equal(isFinish({ ...finish(1), tag: "approval-7", approval }), false);
    assert.equal(isFinish({ ...finish(1), approval }), false);
    assert.equal(isFinish({ ...finish(1), tag: "limit-3" }), false);
    assert.equal(isFinish({ ...finish(1), tag: "" }), false);
});

test("one finish shows as the server wrote it; more show as a count, latest first, and open the latest", () => {
    assert.equal(groupNotice([]), undefined);
    assert.deepEqual(groupNotice([finish(1)]), { title: "Pi finished · Session 1", body: "Answer 1", url: "/s/1" });
    assert.deepEqual(groupNotice([finish(1), { ...finish(2), title: "Pi stopped with an error · Two" }, finish(3)]), {
        title: "3 sessions finished",
        body: "Session 3\nPi stopped with an error · Two\nSession 1",
        url: "/s/3",
    });

    const many = Array.from({ length: LISTED + 2 }, (_, at) => finish(at + 1));
    const notice = groupNotice(many)!;

    assert.equal(notice.title, `${LISTED + 2} sessions finished`);
    assert.equal(notice.body.split("\n").length, LISTED + 1);
    assert.equal(notice.body.split("\n").at(-1), "and 2 more");
});

test("finishes gather in one notification until they are seen; a session that finishes again counts once", () => {
    const { group, shown } = notices();

    group.add(finish(1));
    group.add(finish(2));
    group.add(finish(1, "Session 1 again"));

    assert.deepEqual(shown.map((notice) => notice.title), ["Pi finished · Session 1", "2 sessions finished", "2 sessions finished"]);
    assert.equal(shown.at(-1)!.body, "Session 1 again\nSession 2");
    assert.equal(shown.at(-1)!.url, "/s/1");

    group.seen();
    group.add(finish(3));
    assert.deepEqual(shown.at(-1), { title: "Pi finished · Session 3", body: "Answer 3", url: "/s/3" });
});

test("while the person is away, finishes wait without a banner, and show as one when they are back", () => {
    const { group, shown, timers, computer, tick } = notices("idle");

    group.add(finish(1));
    group.add(finish(2));
    assert.equal(shown.length, 0);
    assert.equal(timers.size, 1, "one check, not one per finish");

    tick();
    assert.equal(shown.length, 0, "still away");
    assert.equal(timers.size, 1);

    computer.state = "active";
    tick();
    assert.deepEqual(shown.map((notice) => notice.title), ["2 sessions finished"]);
    assert.equal(timers.size, 0, "no checks once nothing waits");
});

test("sleep and the lock screen hold finishes, and waking shows them at once", () => {
    const { group, shown, timers } = notices();

    group.asleep(true);
    group.add(finish(1));
    group.add(finish(2));
    group.add(finish(3));
    assert.equal(shown.length, 0);

    group.asleep(false);
    assert.deepEqual(shown.map((notice) => notice.title), ["3 sessions finished"]);
    assert.equal(timers.size, 0);
});

test("waking while the screen is still idle waits for the person; a locked screen counts as away", () => {
    const { group, shown, computer, tick } = notices();

    group.asleep(true);
    group.add(finish(1));
    computer.state = "locked";
    group.asleep(false);
    assert.equal(shown.length, 0);

    computer.state = "active";
    tick();
    assert.equal(shown.length, 1);
});

test("finishes seen in Pi Pocket while held are not shown afterwards", () => {
    const { group, shown, timers, computer, tick } = notices("idle");

    group.add(finish(1));
    group.seen();
    assert.equal(timers.size, 0);

    computer.state = "active";
    tick();
    group.asleep(false);
    assert.equal(shown.length, 0);
    assert.equal(group.size, 0);
});

test("an unknown idle state counts as present: finishes are never held for good", () => {
    const { group, shown } = notices("unknown");

    group.add(finish(1));
    assert.equal(shown.length, 1);
});

test("closing the notification that shows keeps the finishes held after it, also a session that finished again", () => {
    const { group, shown, timers, computer, tick } = notices();

    group.add(finish(1));
    group.add(finish(2));
    assert.equal(shown.at(-1)!.title, "2 sessions finished");

    // The person leaves: these wait, and the notification that shows still lists 1 and 2.
    computer.state = "idle";
    group.add(finish(3));
    group.add(finish(2, "Session 2 again"));
    assert.equal(shown.length, 2);

    // Back, they close it before the next check: only what it listed was seen.
    computer.state = "active";
    group.dismissed();
    assert.equal(group.size, 2);
    assert.equal(timers.size, 1, "the held finishes still wait for their check");

    tick();
    assert.deepEqual(shown.at(-1), { title: "2 sessions finished", body: "Session 2 again\nSession 3", url: "/s/2" });

    group.dismissed();
    assert.equal(group.size, 0);
    assert.equal(timers.size, 0);
});
