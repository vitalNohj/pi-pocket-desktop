import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { BillionContextState, ExtensionStatus } from "../shared/types";
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

test("automatic installation and updates are on by default and keep an explicit off choice", () => {
    assert.equal(validateSettings({}).settings.billionContext.autoUpdate, true);
    assert.equal(validateSettings({ billionContext: { autoUpdate: false } }).settings.billionContext.autoUpdate, false);
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

/** Run the actual built card renderer with its DOM boundary stubbed. */
function renderCard(patch: Partial<BillionContextState> = {}) {
    const html = readFileSync(join(__dirname, "..", "renderer", "config", "index.html"), "utf8");
    const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1]!, { textContent: "", hidden: false, disabled: false }]));
    const element = (id: string) => {
        const node = nodes.get(id);

        assert.ok(node, `Missing #${id}`);
        return node;
    };
    const source = readFileSync(join(__dirname, "..", "renderer", "config", "main.js"), "utf8");
    const card = source.match(/^function renderBillionContext\(next\) \{[\s\S]*?^\}/m)?.[0];

    assert.ok(card, "The built renderer must contain the card");
    runInNewContext(`${card}\nrenderBillionContext(state);`, {
        element,
        state: { billionContext: {
            server: "running", foreign: false, updateAvailable: false, folder: "/data/extensions", page: INTEGRATION_PAGE, command: REMOTE_COMMAND, ...patch,
        } },
    });
    return { element, html };
}

const cardInstalled = { file: INTEGRATION.file, version: "0.1.83", commit: "a".repeat(40), enabled: true };
const cardStatus = (state: ExtensionStatus["runtime"]["state"], extra: Partial<ExtensionStatus["runtime"]> = {}): ExtensionStatus => ({
    runtime: { state, installed: state === "installed" || state === "legacy", managed: true, version: "0.1.84", busy: false, availableVersion: "0.1.84", updateAvailable: false, host: "linux-x64", ...extra },
    defaultOffBehavior: "Pi Pocket manages context",
});

for (const item of [
    { name: "no files", patch: {}, status: "Not installed", label: "Install", uninstall: false, check: false },
    { name: "module off", patch: { installed: { ...cardInstalled, enabled: false } }, status: "Off in Menu → Extensions", label: "Reinstall", uninstall: false, check: true },
    { name: "installed", patch: { installed: cardInstalled, extension: cardStatus("installed") }, status: "Active · BCP 0.1.84", label: "Reinstall", uninstall: true, check: true },
    { name: "legacy", patch: { installed: cardInstalled, extension: cardStatus("legacy") }, status: "Active · BCP 0.1.84 (bundled copy)", label: "Reinstall", uninstall: true, check: true },
    { name: "uninstalled", patch: { installed: cardInstalled, extension: cardStatus("uninstalled") }, status: "Program uninstalled · Pi Pocket manages context", label: "Install", uninstall: false, check: true },
    { name: "absent", patch: { installed: cardInstalled, extension: cardStatus("absent") }, status: "Program not installed", label: "Install", uninstall: false, check: true },
    { name: "error", patch: { installed: cardInstalled, extension: cardStatus("error", { error: "Download failed" }) }, status: "Needs repair", label: "Reinstall", uninstall: true, check: true },
    { name: "bundled", patch: { installed: { ...cardInstalled, bundled: true } }, status: "Active · BCP 0.1.83 (bundled copy)", label: "Reinstall", uninstall: true, check: true },
    { name: "unavailable pinned status", patch: { installed: cardInstalled }, status: "Program not installed", label: "Reinstall", uninstall: false, check: true },
] satisfies { name: string; patch: Partial<BillionContextState>; status: string; label: string; uninstall: boolean; check: boolean }[]) {
    test(`the card shows the ${item.name} state and only the permitted controls`, () => {
        const card = renderCard(item.patch);

        assert.equal(card.element("bc-status").textContent, item.status);
        assert.equal(card.element("bc-install").textContent, item.label);
        assert.equal(card.element("bc-install").hidden, false);
        assert.equal(card.element("bc-uninstall").hidden, !item.uninstall);
        assert.equal(card.element("bc-check").hidden, !item.check);
        assert.equal(card.element("bc-folder").textContent, "/data/extensions");
        assert.doesNotMatch(card.html, /id="bc-(enable|update|disable)"/);
        assert.match(card.html, />Check for updates<\/button>/);
        assert.match(card.html, /Install and update automatically/);
        if (item.name === "error") assert.equal(card.element("bc-detail").textContent, "Download failed");
    });
}

test("the card keeps foreign-copy instructions without offering an installation", () => {
    const card = renderCard({ foreign: true });

    assert.equal(card.element("bc-status").textContent, "Not installed");
    assert.match(card.element("bc-detail").textContent, /Installed under another name/);
    assert.equal(card.element("bc-install").hidden, true);
});

test("the card shows extension-file and runtime updates on its primary button", () => {
    for (const patch of [
        { updateAvailable: true, latest: { commit: "b".repeat(40), version: "0.1.85" }, extension: cardStatus("installed") },
        { extension: cardStatus("installed", { updateAvailable: true, availableVersion: "0.1.85" }) },
    ]) {
        const card = renderCard({ installed: cardInstalled, ...patch });

        assert.equal(card.element("bc-install").textContent, "Update");
        assert.equal(card.element("bc-detail").textContent, "Update available: BCP 0.1.85");
    }
});

test("the card shows local check times and check errors", () => {
    const extension = cardStatus("installed");

    extension.updates = { checkedAt: 1000, latest: { commit: "a".repeat(40) }, available: false };
    const checked = renderCard({ installed: cardInstalled, extension });

    assert.equal(checked.element("bc-detail").textContent, `Up to date · checked ${new Date(1000).toLocaleString()}`);
    extension.updates.error = "GitHub unavailable";
    assert.equal(renderCard({ installed: cardInstalled, extension }).element("bc-detail").textContent, "GitHub unavailable");
    delete extension.updates.error;
    assert.equal(renderCard({ installed: cardInstalled, extension, message: "Check failed" }).element("bc-detail").textContent, "Check failed");
});

test("the card keeps server-absent, server-stopped, and remote instructions", () => {
    assert.equal(renderCard({ server: "absent" }).element("bc-detail").textContent, "First, install Pi Pocket under This computer on Home.");
    const stopped = renderCard({ server: "stopped" });

    assert.equal(stopped.element("bc-detail").textContent, "Start Pi Pocket before installing or turning on the extension.");
    assert.equal(stopped.element("bc-install").hidden, true);
    const remote = renderCard({ server: "remote" });

    assert.equal(remote.element("bc-local").hidden, true);
    assert.equal(remote.element("bc-remote").hidden, false);
    assert.equal(remote.element("bc-command").textContent, REMOTE_COMMAND);
});
