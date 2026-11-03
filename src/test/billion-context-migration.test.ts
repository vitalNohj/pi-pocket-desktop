import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { INTEGRATION, LEGACY_INTEGRATION, REMOTE_COMMAND, blobSha, legacySettings, setUpBillionContext, type TreeEntry } from "../main/billion-context/billion-context";
import { defaultSettings } from "../main/core/settings";

const COMMIT = "a".repeat(40);
const OLD_COMMIT = "b".repeat(40);
const TRANSACTION = `_${INTEGRATION.folder}.update`;
const MARKER = ".pi-pocket-gui.json";
type Layout = typeof INTEGRATION | typeof LEGACY_INTEGRATION;

function fixture(t: TestContext, layout: "bundled" | "pinned" = "bundled") {
    const home = mkdtempSync(join(tmpdir(), "bc-migrate-"));
    const data = join(home, "data");
    const root = join(data, "extensions");
    const settings = defaultSettings();
    const choices = new Map<string, boolean>();
    const calls: { file: string; enabled: boolean }[] = [];
    const activations: { file: string; settings: unknown }[] = [];
    const errors = new Map<string, string>();
    const faults = { failActivation: 0, corruptDownload: false, offline: false, runtimeStatus: layout === "bundled" ? 404 : 200, runtimeAnswer: { runtime: { installed: true } }, statusState: "missing", statusHttp: 200 };
    const runtimeCalls: unknown[] = [];
    const runtimeRequests: string[] = [];
    let changed = 0;
    let downloads = 0;

    const write = (path: string, value: string) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, value);
    };
    const json = (path: string, value: unknown) => write(path, `${JSON.stringify(value)}\n`);

    mkdirSync(root, { recursive: true });
    json(join(data, "config.json"), { ownerToken: "owner-secret", unrelated: "unchanged" });
    write(join(data, "billion-context-pi", "1.jsonl.acp.json"), "existing checkpoint\n");
    write(join(data, "custom-state", "2.jsonl.acp.json"), "custom checkpoint\n");

    const files: Record<string, string> = {
        [INTEGRATION.file]: "// new integration module\n",
        ...(layout === "bundled" ? {
            [`${INTEGRATION.folder}/bundle.json`]: JSON.stringify({ package: "billion-context-pi", version: "0.1.83" }),
            [`${INTEGRATION.folder}/billion-context-pi-0.1.83/dist/index.js`]: "// bundled runtime\n",
        } : Object.fromEntries(["runtime-lock.json", "tool-contract.json", "runtime.mjs", "bridge.ts", "index.js"]
            .map((name) => [`${INTEGRATION.folder}/${name}`, name === "runtime-lock.json" ? JSON.stringify({ current: "0.1.83" }) : `// ${name}\n`]))),
        [INTEGRATION.settings]: '{"extensionName":"must-not-install","stateDir":"must-not-install"}',
        [LEGACY_INTEGRATION.file]: "// must not copy the legacy module\n",
        "README.md": "not installed\n",
    };
    const archiveRoot = join(home, "archive", "repository-commit");

    for (const [path, content] of Object.entries(files)) {
        write(join(archiveRoot, path), content);
    }

    const archive = execFileSync("tar", ["-czf", "-", "-C", dirname(archiveRoot), "repository-commit"]);
    const tree: TreeEntry[] = Object.entries(files).map(([path, content]) => ({ path, type: "blob", mode: "100644", sha: blobSha(Buffer.from(content)) }));

    const add = (layout: Layout, enabled: boolean, config?: unknown, managed = true) => {
        write(join(root, layout.file), `// original ${layout.file}\n`);
        json(join(root, layout.folder, "bundle.json"), { version: "0.1.82" });
        write(join(root, layout.folder, "old-runtime.js"), "old runtime\n");
        if (managed) json(join(root, layout.folder, MARKER), { commit: OLD_COMMIT });
        if (config !== undefined) json(join(root, layout.settings), config);
        choices.set(layout.file, enabled);
    };
    const listed = () => {
        const modules = [INTEGRATION, LEGACY_INTEGRATION]
            .filter((layout) => existsSync(join(root, layout.file)))
            .map((layout) => ({ file: layout.file, enabled: choices.get(layout.file) === true, ...(errors.has(layout.file) ? { error: errors.get(layout.file)! } : {}) }));
        const active = modules.filter((module) => module.enabled && !readFileSync(join(root, module.file), "utf8").includes("web.onDispose"));

        assert.ok(active.length <= 1, "the installer must never enable 2 real modules");

        return { modules };
    };
    const host = {
        home: join(home, "gui"),
        platform: "linux" as const,
        settings: () => settings,
        dataFolder: () => data,
        local: () => ({ installed: true, url: "http://127.0.0.1:9876" }),
        changed: () => { changed++; },
        fetch: async (url: string) => {
            assert.ok(url.includes(INTEGRATION.repo), `unexpected source: ${url}`);
            if (url.includes("/commits/main")) return new Response(COMMIT);
            if (url.includes("/git/trees/")) {
                return Response.json({ tree: faults.corruptDownload ? tree.map((entry) => ({ ...entry, sha: "0".repeat(40) })) : tree });
            }
            if (url.includes("raw.githubusercontent.com")) {
                if (layout === "pinned") {
                    return url.endsWith("/runtime-lock.json") ? Response.json({ current: "0.1.83" }) : new Response(null, { status: 404 });
                }
                return Response.json({ version: "0.1.83" });
            }
            if (url.includes("codeload.github.com")) {
                downloads++;
                return new Response(archive);
            }
            throw new Error(`Unexpected download: ${url}`);
        },
        request: async (url: string, init: RequestInit) => {
            if (faults.offline) throw new Error("server unavailable");
            const headers = init.headers as Record<string, string>;

            assert.equal(headers.authorization, "Bearer owner-secret");
            assert.equal(headers["x-pocket"], "1");
            if (url.endsWith("/api/x/billion-context-pi-pocket/status")) {
                assert.equal(init.method, "GET");
                runtimeRequests.push("status");
                const activeLayout = choices.get(INTEGRATION.file) === true ? INTEGRATION : LEGACY_INTEGRATION;
                const isLegacy = existsSync(join(root, activeLayout.folder, "bundle.json")) && !existsSync(join(root, activeLayout.folder, "runtime-lock.json"));
                const status = isLegacy ? 404 : faults.statusHttp;

                return Response.json(status === 200 ? { runtime: { state: faults.statusState } } : { error: "status failed" }, { status });
            }
            if (/\/api\/x\/billion-context-pi-pocket\/runtime\/(install|repair)$/.test(url)) {
                assert.equal(init.method, "POST");
                runtimeRequests.push(url.endsWith("/repair") ? "repair" : "install");
                assert.equal(headers["content-type"], "application/json");
                runtimeCalls.push(JSON.parse(init.body as string));
                assert.ok(choices.get(INTEGRATION.file) === true || choices.get(LEGACY_INTEGRATION.file) === true, "runtime setup requires an enabled module");
                return Response.json(faults.runtimeStatus === 200 ? faults.runtimeAnswer : { error: "runtime setup failed" }, { status: faults.runtimeStatus });
            }
            if (init.method === "POST") {
                const file = decodeURIComponent(new URL(url).pathname.slice("/api/extensions/".length));
                const { enabled } = JSON.parse(init.body as string) as { enabled: boolean };

                assert.ok(existsSync(join(root, file)), "Pi Pocket only accepts choices for existing modules");
                calls.push({ file, enabled });
                choices.set(file, enabled); // A failed load still saves the choice, as Pi Pocket does.
                if (!enabled) errors.delete(file);
                if (enabled) {
                    const layout = file === INTEGRATION.file ? INTEGRATION : LEGACY_INTEGRATION;

                    assert.ok(existsSync(join(root, layout.folder)), "the matching helper folder must exist before activation");
                    const config = existsSync(join(root, layout.settings)) ? JSON.parse(readFileSync(join(root, layout.settings), "utf8")) : {};

                    activations.push({ file, settings: config });
                    listed();
                    if (file === INTEGRATION.file && faults.failActivation > 0) {
                        faults.failActivation--;
                        errors.set(file, "new module failed to load");
                        return Response.json({ error: "new module failed to load" }, { status: 500 });
                    }
                }
            }
            return Response.json(listed());
        },
    };
    const integration = setUpBillionContext(host);

    t.after(() => {
        rmSync(home, { recursive: true, force: true });
    });

    return { home, data, root, settings, choices, calls, activations, runtimeCalls, runtimeRequests, faults, integration, host, add, write, json, layout, changed: () => changed, downloads: () => downloads };
}

