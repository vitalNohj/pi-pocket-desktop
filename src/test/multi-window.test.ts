import assert from "node:assert/strict";
import { test } from "node:test";
import { cascadeBounds, isNewWindowKey, mainCloseAction, newWindowMenuItem, quitAfterOtherClosed } from "../main/window/window-rules";
import { dockMenuItems, isNewSessionKey } from "../main/bridge/new-session";
import { NotificationOnce } from "../main/bridge/notification-once";
import { PageDictations } from "../main/dictation/page-dictations";

const key = (fields: Partial<{ key: string; type: string; control: boolean; meta: boolean; alt: boolean; shift: boolean }>) => ({
    key: "n", type: "keyDown", control: false, meta: false, alt: false, shift: true, ...fields,
});

test("New Window uses the platform modifier plus Shift; New Session still refuses Shift", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
        const input = key(platform === "darwin" ? { meta: true } : { control: true });

        assert.equal(isNewWindowKey(input, platform), true);
        assert.equal(isNewWindowKey({ ...input, key: "N" }, platform), true);
        assert.equal(isNewSessionKey(input, platform), false);
        assert.equal(isNewSessionKey({ ...input, shift: false }, platform), true);
        for (const patch of [{ shift: false }, { alt: true }, { type: "keyUp" }, { key: "," }, { meta: true, control: true }]) {
            assert.equal(isNewWindowKey({ ...input, ...patch }, platform), false);
        }
        assert.equal(isNewWindowKey(key(platform === "darwin" ? { control: true } : { meta: true }), platform), false);
    }
});

test("the File item and Dock items have the chosen labels, order, and actions", () => {
    const calls: string[] = [];
    const item = newWindowMenuItem(() => { calls.push("window"); });

    assert.equal(item.label, "New Window");
    assert.equal(item.accelerator, "CommandOrControl+Shift+N");
    (item.click as () => void)();
    const dock = dockMenuItems(() => { calls.push("session"); }, () => { calls.push("window"); });

    assert.deepEqual(dock.map((item) => item.label), ["New Session", "New Window"]);
    for (const item of dock) (item.click as () => void)();
    assert.deepEqual(calls, ["window", "session", "window"]);
});

test("cascade steps 28 px from normal bounds and wraps both coordinates to the same display's work area", () => {
    const work = { x: -1920, y: 40, width: 1920, height: 1040 };
    const bounds = { x: -1800, y: 100, width: 900, height: 700 };
    const next = cascadeBounds(bounds, work);

    assert.deepEqual(next, { ...bounds, x: -1772, y: 128 });
    assert.deepEqual(cascadeBounds(next, work), { ...bounds, x: -1744, y: 156 });
    assert.deepEqual(cascadeBounds({ ...bounds, x: -910 }, work), { ...bounds, x: -1892, y: 68 });
    assert.deepEqual(cascadeBounds({ ...bounds, y: 380 }, work), { ...bounds, x: -1892, y: 68 });
    assert.deepEqual(cascadeBounds({ ...bounds, width: 2100 }, work), { ...bounds, width: 2100, x: -1892, y: 68 });
    assert.deepEqual(bounds, { x: -1800, y: 100, width: 900, height: 700 });
});

test("main close preserves other windows, hides with a tray, minimizes without one, and never blocks Quit", () => {
    for (const closeToTray of [false, true]) for (const otherWindows of [0, 1, 2]) for (const tray of [false, true]) {
        const input = { quitting: false, closeToTray, otherWindows, tray };

        assert.equal(mainCloseAction(input), closeToTray || otherWindows > 0 ? (tray ? "hide" : "minimize") : "close");
        assert.equal(mainCloseAction({ ...input, quitting: true }), "close");
    }
});

test("closing the last other window quits only after the person closed the main window, with close-to-tray off", () => {
    const input = { quitting: false, closeToTray: false, otherWindows: 0, mainClosed: true };

    assert.equal(quitAfterOtherClosed(input), true);
    // The main window is open, minimized, or hidden by the hotkey: the person did not close it.
    assert.equal(quitAfterOtherClosed({ ...input, mainClosed: false }), false);
    assert.equal(quitAfterOtherClosed({ ...input, closeToTray: true }), false);
    assert.equal(quitAfterOtherClosed({ ...input, otherWindows: 1 }), false);
    assert.equal(quitAfterOtherClosed({ ...input, quitting: true }), false);
});

test("notifications from different pages are shown once for 10 seconds, but the same page can repeat", () => {
    const once = new NotificationOnce();
    const notice = { tag: "approval", title: "Allow?", body: "A tool needs you", url: "/?session=one" };

    assert.equal(once.accept(1, notice, 0), true);
    assert.equal(once.accept(2, notice, 1), false);
    assert.equal(once.accept(1, notice, 2), true);
    assert.equal(once.accept(2, notice, 10_001), false);
    assert.equal(once.accept(2, notice, 10_002), true);
    assert.equal(once.accept(3, notice, 10_003), false);
    for (const field of ["tag", "title", "body", "url"] as const) {
        assert.equal(once.accept(3, { ...notice, [field]: notice[field] + " different" }, 10_004), true);
    }
    // Delimiters in fields cannot make two different messages collide.
    assert.equal(once.accept(1, { ...notice, title: "a|b", body: "c" }, 10_005), true);
    assert.equal(once.accept(2, { ...notice, title: "a", body: "b|c" }, 10_006), true);
});

test("page dictation ids are positive and unique, replies keep the page's id, and end frees only that pair", () => {
    const pairs = new PageDictations<object>();
    const first = {}, second = {};
    const one = pairs.start(first, 1);
    const two = pairs.start(second, 1);

    assert.ok(one > 0 && two > 0 && one !== two);
    assert.equal(pairs.find(first, 1), one);
    assert.equal(pairs.find(second, 1), two);
    assert.deepEqual(pairs.get(one), { page: first, pageId: 1 });
    assert.deepEqual(pairs.get(two), { page: second, pageId: 1 });
    assert.equal(pairs.get(-1), undefined);
    assert.equal(pairs.find(first, 2), undefined);
    pairs.end(one);
    assert.equal(pairs.get(one), undefined);
    assert.equal(pairs.find(first, 1), undefined);
    assert.equal(pairs.find(second, 1), two);
    const three = pairs.start(first, 1);

    assert.ok(three > two);
    assert.deepEqual(pairs.forget(first), [three]);
    assert.equal(pairs.find(first, 1), undefined);
    assert.equal(pairs.find(second, 1), two);
});
