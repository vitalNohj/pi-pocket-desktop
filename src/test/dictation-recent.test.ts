import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createRecent, RECENT_LIMIT } from "../main/dictation/dictation-recent";

/** A clock that ticks one second at each read. */
function clock(): () => number {
    let at = 1_700_000_000_000;

    return () => (at += 1000);
}

test("a dictation is kept with its settled phrases, joined as they are pasted", () => {
    const recent = createRecent(clock());

    assert.equal(recent.start(1), false);
    assert.equal(recent.heard({ id: 1, type: "result", text: "Hello", final: false }), false);
    recent.heard({ id: 1, type: "result", text: " Hello there. ", final: true });
    recent.heard({ id: 1, type: "result", text: "How are", final: false });
    recent.heard({ id: 1, type: "result", text: "How are you?", final: true });
    assert.equal(recent.list().length, 0, "nothing is kept before the end");
    assert.equal(recent.heard({ id: 1, type: "end" }), true);

    const [first] = recent.list();

    assert.equal(first?.text, "Hello there. How are you?");
    assert.equal(first?.where, "pi-pocket");
    assert.equal(first?.error, undefined);
    assert.equal(first?.dropped, undefined);
    assert.equal(recent.last()?.text, "Hello there. How are you?");
});

test("words so far that never settled are not kept", () => {
    const recent = createRecent(clock());

    recent.start(1);
    recent.heard({ id: 1, type: "result", text: "half a phr", final: false });
    assert.equal(recent.heard({ id: 1, type: "end" }), false);
    assert.equal(recent.last(), undefined);
});

test("a dictation that heard nothing is not kept", () => {
    const recent = createRecent(clock());

    recent.start(1);
    recent.heard({ id: 1, type: "result", text: "  ", final: true });
    assert.equal(recent.heard({ id: 1, type: "end" }), false);
    assert.deepEqual(recent.list(), []);
});

test("the app's own dictations (negative ids) are Dictate anywhere's", () => {
    const recent = createRecent(clock());

    recent.start(-1);
    recent.heard({ id: -1, type: "result", text: "Paste me", final: true });
    recent.heard({ id: -1, type: "end" });
    assert.equal(recent.last()?.where, "anywhere");
});

test("an error keeps the words heard before it, with the reason", () => {
    const recent = createRecent(clock());

    recent.start(1);
    recent.heard({ id: 1, type: "result", text: "First phrase.", final: true });
    recent.heard({ id: 1, type: "error", error: "The speech model stopped (code 9)" });
    recent.heard({ id: 1, type: "end" });

    assert.equal(recent.last()?.text, "First phrase.");
    assert.equal(recent.last()?.error, "The speech model stopped (code 9)");
});

test("aborted is no error; a drop of Dictate anywhere is marked", () => {
    const recent = createRecent(clock());

    recent.start(-1);
    recent.heard({ id: -1, type: "result", text: "Oops, Esc.", final: true });
    recent.dropped(-1);
    recent.heard({ id: -1, type: "error", error: "aborted" });
    recent.heard({ id: -1, type: "end" });

    assert.equal(recent.last()?.error, undefined);
    assert.equal(recent.last()?.dropped, true);
});

test("two dictations at once are kept apart", () => {
    const recent = createRecent(clock());

    recent.start(1);
    recent.heard({ id: 1, type: "result", text: "page", final: true });
    recent.start(-1);
    recent.heard({ id: -1, type: "result", text: "anywhere", final: true });
    recent.heard({ id: 1, type: "end" });
    recent.heard({ id: -1, type: "end" });

    assert.deepEqual(
        recent.list().map((each) => each.text),
        ["anywhere", "page"],
    );
});

test("a page that reloads and counts from 1 again ends the old dictation first", () => {
    const recent = createRecent(clock());

    recent.start(1);
    recent.heard({ id: 1, type: "result", text: "before the reload", final: true });
    assert.equal(recent.start(1), true);
    recent.heard({ id: 1, type: "result", text: "after", final: true });
    recent.heard({ id: 1, type: "end" });

    assert.deepEqual(
        recent.list().map((each) => each.text),
        ["after", "before the reload"],
    );
});

test(`only the last ${String(RECENT_LIMIT)} are kept, newest first, each with its own id and time`, () => {
    const recent = createRecent(clock());

    for (let id = 1; id <= RECENT_LIMIT + 2; id++) {
        recent.start(id);
        recent.heard({ id, type: "result", text: `take ${String(id)}`, final: true });
        recent.heard({ id, type: "end" });
    }

    const list = recent.list();

    assert.equal(list.length, RECENT_LIMIT);
    assert.equal(list[0]?.text, `take ${String(RECENT_LIMIT + 2)}`);
    assert.equal(list.at(-1)?.text, "take 3");
    assert.equal(new Set(list.map((each) => each.id)).size, RECENT_LIMIT);
    assert.ok(list.every((each, index) => index === 0 || each.at < list[index - 1]!.at));
});

test("clear forgets the kept dictations, but one that listens is kept when it ends", () => {
    const recent = createRecent(clock());

    recent.start(1);
    recent.heard({ id: 1, type: "result", text: "old", final: true });
    recent.heard({ id: 1, type: "end" });
    recent.start(2);
    recent.heard({ id: 2, type: "result", text: "still talking", final: true });

    assert.equal(recent.clear(), true);
    assert.equal(recent.clear(), false);
    assert.deepEqual(recent.list(), []);

    recent.heard({ id: 2, type: "end" });
    assert.equal(recent.last()?.text, "still talking");
});

test("the list is a copy: changing it changes nothing kept", () => {
    const recent = createRecent(clock());

    recent.start(1);
    recent.heard({ id: 1, type: "result", text: "keep me", final: true });
    recent.heard({ id: 1, type: "end" });
    recent.list()[0]!.text = "changed";
    assert.equal(recent.last()?.text, "keep me");
});