function waitForChange(f: ReturnType<typeof fixture>, predicate: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
        const original = f.host.changed;
        const timeout = setTimeout(() => {
            f.host.changed = original;
            reject(new Error("Timed out waiting for installer state"));
        }, 10_000);

        f.host.changed = () => {
            original();
            if (predicate()) {
                clearTimeout(timeout);
                f.host.changed = original;
                resolve();
            }
        };
    });
}

function assertStateUnchanged(f: ReturnType<typeof fixture>) {
    assert.equal(readFileSync(join(f.data, "billion-context-pi", "1.jsonl.acp.json"), "utf8"), "existing checkpoint\n");
    assert.equal(readFileSync(join(f.data, "custom-state", "2.jsonl.acp.json"), "utf8"), "custom checkpoint\n");
    assert.deepEqual(JSON.parse(readFileSync(join(f.data, "config.json"), "utf8")), { ownerToken: "owner-secret", unrelated: "unchanged" });
}

function assertNewOnly(f: ReturnType<typeof fixture>, enabled: boolean) {
    assert.ok(existsSync(join(f.root, INTEGRATION.file)));
    assert.ok(existsSync(join(f.root, INTEGRATION.folder, f.layout === "bundled" ? "bundle.json" : "runtime-lock.json")));
    assert.equal(existsSync(join(f.root, LEGACY_INTEGRATION.file)), false);
    assert.equal(existsSync(join(f.root, LEGACY_INTEGRATION.folder)), false);
    assert.equal(existsSync(join(f.root, TRANSACTION)), false);
    assert.equal(f.choices.get(INTEGRATION.file), enabled);
    assert.equal(f.integration.state().installed?.file, INTEGRATION.file);
    assert.equal(f.integration.state().installed?.commit, COMMIT);
    assertStateUnchanged(f);
}

