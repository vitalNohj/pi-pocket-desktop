// Installed 0.2.x apps must still find the old disk-image names after the project rename.
// Run after electron-builder and before uploading release assets. Leave latest-mac.yml unchanged.
import { copyFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const folder = process.argv[2] ?? "release";
const files = new Set(await readdir(folder));
const images = [...files].filter((name) => /^pi-pocket-desktop-.+-mac-(arm64|x64)\.dmg$/.test(name));

if (images.length === 0) {
    throw new Error("No Pi Pocket Desktop macOS disk images found for compatibility copies.");
}

for (const name of images) {
    const legacy = name.replace(/^pi-pocket-desktop-/, "pi-pocket-gui-");

    await copyFile(join(folder, name), join(folder, legacy));

    if (files.has(`${name}.blockmap`)) {
        await copyFile(join(folder, `${name}.blockmap`), join(folder, `${legacy}.blockmap`));
    }
}
