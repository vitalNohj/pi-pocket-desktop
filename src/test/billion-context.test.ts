import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INTEGRATION, INTEGRATION_PAGE, LEGACY_INTEGRATION, integrationFiles, blobSha, REMOTE_COMMAND, type TreeEntry } from "../main/billion-context/billion-context";
import { validateSettings } from "../main/core/settings";

const blob = (path: string, mode = "100644"): TreeEntry => ({ path, mode, type: "blob", sha: "0".repeat(40), size: 1 });

test("blobSha is git's hash of a file", () => {
    const folder = mkdtempSync(join(tmpdir(), "bc-"));
    const data = Buffer.from("hello\nworld\n");

    writeFileSync(join(folder, "f"), data);

    const git = execFileSync("git", ["hash-object", join(folder, "f")], { encoding: "utf8" }).trim();

    assert.equal(blobSha(data), git);
    assert.equal(blobSha(Buffer.alloc(0)), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});

test("the integration's files are its new module and helper folder, never settings or legacy files", () => {
    const tree: TreeEntry[] = [
        blob("README.md"),
        blob("package.json"),
        blob("scripts/bundle.mjs"),
        blob(INTEGRATION.settings),
        blob(LEGACY_INTEGRATION.file),
        blob(`${LEGACY_INTEGRATION.folder}/bundle.json`),
        blob(INTEGRATION.file),
        { path: INTEGRATION.folder, mode: "040000", type: "tree", sha: "1".repeat(40) },
        blob(`${INTEGRATION.folder}/bundle.json`),
        blob(`${INTEGRATION.folder}/billion-context-pi-0.1.83/dist/index.js`),
        blob(`${INTEGRATION.folder}-other/x.js`),
    ];

    assert.deepEqual(
        integrationFiles(tree).map((entry) => entry.path),
        [INTEGRATION.file, `${INTEGRATION.folder}/bundle.json`, `${INTEGRATION.folder}/billion-context-pi-0.1.83/dist/index.js`],
    );
});

test("the pinned helper layout is accepted without a bundled runtime", () => {
    const paths = ["runtime-lock.json", "tool-contract.json", "runtime.mjs", "bridge.ts", "index.js"]
        .map((name) => `${INTEGRATION.folder}/${name}`);
    const tree = [blob(INTEGRATION.file), ...paths.map((path) => blob(path))];

    assert.deepEqual(integrationFiles(tree).map((entry) => entry.path), [INTEGRATION.file, ...paths]);
    for (const path of paths) {
        assert.throws(() => integrationFiles(tree.filter((entry) => entry.path !== path)), /missing required files/);
    }
    assert.throws(() => integrationFiles([...tree, blob(`${INTEGRATION.folder}/link`, "120000")]), /not a regular file/);
});

test("a commit without the integration, or with links in it, is refused", () => {
    assert.throws(() => integrationFiles([blob("README.md")]), /missing required files/);
    assert.throws(() => integrationFiles([blob(INTEGRATION.file)]), /missing required files/);
    assert.throws(
        () => integrationFiles([blob(INTEGRATION.file), blob(`${INTEGRATION.folder}/bundle.json`), blob(`${INTEGRATION.folder}/link`, "120000")]),
        /not a regular file/,
    );
    assert.throws(() => integrationFiles([blob(INTEGRATION.file), blob(`${INTEGRATION.folder}/bundle.json`), blob(`${INTEGRATION.folder}/../x`)]), /not a regular file/);
});

test("the remote command uses the renamed repository and refuses legacy installations", () => {
    assert.equal(INTEGRATION.repo, "vitalNohj/billion-context-pi-pocket");
    assert.equal(INTEGRATION_PAGE, "https://github.com/vitalNohj/billion-context-pi-pocket");
    assert.match(REMOTE_COMMAND, /^cd ~\/\.pi-pocket\/extensions && /);
    assert.ok(REMOTE_COMMAND.includes(`codeload.github.com/${INTEGRATION.repo}/tar.gz/main`));
    assert.ok(REMOTE_COMMAND.includes(`${INTEGRATION.folder}-main/${INTEGRATION.file} ${INTEGRATION.folder}-main/${INTEGRATION.folder}`));

    for (const path of Object.values(LEGACY_INTEGRATION)) {
        assert.ok(REMOTE_COMMAND.includes(`[ -e ${path} ]`));
    }
});

test("automatic updates are off unless turned on", () => {
    assert.equal(validateSettings({}).settings.billionContext.autoUpdate, false);
    assert.equal(validateSettings({ billionContext: { autoUpdate: true } }).settings.billionContext.autoUpdate, true);
    assert.equal(validateSettings({ billionContext: { autoUpdate: "yes" } }).problems.length, 1);
});

test("the extension folder stays the running Pi Pocket's until it restarts with a new data folder", async () => {
    const { mkdirSync, symlinkSync, writeFileSync: write } = await import("node:fs");
    const { setUpLocalServer } = await import("../main/local-server/local-server");
    const { defaultSettings } = await import("../main/core/settings");
    const home = mkdtempSync(join(tmpdir(), "bc-local-"));
    const runtime = join(home, "runtimes", "r1");
    const launcher = join(runtime, "lib", "node_modules", "pi-pocket", "bin", "pi-pocket.js");

    mkdirSync(join(runtime, "bin"), { recursive: true });
    mkdirSync(join(launcher, ".."), { recursive: true });
    symlinkSync(process.execPath, join(runtime, "bin", "node"));
    write(join(launcher, "..", "..", "package.json"), JSON.stringify({ version: "1.0.0" }));
    write(launcher, 'console.log("  Sign in  http://127.0.0.1:8787/login?token=t"); setInterval(() => {}, 1000);\n');
    write(join(home, "current.json"), JSON.stringify({ current: { id: "r1", node: "22.19.0" } }));

    const settings = defaultSettings();
    const started = join(home, "data-a");

    settings.local = { ...settings.local, folder: home, data: started };

    let ready!: () => void;
    const isReady = new Promise<void>((done) => (ready = done));
    const local = setUpLocalServer({
        home,
        platform: "linux",
        arch: "x64",
        settings: () => settings,
        fetch: () => Promise.reject(new Error("offline")),
        probe: () => Promise.resolve({ kind: "other", url: "", status: 0, message: "", canOpen: false }),
        changed: () => {},
        ready: () => ready(),
        down: () => {},
        restarted: () => {},
    });

    assert.equal(local.dataFolder(), started);
    await local.start();
    await isReady;

    // Saved, not applied: the running server still uses the first folder.
    settings.local = { ...settings.local, data: join(home, "data-b") };
    assert.equal(local.dataFolder(), started);

    await local.stop();
    assert.equal(local.dataFolder(), join(home, "data-b"));
});