test("legacy settings preserve explicit values and unknown fields, and pin only missing defaults", () => {
    assert.deepEqual(legacySettings({}), { extensionName: "billion-context-pi", stateDir: "billion-context-pi" });
    assert.deepEqual(legacySettings({ extensionName: "bcp-adapter", stateDir: "../state", extra: { keep: true } }), {
        extensionName: "bcp-adapter", stateDir: "../state", extra: { keep: true },
    });
    for (const invalid of [null, [], "text", { extensionName: "" }, { stateDir: 1 }, { billionContextPi: false }]) {
        assert.throws(() => legacySettings(invalid), /JSON object|non-empty string/);
    }
});

test("a fresh install uses the renamed repository, module, and helper, and never repository settings", async (t) => {
    const f = fixture(t);

    await f.integration.install();
    assertNewOnly(f, true);
    assert.equal(existsSync(join(f.root, INTEGRATION.settings)), false);
    assert.deepEqual(readdirSync(f.root).sort(), [INTEGRATION.file, INTEGRATION.folder].sort());
    assert.ok(f.changed() > 0);
});

test("fresh pinned install enables the module and installs its runtime with an empty owner request", async (t) => {
    const f = fixture(t, "pinned");

    await f.integration.install();
    assertNewOnly(f, true);
    assert.equal(f.integration.state().installed?.version, "0.1.83");
    assert.equal(f.integration.state().latest?.version, "0.1.83");
    assert.deepEqual(f.runtimeRequests, ["status", "install"]);
    assert.deepEqual(f.runtimeCalls, [{}]);
    assert.equal(existsSync(join(f.root, INTEGRATION.folder, "bundle.json")), false);
});

test("the pinned version is only shown for stable numeric versions", async (t) => {
    const f = fixture(t, "pinned");

    f.add(INTEGRATION, false);
    await f.integration.update();
    assert.equal(f.integration.state().installed?.version, "0.1.83");
    for (const current of ["1.2.3-beta", "01.2.3", "1.2", 123, null]) {
        f.json(join(f.root, INTEGRATION.folder, "runtime-lock.json"), { current });
        assert.equal(f.integration.state().installed?.version, "?");
    }
});

test("a bundled install accepts the legacy missing route", async (t) => {
    const f = fixture(t);

    await f.integration.install();
    assertNewOnly(f, true);
    assert.deepEqual(f.runtimeRequests, ["status"]);
    assert.deepEqual(f.runtimeCalls, []);
});

for (const enabled of [true, false]) {
    test(`pinned update preserves the ${enabled ? "enabled" : "disabled"} choice and only sets up when enabled`, async (t) => {
        const f = fixture(t, "pinned");
        const config = { extensionName: "custom", stateDir: "custom-state" };

        f.add(LEGACY_INTEGRATION, enabled, config);
        await f.integration.update();
        assertNewOnly(f, enabled);
        assert.deepEqual(f.runtimeCalls, enabled ? [{}] : []);
        assert.deepEqual(f.runtimeRequests, enabled ? ["status", "install"] : []);
        assert.deepEqual(JSON.parse(readFileSync(join(f.root, INTEGRATION.settings), "utf8")), config);
    });
}

test("an error runtime status selects repair before completing an enabled update", async (t) => {
    const f = fixture(t, "pinned");

    f.add(INTEGRATION, true);
    f.faults.statusState = "error";
    await f.integration.update();
    assertNewOnly(f, true);
    assert.deepEqual(f.runtimeRequests, ["status", "repair"]);
    assert.deepEqual(f.runtimeCalls, [{}]);
});

for (const status of [404, 500]) {
    test(`pinned status HTTP ${status} rolls back without runtime setup`, async (t) => {
        const f = fixture(t, "pinned");

        f.add(LEGACY_INTEGRATION, true);
        f.faults.statusHttp = status;
        await assert.rejects(f.integration.update(), /status failed/);
        assert.deepEqual(f.runtimeRequests, ["status"]);
        assert.equal(f.choices.get(LEGACY_INTEGRATION.file), true);
        assert.equal(existsSync(join(f.root, INTEGRATION.file)), false);
        assertStateUnchanged(f);
    });
}

for (const status of [404, 500]) {
    test(`pinned runtime HTTP ${status} rolls back an enabled migration`, async (t) => {
        const f = fixture(t, "pinned");
        const config = { extensionName: "custom", stateDir: "custom-state" };

        f.add(LEGACY_INTEGRATION, true, config);
        f.faults.runtimeStatus = status;
        await assert.rejects(f.integration.update(), /runtime setup failed/);
        assert.equal(f.choices.get(LEGACY_INTEGRATION.file), true);
        assert.equal(existsSync(join(f.root, INTEGRATION.file)), false);
        assert.equal(existsSync(join(f.root, INTEGRATION.settings)), false);
        assert.deepEqual(JSON.parse(readFileSync(join(f.root, LEGACY_INTEGRATION.settings), "utf8")), config);
        assert.equal(existsSync(join(f.root, TRANSACTION)), false);
        assertStateUnchanged(f);
    });
}

test("a missing runtime confirmation rolls back a fresh install", async (t) => {
    const f = fixture(t, "pinned");

    f.faults.runtimeAnswer = { runtime: { installed: false } };
    await assert.rejects(f.integration.install(), /did not confirm/);
    assert.equal(existsSync(join(f.root, INTEGRATION.file)), false);
    assert.equal(existsSync(join(f.root, INTEGRATION.folder)), false);
    assertStateUnchanged(f);
});

