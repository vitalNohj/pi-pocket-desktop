// Drive the installed app's normal first run. DevTools is only enabled for the CI launch.
import { setTimeout as wait } from "node:timers/promises";

const [port, devToolsPort] = process.argv.slice(2);
const server = `http://127.0.0.1:${port}`;
const devTools = `http://127.0.0.1:${devToolsPort}`;
const config = "pocket-gui://app/config/index.html";

const fetchLocal = (url) => fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });

async function evaluate(page, expression) {
    const response = await fetchLocal(`${devTools}/json/list`);
    if (!response.ok) return false;
    const targets = await response.json();
    const target = targets.find((each) => each.type === "page" && page(each.url));
    if (!target?.webSocketDebuggerUrl) return false;

    // Only attach to the runner's loopback DevTools server.
    const { pathname } = new URL(target.webSocketDebuggerUrl);
    const socket = new WebSocket(`ws://127.0.0.1:${devToolsPort}${pathname}`);
    let timer;
    try {
        return await new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 5000);
            socket.addEventListener("error", () => resolve(false), { once: true });
            socket.addEventListener("close", () => resolve(false), { once: true });
            socket.addEventListener("open", () => {
                socket.send(JSON.stringify({
                    id: 1,
                    method: "Runtime.evaluate",
                    params: { expression, awaitPromise: true, returnByValue: true },
                }));
            }, { once: true });
            socket.addEventListener("message", ({ data }) => {
                const reply = JSON.parse(data);
                if (reply.id === 1) resolve(reply.result?.result?.value === true);
            });
        });
    } finally {
        clearTimeout(timer);
        socket.close();
    }
}

async function until(message, seconds, check) {
    const end = Date.now() + seconds * 1000;
    do {
        try {
            if (await check()) return;
        } catch {
            // Connections can fail while the app or the server starts.
        }
        await wait(1000);
    } while (Date.now() < end);
    throw new Error(`${message} within ${seconds} s`);
}

await until("The Install Pi Pocket button did not appear", 60, () => evaluate((url) => url === config, `(() => {
    const install = document.querySelector('button[data-local="install"]');
    if (!install || install.disabled || install.closest('[hidden]')) return false;
    install.click();
    return true;
})()`));
console.log("Clicked Install Pi Pocket on This computer.");

await until("Pi Pocket did not answer HTTP", 240, async () => {
    const response = await fetchLocal(`${server}/api/pocket/info`);
    return response.ok && (await response.json()).name === "pi-pocket";
});
console.log("GET /api/pocket/info answered for Pi Pocket.");

// This view has a fresh profile. Only the launcher's sign-in link can give it an owner session.
// Check the session as the loaded page, not by printing or reading the link or its cookie.
await until("The sign-in link did not sign in as owner", 60, () => evaluate((url) => url.startsWith(`${server}/`), `(async () => {
    if (location.pathname === '/login' || document.readyState === 'loading') return false;
    const response = await fetch('/api/me', { cache: 'no-store' });
    return response.ok && (await response.json()).user?.role === 'owner';
})()`));
console.log("The sign-in link opened a session as owner in the desktop app.");
