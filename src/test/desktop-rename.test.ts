import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findFile, parseUpdateInfo, resolveFiles } from "electron-updater/out/providers/Provider";
import { macImage, readRelease, safeFileName } from "../main/updates/update-pick";

const root = join(__dirname, "../..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

test("the project name changes, but installed app identities do not", () => {
    const pkg = JSON.parse(source("package.json"));
    const lock = JSON.parse(source("package-lock.json"));

    assert.equal(pkg.name, "pi-pocket-desktop");
    assert.equal(lock.name, pkg.name);
    assert.equal(lock.packages[""].name, pkg.name);
    assert.equal(pkg.productName, "Pi Pocket");
    assert.equal(pkg.build.productName, "Pi Pocket");
    assert.equal(pkg.build.appId, "io.github.vitalnohj.pipocketgui");
    assert.equal(pkg.build.linux.executableName, "pi-pocket-gui");
    assert.equal(pkg.build.win.executableName, "pi-pocket-gui");
    // Without this override, changing the npm name creates a different Debian package, not an upgrade.
    assert.equal(pkg.build.deb.packageName, "pi-pocket-gui");
    assert.equal(pkg.build.publish[0].repo, "pi-pocket-desktop");
    assert.equal(pkg.build.artifactName, "pi-pocket-desktop-${version}-${os}-${arch}.${ext}");
    assert.equal(pkg.build.win.artifactName, "pi-pocket-desktop-win-${arch}.${ext}");
    assert.match(source("src/main/index.ts"), /process\.env\.PI_POCKET_GUI_USER_DATA/);
    assert.match(source("src/main/index.ts"), /join\(app\.getPath\("appData"\), "pi-pocket-gui"\)/);
    assert.match(source("src/main/core/platform.ts"), /const AUTOSTART_NAME = "pi-pocket-gui\.desktop"/);
    assert.match(source("src/main/core/platform.ts"), /"Icon=pi-pocket-gui"/);
    assert.match(source("src/preload/server.ts"), /kind: "pi-pocket-gui"/);
    assert.match(source("src/main/billion-context/billion-context.ts"), /const MARKER = "\.pi-pocket-gui\.json"/);
});

for (const prefix of ["pi-pocket-gui", "pi-pocket-desktop"]) {
    test(`macOS picks ${prefix} disk images for both architectures, not zips or blockmaps`, () => {
        const name = (arch: string): string => `${prefix}-0.2.38-mac-${arch}.dmg`;
        const release = readRelease({
            tag_name: "v0.2.38",
            html_url: "https://github.com/vitalNohj/pi-pocket-desktop/releases/tag/v0.2.38",
            assets: [
                `${name("arm64")}.blockmap`,
                `${prefix}-0.2.38-mac-arm64.zip`,
                name("x64"),
                name("arm64"),
            ].map((file) => ({ name: file, browser_download_url: `https://downloads.example/${file}`, size: 10 })),
        });

        assert.ok(release);

        for (const arch of ["arm64", "x64"]) {
            const image = macImage(release, arch);

            assert.equal(image?.name, name(arch));
            assert.equal(safeFileName(image!.name), name(arch));
        }

        assert.equal(macImage({ ...release, assets: release.assets.filter((asset) => !asset.name.endsWith(".dmg")) }, "arm64"), undefined);
    });

    for (const [channel, suffix, extension] of [
        ["latest.yml", "win-x64.exe", "exe"],
        ["latest-linux.yml", "0.2.38-linux-x86_64.AppImage", "AppImage"],
        ["latest-mac.yml", "0.2.38-mac-arm64.zip", "zip"],
    ] as const) {
        test(`${channel} selects ${prefix} files by metadata, not by project name`, () => {
            const name = `${prefix}-${suffix}`;
            const checksum = Buffer.alloc(64, 1).toString("base64");
            const yaml = `version: 0.2.38\nfiles:\n  - url: ${name}\n    sha512: ${checksum}\n    size: 123\npath: ${name}\nsha512: ${checksum}\n`;
            // Installed apps still use the old repository URL, which GitHub redirects after the rename.
            const base = new URL("https://github.com/vitalNohj/pi-pocket-gui/releases/download/v0.2.38/");
            const info = parseUpdateInfo(yaml, channel, new URL(channel, base));
            const file = findFile(resolveFiles(info, base), extension);

            assert.equal(file?.url.href, new URL(name, base).href);
            assert.equal(file?.info.sha512, checksum);
            assert.equal(info.path, name);
        });
    }
}

test("the release makes byte-identical legacy macOS images and blockmaps without rewriting metadata", (t) => {
    const folder = mkdtempSync(join(tmpdir(), "desktop-mac-compat-"));

    t.after(() => rmSync(folder, { recursive: true, force: true }));

    const files = [
        "pi-pocket-desktop-0.2.38-mac-arm64.dmg",
        "pi-pocket-desktop-0.2.38-mac-arm64.dmg.blockmap",
        "pi-pocket-desktop-0.2.38-mac-x64.dmg",
        "pi-pocket-desktop-0.2.38-mac-arm64.zip",
        "pi-pocket-desktop-0.2.38-mac-arm64.zip.blockmap",
        "latest-mac.yml",
    ];

    for (const name of files) {
        writeFileSync(join(folder, name), `bytes of ${name}`);
    }

    execFileSync(process.execPath, [join(root, "scripts/mac-update-compat.mjs"), folder]);

    const copies = files.filter((name) => /\.dmg(?:\.blockmap)?$/.test(name));

    for (const name of copies) {
        assert.deepEqual(readFileSync(join(folder, name.replace("pi-pocket-desktop-", "pi-pocket-gui-"))), readFileSync(join(folder, name)));
    }

    assert.deepEqual(readdirSync(folder).sort(), [...files, ...copies.map((name) => name.replace("pi-pocket-desktop-", "pi-pocket-gui-"))].sort());
    assert.equal(readFileSync(join(folder, "latest-mac.yml"), "utf8"), "bytes of latest-mac.yml");
});

test("a release without new macOS images fails instead of silently omitting compatibility copies", (t) => {
    const folder = mkdtempSync(join(tmpdir(), "desktop-mac-compat-empty-"));

    t.after(() => rmSync(folder, { recursive: true, force: true }));
    assert.throws(
        () => execFileSync(process.execPath, [join(root, "scripts/mac-update-compat.mjs"), folder], { stdio: "pipe" }),
        /No Pi Pocket Desktop macOS disk images found/,
    );
});