test("enabling a disabled pinned update installs its runtime", async (t) => {
    const f = fixture(t, "pinned");

    f.add(INTEGRATION, false);
    await f.integration.update();
    assert.deepEqual(f.runtimeCalls, []);
    await f.integration.enable();
    assert.equal(f.choices.get(INTEGRATION.file), true);
    assert.deepEqual(f.runtimeCalls, [{}]);
});

test("disable and uninstall leave runtime cache and ACP data alone", async (t) => {
    const f = fixture(t, "pinned");
    const cache = join(f.data, "runtime-cache", "installed-runtime");

    f.write(cache, "cached runtime\n");
    await f.integration.install();
    await f.integration.disable();
    assert.equal(readFileSync(cache, "utf8"), "cached runtime\n");
    assertStateUnchanged(f);
    await f.integration.uninstall();
    assert.equal(readFileSync(cache, "utf8"), "cached runtime\n");
    assertStateUnchanged(f);
});

test("runtime setup failure restores the previously enabled current module", async (t) => {
    const f = fixture(t, "pinned");

    f.add(INTEGRATION, true, { extensionName: "custom", stateDir: "custom-state" });
    const original = readFileSync(join(f.root, INTEGRATION.file), "utf8");
    f.faults.runtimeStatus = 500;
    await assert.rejects(f.integration.update(), /runtime setup failed/);
    assert.equal(readFileSync(join(f.root, INTEGRATION.file), "utf8"), original);
    assert.equal(f.choices.get(INTEGRATION.file), true);
    assert.equal(f.integration.state().installed?.commit, OLD_COMMIT);
    assertStateUnchanged(f);
});

test("a failed runtime install on enable restores the disabled choice", async (t) => {
    const f = fixture(t, "pinned");

    f.add(INTEGRATION, false);
    await f.integration.update();
    f.faults.runtimeStatus = 500;
    await assert.rejects(f.integration.enable(), /runtime setup failed/);
    assert.equal(f.choices.get(INTEGRATION.file), false);
    assert.deepEqual(f.calls.slice(-2), [{ file: INTEGRATION.file, enabled: true }, { file: INTEGRATION.file, enabled: false }]);
    assertStateUnchanged(f);
});

for (const enabled of [true, false]) {
    test(`legacy migration preserves the ${enabled ? "enabled" : "disabled"} choice and the stored defaults`, async (t) => {
        const f = fixture(t);

        f.add(LEGACY_INTEGRATION, enabled);
        // A stale choice from an earlier uninstall must not run real code when migration must stay off.
        f.choices.set(INTEGRATION.file, true);
        await f.integration.check();
        assert.equal(f.integration.state().installed?.file, LEGACY_INTEGRATION.file);
        assert.equal(f.integration.state().installed?.enabled, enabled);
        await f.integration.update();
        assertNewOnly(f, enabled);
        assert.deepEqual(JSON.parse(readFileSync(join(f.root, INTEGRATION.settings), "utf8")), { extensionName: "billion-context-pi", stateDir: "billion-context-pi" });
        assert.equal(f.choices.get(LEGACY_INTEGRATION.file), false);
        assert.deepEqual(f.calls[0], { file: LEGACY_INTEGRATION.file, enabled: false });
        assert.equal(f.activations.some((entry) => entry.file === INTEGRATION.file), enabled);
    });
}

for (const absolute of [false, true]) {
    test(`migration copies all settings and keeps the ${absolute ? "absolute" : "relative"} stateDir unchanged`, async (t) => {
        const f = fixture(t);
        const stateDir = absolute ? join(f.home, "external-state") : "custom-state";
        const config = { extensionName: "bcp-adapter", stateDir, billionContextPi: "/legacy/package", extra: { keep: true } };
        const stateFile = join(resolve(f.data, stateDir), "preserved-state.json");
        const savedState = "existing compression state must stay byte-for-byte\n";

        f.add(LEGACY_INTEGRATION, true, config);
        f.write(stateFile, savedState);
        const original = readFileSync(join(f.root, LEGACY_INTEGRATION.settings), "utf8");

        await f.integration.update();
        assertNewOnly(f, true);
        assert.deepEqual(JSON.parse(readFileSync(join(f.root, INTEGRATION.settings), "utf8")), config);
        assert.equal(readFileSync(join(f.root, LEGACY_INTEGRATION.settings), "utf8"), original);
        assert.deepEqual(f.activations.find((entry) => entry.file === INTEGRATION.file)?.settings, config);
        assert.equal(readFileSync(stateFile, "utf8"), savedState);
    });
}

for (const nested of [false, true]) {
    test(`migration preserves state ${nested ? "inside" : "at"} the old deterministic unpack path`, async (t) => {
        const f = fixture(t);
        const previousUnpack = join(f.home, "gui", `unpack-${COMMIT}`);
        const stateDir = nested ? join(previousUnpack, "nested-state") : previousUnpack;
        const stateFile = join(stateDir, "1.jsonl.acp.json");
        const savedState = "compression state in an external unpack path\n";
        const config = { extensionName: "bcp-adapter", stateDir };

        f.add(LEGACY_INTEGRATION, true, config);
        f.write(stateFile, savedState);
        await f.integration.update();
        assertNewOnly(f, true);
        assert.deepEqual(JSON.parse(readFileSync(join(f.root, INTEGRATION.settings), "utf8")), config);
        assert.equal(readFileSync(stateFile, "utf8"), savedState);
        assert.deepEqual(readdirSync(join(f.home, "gui")).filter((name) => name.startsWith("unpack-")), [`unpack-${COMMIT}`]);
    });
}

