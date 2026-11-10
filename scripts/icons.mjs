// Renders the app's icon PNGs from assets/icon.svg, with a headless Chromium over the DevTools protocol.
//   CHROME=/path/to/chrome node scripts/icons.mjs
//
// The tile gets each system's margin, so it sits as large as the other apps' icons there:
// - icon-mac.png: Apple's icon grid, an 824 px tile on a 1024 px canvas (macOS draws no margin of its own).
// - icon-512.png and icon-192.png (Windows, Linux, notifications): a tile of 90.6% of the canvas.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const assets = resolve(import.meta.dirname, "..", "assets");
const chrome = process.env.CHROME ?? "chromium";
const svg = readFileSync(join(assets, "icon.svg"), "utf8");
const icons = [
    { file: "icon-mac.png", size: 1024, tile: 824 },
    { file: "icon-512.png", size: 512, tile: 464 },
    { file: "icon-192.png", size: 192, tile: 174 },
];

const profile = mkdtempSync(join(tmpdir(), "icons-"));
const browser = spawn(chrome, ["--headless=new", "--remote-debugging-port=9337", `--user-data-dir=${profile}`, "--hide-scrollbars", "about:blank"]);
let targets;

for (let tries = 0; tries < 50 && targets === undefined; tries++) {
    await new Promise((done) => setTimeout(done, 200));
    targets = await fetch("http://127.0.0.1:9337/json/list").then((response) => response.json(), () => undefined);
}

const socket = new WebSocket(targets.find((each) => each.type === "page").webSocketDebuggerUrl);
const pending = new Map();
let id = 0;

socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));

    pending.get(message.id)?.(message.result);
});
await new Promise((done) => socket.addEventListener("open", done));

const send = (method, params = {}) =>
    new Promise((done) => {
        pending.set(++id, done);
        socket.send(JSON.stringify({ id, method, params }));
    });

await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });

for (const icon of icons) {
    const margin = (icon.size - icon.tile) / 2;
    const html = `<!doctype html><body style="margin:0;background:transparent">
        <img src="data:image/svg+xml,${encodeURIComponent(svg)}" style="position:absolute;left:${margin}px;top:${margin}px;width:${icon.tile}px;height:${icon.tile}px">`;

    await send("Emulation.setDeviceMetricsOverride", { width: icon.size, height: icon.size, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `data:text/html,${encodeURIComponent(html)}` });

    for (let tries = 0; tries < 50; tries++) {
        const ready = await send("Runtime.evaluate", { expression: "document.images[0]?.complete === true", returnByValue: true });

        if (ready.result.value === true) {
            break;
        }

        await new Promise((done) => setTimeout(done, 100));
    }

    const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: icon.size, height: icon.size, scale: 1 } });

    writeFileSync(join(assets, icon.file), Buffer.from(shot.data, "base64"));
    console.log(join(assets, icon.file));
}

socket.close();
browser.kill();
