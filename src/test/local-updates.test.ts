import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { defaultSettings } from "../main/core/settings";
import { setUpLocalServer } from "../main/local-server/local-server";
import type { ConfigState, LocalState, LocalUpdate } from "../shared/types";

/** A runtime the app installed, as far as the app looks: a Node.js, Pi Pocket's launcher, and (or not) its runner. */
function runtime(home: string, id: string, options: { runner?: boolean } = {}): void {
    const folder = join(home, "runtimes", id);
    const pocket = join(folder, "lib", "node_modules", "pi-pocket");

    mkdirSync(join(folder, "bin"), { recursive: true });
    mkdirSync(join(pocket, "bin"), { recursive: true });
    symlinkSync(process.execPath, join(folder, "bin", "node"));
    writeFileSync(join(pocket, "package.json"), JSON.stringify({ version: "0.28.0" }));
    writeFileSync(join(pocket, "bin", "pi-pocket.js"), "");

    if (options.runner !== false) {
        mkdirSync(join(pocket, "src", "runner"), { recursive: true });
        writeFileSync(join(pocket, "src", "runner", "main.ts"), "");
    }
}

/**
 * Pi Pocket on a computer that uses another server and has no linked runner, with one runtime installed from commit
 * "aaa". `newest`: the commit the branch is at now; its version number is the same.
 */
function computer(newest: string, options: { keepUpdated?: boolean } = {}) {
    const home = mkdtempSync(join(tmpdir(), "local-updates-"));
    const settings = defaultSettings();
    const asked: string[] = [];
    const seen: LocalUpdate[] = [];

    settings.server = { ...settings.server, mode: "remote" };
    settings.local = { ...settings.local, keepUpdated: options.keepUpdated ?? true };
    runtime(home, "r1");
    writeFileSync(join(home, "current.json"), JSON.stringify({ current: { id: "r1", node: "22.19.0", commit: "aaa" } }));

    const local = setUpLocalServer({
        home,
        platform: "linux",
        arch: "x64",
        settings: () => settings,
        fetch: (url) => {
            asked.push(url);

            if (url.includes("api.github.com")) {
                return Promise.resolve(new Response(JSON.stringify({ sha: newest })));
            }

            if (url.includes("raw.githubusercontent.com")) {
                return Promise.resolve(new Response(JSON.stringify({ version: "0.28.0", engines: { node: ">=22.19" } })));
            }

            if (url.endsWith("/index.json")) {
                return Promise.resolve(new Response(JSON.stringify([{ version: "v22.19.0", lts: "Jod", files: ["linux-x64"] }])));
            }

            // The download of a build: not in these tests.
            return Promise.resolve(new Response("", { status: 404 }));
        },
        probe: () => Promise.resolve({ kind: "other", url: "", status: 0, message: "", canOpen: false }),
        changed: () => {
            seen.push(local.state().update);
        },
        ready: () => {},
        down: () => {},
        restarted: () => {},
        runtimesReplaced: () => Promise.resolve(),
    });

    return { home, local, asked, seen, done: () => rmSync(home, { recursive: true, force: true }) };
}

async function until(check: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (check()) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.fail(`timed out waiting for ${what}`);
}

test("opening Settings looks for a newer Pi Pocket on a computer that uses another server and is not linked", async () => {
    const { local, asked, done } = computer("aaa");

    try {
        // Nothing was started, installed, or linked in this run of the app: Settings alone looks.
        local.settingsOpened();
        await until(() => local.state().update.status === "current", "the check");
        assert.equal(asked.length, 3, "the branch, its package.json, and the Node.js releases");
        assert.deepEqual(local.state().installed, { pocket: "0.28.0", node: "22.19.0", commit: "aaa" });

        // And each time it opens.
        local.settingsOpened();
        await until(() => asked.length === 6 && local.state().update.status === "current", "the second check");
    } finally {
        done();
    }
});

test("a newer commit of the branch is an update, also under the same version number", async () => {
    const { local, seen, done } = computer("bbb");

    try {
        await local.lookForUpdates();

        const building = seen.find((update) => update.status === "building");

        assert.equal(building?.pocket, "0.28.0");
        assert.equal(building?.commit, "bbb", "the commit tells the two builds apart");
        // The download is refused here: the check says so, and the runtime there is stays.
        assert.equal(local.state().update.status, "error");
        assert.match(local.state().update.message ?? "", /nodejs\.org answered HTTP 404/);
        assert.equal(local.state().installed?.commit, "aaa");
        assert.match(local.runnerRuntime()?.launcher ?? "", /r1/);
    } finally {
        done();
    }
});