test("a current installation keeps its settings byte-for-byte and ignores retained old settings", async (t) => {
    const f = fixture(t);
    const config = '{\n  "extensionName": "custom", "stateDir": "custom-state", "extra": [1,2]\n}\n';

    f.add(INTEGRATION, false);
    f.write(join(f.root, INTEGRATION.settings), config);
    f.json(join(f.root, LEGACY_INTEGRATION.settings), { extensionName: "old", stateDir: "old" });
    await f.integration.update();
    assertNewOnly(f, false);
    assert.equal(readFileSync(join(f.root, INTEGRATION.settings), "utf8"), config);
});

test("conflicting settings stop migration before downloads or API changes", async (t) => {
    const f = fixture(t);

    f.add(LEGACY_INTEGRATION, true, { extensionName: "custom-old", stateDir: "custom-state" });
    f.json(join(f.root, INTEGRATION.settings), { extensionName: "custom-new", stateDir: "custom-state" });
    await assert.rejects(f.integration.update(), /settings conflict/);
    assert.equal(f.downloads(), 0);
    assert.deepEqual(f.calls, []);
    assert.ok(existsSync(join(f.root, LEGACY_INTEGRATION.file)));
    assert.equal(f.choices.get(LEGACY_INTEGRATION.file), true);
    assert.match(f.integration.state().message!, /settings conflict/);
    assertStateUnchanged(f);
});

for (const invalid of ["{broken", "null", '{"stateDir": 3}']) {
    test(`an invalid new settings file never falls back to the old file (${invalid})`, async (t) => {
        const f = fixture(t);

        f.add(LEGACY_INTEGRATION, true, { extensionName: "custom", stateDir: "custom-state" });
        f.write(join(f.root, INTEGRATION.settings), invalid);
        await assert.rejects(f.integration.update());
        assert.equal(f.downloads(), 0);
        assert.deepEqual(f.calls, []);
        assert.equal(readFileSync(join(f.root, INTEGRATION.settings), "utf8"), invalid);
        assert.equal(f.choices.get(LEGACY_INTEGRATION.file), true);
    });
}

test("equivalent old and new settings can migrate without dropping unknown fields", async (t) => {
    const f = fixture(t);

    f.add(LEGACY_INTEGRATION, false, { stateDir: "custom-state", extra: { keep: true } });
    f.json(join(f.root, INTEGRATION.settings), { extra: { keep: true }, extensionName: "billion-context-pi", stateDir: "custom-state" });
    await f.integration.update();
    assertNewOnly(f, false);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, INTEGRATION.settings), "utf8")), { stateDir: "custom-state", extra: { keep: true }, extensionName: "billion-context-pi" });
});

test("duplicate module names are detected and never changed automatically", async (t) => {
    const f = fixture(t);

    f.add(LEGACY_INTEGRATION, true);
    f.add(INTEGRATION, false);
    for (const action of [f.integration.install, f.integration.update, f.integration.enable, f.integration.disable, f.integration.uninstall]) {
        await assert.rejects(action(), /Both extension module names exist/);
    }
    assert.match(f.integration.state().installed?.error!, /Both extension module names exist/);
    assert.equal(f.downloads(), 0);
    assert.deepEqual(f.calls, []);
    assert.ok(existsSync(join(f.root, LEGACY_INTEGRATION.file)));
    assert.ok(existsSync(join(f.root, INTEGRATION.file)));
});

for (const layout of [INTEGRATION, LEGACY_INTEGRATION]) {
    test(`an orphan ${layout.folder} helper is a foreign copy, not permission to install`, async (t) => {
        const f = fixture(t);

        f.write(join(f.root, layout.folder, "keep.js"), "user file");
        assert.equal(f.integration.state().foreign, true);
        await assert.rejects(f.integration.install(), /extension copy already exists/);
        assert.equal(readFileSync(join(f.root, layout.folder, "keep.js"), "utf8"), "user file");
        assert.deepEqual(f.calls, []);
    });
}

for (const autoUpdate of [true, false]) {
    test(`serverReady ${autoUpdate ? "migrates" : "only offers an update for"} a GUI-managed legacy installation`, async (t) => {
        const f = fixture(t);

        f.add(LEGACY_INTEGRATION, false, { extensionName: "custom", stateDir: "custom-state" });
        // A repository rename can leave the same commit ID. The old layout still requires migration.
        f.json(join(f.root, LEGACY_INTEGRATION.folder, MARKER), { commit: COMMIT });
        f.settings.billionContext.autoUpdate = autoUpdate;
        const finished = waitForChange(f, () => f.integration.state().latest !== undefined && f.integration.state().busy === undefined);

        f.integration.serverReady();
        await finished;
        if (autoUpdate) {
            assertNewOnly(f, false);
            assert.deepEqual(JSON.parse(readFileSync(join(f.root, INTEGRATION.settings), "utf8")), { extensionName: "custom", stateDir: "custom-state" });
        } else {
            assert.equal(f.integration.state().installed?.file, LEGACY_INTEGRATION.file);
            assert.equal(f.integration.state().updateAvailable, true);
            assert.deepEqual(f.calls, []);
            assert.equal(f.downloads(), 0);
        }
    });
}

