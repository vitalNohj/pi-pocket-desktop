import { strict as assert } from "node:assert";
import { test } from "node:test";
import { navigationStep, safeHistoryEntry, serverNavigated, type NavigationState, type NavigationView } from "../main/window/navigation-state";

const reason = { kind: "user", section: "dictation" } as const;
const view: NavigationView = {
    showing: "server",
    canReturn: true,
    reason,
    origin: "https://pocket.example",
    back: { index: 1, url: "https://pocket.example/?session=one" },
    forward: { index: 3, url: "https://pocket.example/?session=two" },
};

test("Back from settings returns to the loaded server and remembers the reason and section", () => {
    const next = navigationStep({}, "back", { ...view, showing: "config" });

    assert.deepEqual(next, { state: { forwardConfig: reason }, action: { kind: "server" } });
});

test("settings cannot go Back without canReturn, or Forward at all", () => {
    for (const direction of ["back", "forward"] as const) {
        assert.deepEqual(navigationStep({}, direction, { ...view, showing: "config", canReturn: false }).action, { kind: "none" });
    }
    assert.deepEqual(navigationStep({}, "forward", { ...view, showing: "config" }).action, { kind: "none" });
});

test("Forward to settings takes precedence over server history and retains the same section", () => {
    const back = navigationStep({}, "back", { ...view, showing: "config" });
    const forward = navigationStep(back.state, "forward", view);

    assert.deepEqual(forward, { state: {}, action: { kind: "config", reason } });
    assert.deepEqual(navigationStep(forward.state, "back", { ...view, showing: "config" }).state, back.state);
});

test("every other reason survives Back and Forward too", () => {
    const failure = { kind: "outage", url: "https://pocket.example/", message: "Stopped" } as const;
    const back = navigationStep({}, "back", { ...view, showing: "config", reason: failure });

    assert.deepEqual(navigationStep(back.state, "forward", view).action, { kind: "config", reason: failure });
});

test("a server navigation clears Forward to settings; Forward then uses server history", () => {
    const state = serverNavigated({ forwardConfig: reason }, { index: 4, url: "https://pocket.example/?sheet=settings" });

    assert.deepEqual(state, {});
    assert.deepEqual(navigationStep(state, "forward", view).action, { kind: "history", direction: "forward" });
});

test("Back and Forward within the server use its browser history", () => {
    for (const direction of ["back", "forward"] as const) {
        const next = navigationStep({}, direction, view);

        assert.deepEqual(next.action, { kind: "history", direction });
        assert.deepEqual(next.state, { pendingHistory: view[direction] });
    }
});

test("an own history navigation keeps Forward to settings, but only until an unrelated navigation", () => {
    const next = navigationStep({ forwardConfig: reason }, "back", view);
    const own = serverNavigated(next.state, view.back!);

    assert.deepEqual(own, { forwardConfig: reason });
    assert.deepEqual(navigationStep(own, "forward", view).action, { kind: "config", reason });
    assert.deepEqual(serverNavigated(own, view.back!), {});
});

test("a concurrent pushState, replaceState, or load is not mistaken for our history step", () => {
    const next = navigationStep({ forwardConfig: reason }, "back", view);

    assert.deepEqual(serverNavigated(next.state, { ...view.back!, index: 4 }), {});
    assert.deepEqual(serverNavigated(next.state, { ...view.back!, url: "https://pocket.example/?session=other" }), {});
});

test("a history step that commits after a settings round trip is still recognized as our own", () => {
    const pending = navigationStep({}, "back", view);
    const back = navigationStep(pending.state, "back", { ...view, showing: "config" });
    const forward = navigationStep(back.state, "forward", view);
    const backAgain = navigationStep(forward.state, "back", { ...view, showing: "config" });

    assert.deepEqual(serverNavigated(backAgain.state, view.back!), { forwardConfig: reason });
});

test("do not start another history step until the first one commits", () => {
    const pending = navigationStep({}, "back", view);

    assert.deepEqual(navigationStep(pending.state, "back", view), { state: pending.state, action: { kind: "none" } });
});

test("nothing happens at either end of server history", () => {
    const { back: _back, forward: _forward, ...empty } = view;

    for (const direction of ["back", "forward"] as const) {
        assert.deepEqual(navigationStep({}, direction, empty), { state: {}, action: { kind: "none" } });
    }
});

test("Back stops before an old login page, including one with a token or a path prefix", () => {
    for (const path of ["/login?token=spent", "/login", "/login/", "/pocket/login?token=spent"]) {
        const back = { index: 0, url: `https://pocket.example${path}` };

        assert.deepEqual(navigationStep({}, "back", { ...view, back }).action, { kind: "none" });
    }
});

test("history never leaves the configured server origin, including about:blank and a former server", () => {
    for (const url of ["about:blank", "https://old.example/", "http://pocket.example/", "https://pocket.example:444/", "not a URL", "data:text/html,old"]) {
        assert.equal(safeHistoryEntry(url, view.origin), false, url);
        assert.deepEqual(navigationStep({}, "back", { ...view, back: { index: 0, url } }).action, { kind: "none" });
        assert.deepEqual(navigationStep({}, "forward", { ...view, forward: { index: 4, url } }).action, { kind: "none" });
    }
    assert.equal(safeHistoryEntry("https://pocket.example/?session=one#sheet", view.origin), true);
    assert.equal(safeHistoryEntry("https://pocket.example/login-help", view.origin), true);
});

test("the rule does not mutate its small state object", () => {
    const state: NavigationState = Object.freeze({ forwardConfig: Object.freeze(reason) });

    navigationStep(state, "forward", view);
    serverNavigated(state, view.back!);
    assert.deepEqual(state, { forwardConfig: reason });
});