test("with the checks turned off, only Check now looks", async () => {
    const { local, asked, done } = computer("aaa", { keepUpdated: false });

    try {
        local.settingsOpened();
        await local.lookForUpdates();
        assert.equal(asked.length, 0);
        assert.equal(local.state().update.status, "idle");

        await local.checkUpdates();
        assert.equal(asked.length, 3);
        assert.equal(local.state().update.status, "current");
    } finally {
        done();
    }
});

test("the runner runs from the newest runtime, also one that waits for the server's restart", () => {
    const { home, local, done } = computer("aaa");
    const launcher = (id: string) => join(home, "runtimes", id, "lib", "node_modules", "pi-pocket", "bin", "pi-pocket.js");

    try {
        assert.equal(local.runnerRuntime()?.launcher, launcher("r1"));

        // An update built r2 while the server here ran: the server waits for its restart, the runner does not.
        runtime(home, "r2");
        writeFileSync(
            join(home, "current.json"),
            JSON.stringify({ current: { id: "r1", node: "22.19.0", commit: "aaa" }, next: { id: "r2", node: "22.19.0", commit: "bbb" } }),
        );
        assert.equal(local.runnerRuntime()?.launcher, launcher("r2"));

        // A newer one without the runner: the one that has it.
        runtime(home, "r3", { runner: false });
        writeFileSync(
            join(home, "current.json"),
            JSON.stringify({ current: { id: "r1", node: "22.19.0", commit: "aaa" }, next: { id: "r3", node: "22.19.0", commit: "ccc" } }),
        );
        assert.equal(local.runnerRuntime()?.launcher, launcher("r1"));
    } finally {
        done();
    }
});

/** Run the built Updates card's row for Pi Pocket on this computer, with its DOM boundary stubbed. */
function runtimeRow(local: Partial<LocalState>, keepUpdated = true) {
    const html = readFileSync(join(__dirname, "..", "renderer", "config", "index.html"), "utf8");
    const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1]!, { textContent: "", hidden: false }]));
    const element = (id: string) => {
        const node = nodes.get(id);

        assert.ok(node, `Missing #${id}`);

        return node;
    };
    const source = readFileSync(join(__dirname, "..", "renderer", "config", "main.js"), "utf8");
    const name = source.match(/^function buildName\([\s\S]*?^\}/m)?.[0];
    const row = source.match(/^function renderRuntimeUpdate\(next\) \{[\s\S]*?^\}/m)?.[0];

    assert.ok(name !== undefined && row !== undefined, "The built renderer must contain the row");

    const state = {
        settings: { local: { keepUpdated } },
        local: { status: "stopped", log: [], update: { status: "idle" }, ...local },
    } as unknown as ConfigState;

    runInNewContext(`${name}\n${row}\nrenderRuntimeUpdate(state);`, { element, state });

    return { hidden: element("runtime-update-row").hidden, status: element("runtime-update-status").textContent, detail: element("runtime-update-detail").textContent };
}

test("the Updates card shows Pi Pocket on this computer once it is installed, with the build by its commit", () => {
    assert.equal(runtimeRow({}).hidden, true, "nothing installed: no row");

    const installed = { pocket: "0.28.0", node: "22.19.0", commit: "84f44c8c5127" };
    const current = runtimeRow({ installed, update: { status: "current", checkedAt: 0 } });

    assert.equal(current.hidden, false);
    assert.equal(current.status, "Pi Pocket 0.28.0 (84f44c8) on this computer is up to date");
    assert.match(current.detail, /^The server on this computer and the runner both run from it\. Checked /);

    const building = runtimeRow({ installed, update: { status: "building", pocket: "0.28.0", commit: "bbbbbbbbbbbb", percent: 40, message: "Downloading Node.js 22.19.0…" } });

    assert.equal(building.status, "Installing Pi Pocket 0.28.0 (bbbbbbb)… 40%");
    assert.equal(building.detail, "Downloading Node.js 22.19.0…");

    const ready = runtimeRow({ installed, update: { status: "ready", pocket: "0.28.0", commit: "bbbbbbbbbbbb", checkedAt: 0 } });

    assert.equal(ready.status, "Pi Pocket 0.28.0 (bbbbbbb) is ready");
    assert.match(ready.detail, /^The runner uses it now\. The server on this computer uses it after its restart\./);

    const failed = runtimeRow({ installed, update: { status: "error", message: "api.github.com answered HTTP 403.", checkedAt: 0 } });

    assert.equal(failed.status, "Pi Pocket on this computer could not be updated");
    assert.match(failed.detail, /^api\.github\.com answered HTTP 403\. Checked /);

    assert.match(runtimeRow({ installed }, false).detail, /^Automatic checks are turned off: only Check now looks for a newer one\./);
});