test("serverReady does not adopt an unmanaged legacy installation for automatic updates", async (t) => {
    const f = fixture(t);

    f.add(LEGACY_INTEGRATION, true, { extensionName: "custom" }, false);
    f.settings.billionContext.autoUpdate = true;
    const finished = waitForChange(f, () => f.integration.state().installed?.enabled === true && f.integration.state().busy === undefined);

    f.integration.serverReady();
    await finished;
    assert.equal(f.integration.state().installed?.commit, undefined);
    assert.deepEqual(f.calls, []);
    assert.equal(f.downloads(), 0);
});

for (const layout of [INTEGRATION, LEGACY_INTEGRATION]) {
    test(`an invalid primary settings file blocks an update of ${layout.file} without fallback`, async (t) => {
        const f = fixture(t);

        f.add(layout, false);
        f.json(join(f.root, LEGACY_INTEGRATION.settings), { extensionName: "legacy" });
        f.write(join(f.root, layout.settings), "{invalid");
        await assert.rejects(f.integration.update(), /JSON/);
        assert.deepEqual(f.calls, []);
        assert.equal(f.downloads(), 0);
        assert.equal(readFileSync(join(f.root, layout.settings), "utf8"), "{invalid");
    });
}

for (const path of [INTEGRATION.folder, LEGACY_INTEGRATION.folder, TRANSACTION]) {
    test(`state inside ${path} blocks replacement and recovery cleanup without losing files`, async (t) => {
        const f = fixture(t);
        const stateDir = `extensions/${path}/state`;

        f.add(LEGACY_INTEGRATION, true, { stateDir });
        f.write(join(f.data, stateDir, "1.jsonl.acp.json"), "do not delete\n");
        await assert.rejects(f.integration.update(), /configured stateDir is inside|extension copy already exists/);
        await assert.rejects(f.integration.uninstall(), /configured stateDir is inside|extension copy already exists/);
        assert.equal(readFileSync(join(f.data, stateDir, "1.jsonl.acp.json"), "utf8"), "do not delete\n");
        assert.deepEqual(f.calls, []);
        assert.equal(f.downloads(), 0);
    });
}

test("a state path through a linked parent is protected even before its final directory exists", async (t) => {
    const f = fixture(t);
    const alias = join(f.home, "state-alias");

    f.add(LEGACY_INTEGRATION, true, { stateDir: join(alias, "not-created-yet") });
    symlinkSync(join(f.root, LEGACY_INTEGRATION.folder), alias, "dir");
    await assert.rejects(f.integration.update(), /configured stateDir is inside/);
    assert.deepEqual(f.calls, []);
    assert.ok(existsSync(join(f.root, LEGACY_INTEGRATION.folder, "old-runtime.js")));
});

test("the remote command stops before curl when an old settings file exists", (t) => {
    const f = fixture(t);
    const remoteRoot = join(f.home, ".pi-pocket", "extensions");

    f.json(join(remoteRoot, LEGACY_INTEGRATION.settings), { extensionName: "custom" });
    assert.throws(
        () => execFileSync("sh", ["-c", REMOTE_COMMAND], { env: { ...process.env, HOME: f.home }, encoding: "utf8", stdio: "pipe" }),
        (error: unknown) => {
            const result = error as { status: number; stdout: string; stderr: string };

            assert.equal(result.status, 1);
            assert.match(result.stdout, /An existing installation needs manual migration/);
            assert.equal(result.stderr, "");
            return true;
        },
    );
    assert.deepEqual(readdirSync(remoteRoot), [LEGACY_INTEGRATION.settings]);
});

for (const customModule of [undefined, "billion-context-pi.ts"]) {
    test(`the remote command refuses a helper ${customModule === undefined ? "without a module" : "with the live custom module name"}`, (t) => {
        const f = fixture(t);
        const root = join(f.home, ".pi-pocket", "extensions");
        const bin = join(f.home, "bin");
        const config = { extensionName: "bcp-adapter", stateDir: "bcp" };

        f.json(join(root, INTEGRATION.folder, "bundle.json"), { version: "0.1.83" });
        f.json(join(root, INTEGRATION.settings), config);
        if (customModule !== undefined) writeFileSync(join(root, customModule), "// existing custom module\n");
        mkdirSync(bin);
        for (const name of ["curl", "tar"]) {
            writeFileSync(join(bin, name), `#!/bin/sh\nprintf attempted > "$HOME/${name}-ran"\n`, { mode: 0o755 });
        }
        const before = readdirSync(root).sort();

        assert.throws(
            () => execFileSync("sh", ["-c", REMOTE_COMMAND], { env: { ...process.env, HOME: f.home, PATH: `${bin}:${process.env.PATH ?? ""}` }, encoding: "utf8", stdio: "pipe" }),
            (error: unknown) => {
                const result = error as { status: number; stdout: string; stderr: string };

                assert.equal(result.status, 1);
                assert.match(result.stdout, /An existing installation needs manual migration/);
                assert.equal(result.stderr, "");
                return true;
            },
        );
        assert.equal(existsSync(join(f.home, "curl-ran")), false);
        assert.equal(existsSync(join(f.home, "tar-ran")), false);
        assert.deepEqual(readdirSync(root).sort(), before);
        assert.deepEqual(JSON.parse(readFileSync(join(root, INTEGRATION.settings), "utf8")), config);
        if (customModule !== undefined) assert.equal(readFileSync(join(root, customModule), "utf8"), "// existing custom module\n");
    });
}

