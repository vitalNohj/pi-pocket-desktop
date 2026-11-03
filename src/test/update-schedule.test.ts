import { strict as assert } from "node:assert";
import { test } from "node:test";
import { UpdateSchedule } from "../main/updates/update-schedule";

/** A schedule that counts its checks. */
function schedule() {
    let checks = 0;
    const updates = new UpdateSchedule(async () => {
        checks++;
    });

    return { updates, checks: () => checks };
}

test("Start or Install from Another server checks once; a second Start, Install, or linked runner does not check again", () => {
    const { updates, checks } = schedule();

    updates.ensure();
    assert.equal(checks(), 1);
    updates.ensure();
    updates.ensure();
    assert.equal(checks(), 1);
});

test("at the app's start in local mode the check runs; a later Start does not check again", () => {
    const { updates, checks } = schedule();

    updates.now();
    updates.ensure();
    assert.equal(checks(), 1);
});

test("opening Settings checks again only while Pi Pocket is kept current", () => {
    const { updates, checks } = schedule();

    // Not installed here, nor started: Settings does not look for its updates.
    updates.settingsOpened();
    assert.equal(checks(), 0);
    updates.ensure();
    updates.settingsOpened();
    updates.settingsOpened();
    assert.equal(checks(), 3);
});

test("Uninstall and quit stop the checks; a later Start checks again", () => {
    const { updates, checks } = schedule();

    updates.ensure();
    updates.stop();
    updates.settingsOpened();
    assert.equal(checks(), 1);
    updates.ensure();
    assert.equal(checks(), 2);
});