test("the remote command permits updates with the matching canonical module and helper", (t) => {
    const f = fixture(t);
    const root = join(f.home, ".pi-pocket", "extensions");
    const bin = join(f.home, "bin");

    f.json(join(root, INTEGRATION.folder, "bundle.json"), { version: "0.1.83" });
    writeFileSync(join(root, INTEGRATION.file), "// matching module\n");
    mkdirSync(bin);
    for (const name of ["curl", "tar"]) {
        writeFileSync(join(bin, name), `#!/bin/sh\nprintf attempted > "$HOME/${name}-ran"\n`, { mode: 0o755 });
    }
    execFileSync("sh", ["-c", REMOTE_COMMAND], { env: { ...process.env, HOME: f.home, PATH: `${bin}:${process.env.PATH ?? ""}` }, encoding: "utf8", stdio: "pipe" });
    assert.equal(readFileSync(join(f.home, "curl-ran"), "utf8"), "attempted");
    assert.equal(readFileSync(join(f.home, "tar-ran"), "utf8"), "attempted");
    assert.equal(readFileSync(join(root, INTEGRATION.file), "utf8"), "// matching module\n");
});

test("a failed download leaves the enabled legacy installation and settings untouched", async (t) => {
    const f = fixture(t);

    f.add(LEGACY_INTEGRATION, true, { extensionName: "custom", stateDir: "custom-state" });
    f.faults.corruptDownload = true;
    await assert.rejects(f.integration.update(), /failed verification/);
    assert.deepEqual(f.calls, []);
    assert.equal(f.choices.get(LEGACY_INTEGRATION.file), true);
    assert.equal(existsSync(join(f.root, INTEGRATION.file)), false);
    assert.equal(existsSync(join(f.root, TRANSACTION)), false);
    assertStateUnchanged(f);
});

test("a lost response after disabling the legacy module still restores its enabled choice", async (t) => {
    const f = fixture(t);

    f.add(LEGACY_INTEGRATION, true, { extensionName: "custom", stateDir: "custom-state" });
    const request = f.host.request;
    let lost = false;

    f.host.request = async (url, init) => {
        const response = await request(url, init);

        if (!lost && init.method === "POST") {
            lost = true;
            throw new Error("connection lost after choice saved");
        }
        return response;
    };
    await assert.rejects(f.integration.update(), /connection lost after choice saved/);
    assert.equal(f.choices.get(LEGACY_INTEGRATION.file), true);
    assert.equal(f.integration.state().installed?.commit, OLD_COMMIT);
    assert.equal(existsSync(join(f.root, INTEGRATION.file)), false);
    assert.equal(existsSync(join(f.root, TRANSACTION)), false);
    assertStateUnchanged(f);
});

for (const layout of [LEGACY_INTEGRATION, INTEGRATION]) {
    test(`a failed load restores the previous ${layout.file}, settings, and enabled choice`, async (t) => {
        const f = fixture(t);
        const config = { extensionName: "custom", stateDir: "custom-state" };

        f.add(layout, true, config);
        const original = readFileSync(join(f.root, layout.file), "utf8");
        const settings = readFileSync(join(f.root, layout.settings), "utf8");

        f.faults.failActivation = 1;
        await assert.rejects(f.integration.update(), /new module failed to load/);
        assert.equal(readFileSync(join(f.root, layout.file), "utf8"), original);
        assert.equal(readFileSync(join(f.root, layout.settings), "utf8"), settings);
        assert.equal(f.choices.get(layout.file), true);
        assert.equal(f.integration.state().installed?.commit, OLD_COMMIT);
        if (layout === LEGACY_INTEGRATION) {
            assert.equal(existsSync(join(f.root, INTEGRATION.file)), false);
            assert.equal(existsSync(join(f.root, INTEGRATION.settings)), false);
            assert.equal(f.choices.get(INTEGRATION.file), false);
        }
        assert.equal(existsSync(join(f.root, TRANSACTION)), false);
        assertStateUnchanged(f);
    });
}

for (const layout of [LEGACY_INTEGRATION, INTEGRATION]) {
    test(`enable, disable, and uninstall manage ${layout.file} and retain all user data`, async (t) => {
        const f = fixture(t);
        const config = { extensionName: "custom", stateDir: "custom-state" };

        f.add(layout, false, config);
        await f.integration.enable();
        assert.equal(f.integration.state().installed?.enabled, true);
        await f.integration.disable();
        assert.equal(f.integration.state().installed?.enabled, false);
        await f.integration.uninstall();
        assert.equal(f.integration.state().installed, undefined);
        assert.equal(existsSync(join(f.root, layout.file)), false);
        assert.equal(existsSync(join(f.root, layout.folder)), false);
        assert.deepEqual(JSON.parse(readFileSync(join(f.root, layout.settings), "utf8")), config);
        assertStateUnchanged(f);
        await f.integration.install();
        assertNewOnly(f, true);
        assert.deepEqual(JSON.parse(readFileSync(join(f.root, INTEGRATION.settings), "utf8")), config);
    });
}

test("reinstall prefers new settings over the retained old backup", async (t) => {
    const f = fixture(t);
    const config = { extensionName: "current", stateDir: "custom-state" };

    f.json(join(f.root, INTEGRATION.settings), config);
    f.json(join(f.root, LEGACY_INTEGRATION.settings), { extensionName: "old", stateDir: "old-state" });
    await f.integration.install();
    assertNewOnly(f, true);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, INTEGRATION.settings), "utf8")), config);
});

for (const enabled of [true, false]) {
    test(`an interrupted migration restores the ${enabled ? "enabled" : "disabled"} legacy installation on the next action`, async (t) => {
        const f = fixture(t);
        const config = { extensionName: "custom", stateDir: "custom-state" };
        const recovery = join(f.root, TRANSACTION);

        f.add(LEGACY_INTEGRATION, enabled, config);
        mkdirSync(join(recovery, "saved"), { recursive: true });
        for (const path of [LEGACY_INTEGRATION.file, LEGACY_INTEGRATION.folder]) {
            cpSync(join(f.root, path), join(recovery, "saved", path), { recursive: true });
            rmSync(join(f.root, path), { recursive: true, force: true });
        }
        f.json(join(recovery, "transaction.json"), {
            version: 1, previous: "legacy", wasOn: enabled, committed: false,
            present: [LEGACY_INTEGRATION.file, LEGACY_INTEGRATION.folder],
        });
        f.add(INTEGRATION, true, { extensionName: "incomplete", stateDir: "incomplete-state" });
        f.choices.set(LEGACY_INTEGRATION.file, false);
        await f.integration.check();
        assert.equal(f.integration.state().installed?.file, LEGACY_INTEGRATION.file);
        assert.equal(f.integration.state().installed?.enabled, enabled);
        assert.equal(existsSync(join(f.root, INTEGRATION.file)), false);
        assert.equal(existsSync(join(f.root, INTEGRATION.folder)), false);
        assert.equal(existsSync(join(f.root, INTEGRATION.settings)), false);
        assert.deepEqual(JSON.parse(readFileSync(join(f.root, LEGACY_INTEGRATION.settings), "utf8")), config);
        assert.equal(existsSync(recovery), false);
        assertStateUnchanged(f);
    });
}

test("serverReady recovers an interrupted update before checking for newer code", async (t) => {
    const f = fixture(t);
    const recovery = join(f.root, TRANSACTION);

    f.add(LEGACY_INTEGRATION, false, { extensionName: "custom", stateDir: "custom-state" });
    mkdirSync(join(recovery, "saved"), { recursive: true });
    for (const path of [LEGACY_INTEGRATION.file, LEGACY_INTEGRATION.folder]) {
        cpSync(join(f.root, path), join(recovery, "saved", path), { recursive: true });
        rmSync(join(f.root, path), { recursive: true, force: true });
    }
    f.json(join(recovery, "transaction.json"), {
        version: 1, previous: "legacy", wasOn: false, committed: false,
        present: [LEGACY_INTEGRATION.file, LEGACY_INTEGRATION.folder],
    });
    const finished = waitForChange(f, () => f.integration.state().latest !== undefined && f.integration.state().busy === undefined);

    f.integration.serverReady();
    await finished;
    assert.equal(f.integration.state().installed?.file, LEGACY_INTEGRATION.file);
    assert.equal(f.integration.state().installed?.enabled, false);
    assert.equal(existsSync(recovery), false);
    assertStateUnchanged(f);
});

test("an unavailable server preserves recovery backups until an action can restore them", async (t) => {
    const f = fixture(t);
    const recovery = join(f.root, TRANSACTION);

    f.add(LEGACY_INTEGRATION, false);
    mkdirSync(join(recovery, "saved"), { recursive: true });
    cpSync(join(f.root, LEGACY_INTEGRATION.file), join(recovery, "saved", LEGACY_INTEGRATION.file));
    cpSync(join(f.root, LEGACY_INTEGRATION.folder), join(recovery, "saved", LEGACY_INTEGRATION.folder), { recursive: true });
    f.json(join(recovery, "transaction.json"), {
        version: 1, previous: "legacy", wasOn: false, committed: false,
        present: [LEGACY_INTEGRATION.file, LEGACY_INTEGRATION.folder],
    });
    f.faults.offline = true;
    await assert.rejects(f.integration.check(), /server unavailable/);
    assert.ok(existsSync(join(recovery, "saved", LEGACY_INTEGRATION.file)));
    f.faults.offline = false;
    await f.integration.check();
    assert.equal(existsSync(recovery), false);
    assert.equal(f.integration.state().installed?.enabled, false);
});

test("a committed recovery record only removes backups, never restores the old module", async (t) => {
    const f = fixture(t);
    const recovery = join(f.root, TRANSACTION);

    f.add(INTEGRATION, false, { extensionName: "current" });
    f.json(join(recovery, "transaction.json"), { version: 1, previous: "legacy", wasOn: true, committed: true, present: [] });
    await f.integration.check();
    assert.equal(existsSync(recovery), false);
    assert.equal(existsSync(join(f.root, LEGACY_INTEGRATION.file)), false);
    assert.deepEqual(f.calls, []);
});
