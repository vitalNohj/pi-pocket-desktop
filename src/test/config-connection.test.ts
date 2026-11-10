import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { mayConnect } from "../main/connection/connection";
import { defaultSettings } from "../main/core/settings";
import { DEFAULT_THEME } from "../main/window/theme";
import type { ConfigState, ProbeResult } from "../shared/types";

const url = "https://example.com/pocket";
const found: ProbeResult = { kind: "detected", url, bridge: 1, via: "info" };
const apiError: ProbeResult = { kind: "other", url, status: 404, message: "Use the web interface, not an API endpoint.", canOpen: false };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Run the actual built renderer. Only its DOM and IPC boundary are stubbed, not its connection logic. */
async function page(probe: (input: string) => Promise<ProbeResult>, initial: Partial<ConfigState> = {}) {
    let focused: unknown;
    const makeElement = () => ({
        value: "", textContent: "", hidden: false, disabled: false, checked: false, title: "", open: false,
        className: "", type: "", id: "", children: [] as unknown[],
        /** Three lines (60 px) show; the words need a line (20 px) for every 80 characters. */
        clientHeight: 60,
        get scrollHeight(): number { return Math.ceil(String(this.textContent).length / 80) * 20; },
        dataset: {} as Record<string, string>,
        attributes: {} as Record<string, string>,
        classes: new Set<string>(),
        firstElementChild: { style: { width: "" } },
        style: { setProperty() {} },
        classList: { toggle(this: void, _name: string, _force?: boolean) {} },
        scrollIntoView() {}, setAttribute(name: string, value: string) { this.attributes[name] = value; }, removeAttribute(name: string) { delete this.attributes[name]; },
        getAttribute(name: string) { return this.attributes[name] ?? null; },
        focus() { focused = this; },
        listeners: new Map<string, (event: { preventDefault(): void; stopPropagation(): void; key?: string; target?: unknown }) => void>(),
        addEventListener(name: string, listener: (event: { preventDefault(): void; stopPropagation(): void; key?: string; target?: unknown }) => void) { this.listeners.set(name, listener); },
        fire(name: string, key?: string, target?: unknown) {
            let prevented = false;
            this.listeners.get(name)?.({ preventDefault() { prevented = true; }, stopPropagation() {}, ...(key === undefined ? {} : { key }), target });
            return prevented;
        },
        /** Only "button" is understood: the buttons inside, at any depth. */
        querySelectorAll(selector: string): unknown[] {
            if (selector !== "button") return [];
            const found: unknown[] = [];
            const walk = (node: { type?: string; children?: unknown[] }) => {
                for (const child of (node.children ?? []) as { type?: string; children?: unknown[] }[]) {
                    if (child.type === "button") found.push(child);
                    walk(child);
                }
            };
            walk(this);
            return found;
        },
        contains(other: unknown): boolean {
            return (this.children as { contains?: (o: unknown) => boolean }[]).some((child) => child === other || child.contains?.(other) === true);
        },
        append(...children: unknown[]) { this.children.push(...children); },
        replaceChildren(...children: unknown[]) { this.children = children; },
    });
    /** Elements with a classList that keeps its classes, so tests can read them. */
    const withClasses = () => {
        const node = makeElement();
        node.classList = {
            toggle(name: string, force?: boolean) {
                const on = force ?? !node.classes.has(name);
                if (on) node.classes.add(name); else node.classes.delete(name);
            },
        };
        return node;
    };
    const timers: { run: () => void; ms: number }[] = [];
    const selection = { isCollapsed: true };
    let trackFocus = false;
    const html = readFileSync(join(__dirname, "..", "renderer", "config", "index.html"), "utf8");
    const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1]!, withClasses()]));
    const element = (id: string) => { const node = nodes.get(id); assert.ok(node, `Missing #${id}`); return node; };
    const radio = { ...makeElement(), value: "url", checked: true };
    // The one setting input the stub page renders: the dictation key, set by its buttons.
    const keyInput = element("dictation-key");
    keyInput.dataset.key = "dictation.key";
    const parts = { ...makeElement(), value: "parts" };
    const translucent = makeElement(), opacity = makeElement();
    const where = { local: { ...makeElement(), value: "local" }, remote: { ...makeElement(), value: "remote" } };
    // These tests are about another server: remote mode, with this computer's Pi Pocket not installed.
    const remote = defaultSettings();
    remote.server.mode = "remote";
    let state: ConfigState = {
        settings: remote, defaults: defaultSettings(), problems: [], configPath: "/test/config.json",
        reason: { kind: "first-run" }, canReturn: false, recovery: false, trayAvailable: true,
        viewing: "remote", inUse: "remote",
        choices: { local: { label: "Not installed", state: "other" }, remote: { label: "Not connected", state: "checking" } },
        translucency: { kind: "live", blur: "system" }, translucentAtStart: false,
        titleBarAtStart: "seamless", theme: DEFAULT_THEME, platform: "win32", appVersion: "test",
        update: { method: "source", status: "idle" },
        local: { status: "absent", log: [], restartNeeded: false, update: { status: "idle" }, defaults: { folder: "/home/test", data: "/home/test/.pi-pocket" }, home: "/test/server" },
        dictation: { supported: true, status: "idle", engine: { installed: false, size: 11e6 }, folder: "/test/dictation", models: [], downloading: false, recent: [] },
        anywhere: { status: "off", copyOnly: false },
        dictationKeyLabel: "Right Ctrl",
        billionContext: { server: "absent", foreign: false, updateAvailable: false, folder: "/home/test/.pi-pocket/extensions", page: "https://github.com/x/y", command: "cd" },
        runner: { status: "unlinked", enabled: true, available: false, log: [] },
        ...initial,
    };
    let render: (next: ConfigState) => void = () => undefined;
    let settingsOpened = 0;
    let focus: (section: string) => void = () => undefined;
    const connections: { url: string; unverified: boolean }[] = [];
    const views: string[] = [];
    const folderActions: (string | undefined)[] = [];
    const authenticatorActions: string[] = [];
    const copies: string[] = [];
    let recentClears = 0;
    const gui = {
        clearRecentDictations: async () => {
            recentClears++;
            state = { ...state, dictation: { ...state.dictation, recent: [] } };
            render(state);
        },
        startAuthenticatorSetup: async () => {
            authenticatorActions.push("start");
            return { secret: "JBSWY3DPEHPK3PXP", link: "otpauth://totp/test?secret=JBSWY3DPEHPK3PXP", dataUrl: "data:image/png;base64,qr" };
        },
        cancelAuthenticatorSetup: async () => { authenticatorActions.push("cancel"); },
        confirmAuthenticatorCode: async (code: string) => {
            authenticatorActions.push(`confirm:${code}`);
            if (code !== "123456") return { ok: false, error: "Wrong code." };
            state = { ...state, runner: { ...state.runner, authenticator: { set: true, locked: false } } };
            render(state);
            return { ok: true };
        },
        turnOffAuthenticator: async (code: string) => {
            authenticatorActions.push(`off:${code}`);
            if (code !== "123456") return { ok: false, error: "Wrong code." };
            state = { ...state, runner: { ...state.runner, authenticator: { set: false, locked: false } } };
            render(state);
            return { ok: true };
        },
        runnerFolders: async (folder?: string) => {
            folderActions.push(folder);

            if (folder !== undefined) {
                state = { ...state, runner: { ...state.runner, folders: (state.runner.folders ?? []).filter((saved) => saved !== folder) } };
                render(state);
            }
        },
        view: async (side: "local" | "remote") => { views.push(side); state = { ...state, viewing: side }; render(state); },
        state: async () => state,
        probe,
        onState: (listener: typeof render) => { render = listener; },
        onFocus: (listener: typeof focus) => { focus = listener; return () => {}; },
        openSettings: async () => { settingsOpened++; state = { ...state, recovery: false }; render(state); },
        connect: async (input: string, unverified = false) => {
            connections.push({ url: input, unverified });
            const result = await probe(input);

            if (mayConnect(result, unverified)) {
                state = { ...state, settings: { ...state.settings, server: { ...state.settings.server, url: result.url } },
                    probe: result, connectedUrl: result.url, canReturn: true, recovery: result.kind !== "detected", reason: { kind: "user" } };
            } else {
                state = { ...state, reason: { kind: "not-detected", probe: result } };
            }

            render(state);
            return result;
        },
    };
    const source = readFileSync(join(__dirname, "..", "renderer", "config", "main.js"), "utf8").replace(/^export \{\};?\s*$/m, "");

    runInNewContext(source, {
        URL,
        navigator: { clipboard: { writeText: async (text: string) => { copies.push(text); } } },
        HTMLInputElement: class {},
        window: {
            gui, clearInterval() {}, setInterval() {}, clearTimeout() {}, scrollTo() {}, addEventListener() {},
            setTimeout(run: () => void, ms: number) { timers.push({ run, ms }); return timers.length; },
            getSelection: () => selection,
        },
        document: {
            documentElement: makeElement(), body: makeElement(), getElementById: (id: string) => element(id), createElement: withClasses,
            createElementNS: makeElement,
            // Off until a test asks: the stub has no tree, so code that checks where focus is would see it lost.
            get activeElement() { return trackFocus ? focused : undefined; },
            querySelectorAll: (selector: string) => selector === 'input[name="mode"]' ? [radio, parts] : selector === 'input[name="where"]' ? [where.local, where.remote] : selector === "[data-key]" ? [keyInput] : [],
            querySelector: (selector: string) => selector.includes('name="mode"') ? radio : selector.includes("translucent") ? translucent : opacity,
        },
    });
    await flush();

    return {
        element, connections, views, folderActions, authenticatorActions, copies, timers, selection, recentClears: () => recentClears, trackFocus: () => { trackFocus = true; }, settingsOpened: () => settingsOpened, focused: () => focused,
        focus: async (section: string) => { focus(section); await flush(); },
        push: async (patch: Partial<ConfigState>, drop: (keyof ConfigState)[] = []) => {
            state = { ...state, ...patch };
            for (const key of drop) delete state[key];
            render(state);
            await flush();
        },
        choose: async (side: "local" | "remote") => { where[side].checked = true; where[side === "local" ? "remote" : "local"].checked = false; where[side].fire("change"); await flush(); },
        input: (input: string) => { element("url").value = input; element("url").fire("input"); },
        submit: async () => { element("connect-form").fire("submit"); await flush(); },
        click: async (id: string) => { element(id).fire("click"); await flush(); },
    };
}

test("first-run Connect does not open a JSON API error, invalid URL, or unreachable server", async () => {
    for (const result of [apiError, { kind: "invalid", url, message: "Invalid" }, { kind: "unreachable", url, message: "Offline" }] satisfies ProbeResult[]) {
        const screen = await page(async () => result);

        screen.input(url);
        await screen.submit();
        assert.equal(screen.connections.length, 0);
        assert.equal(screen.element("connect").disabled, true);
        assert.equal(screen.element("url").value, url);
        assert.equal(screen.element("status").textContent, "Not detected");
    }
});

test("a detected server connects and is shown as Connected, not merely Detected", async () => {
    const screen = await page(async () => found);

    screen.input(url);
    await screen.submit();
    assert.deepEqual(screen.connections, [{ url, unverified: false }]);
    assert.equal(screen.element("status").textContent, "Connected");
});

test("an unknown HTML page needs an explicit second click and exposes an app-owned settings button", async () => {
    const screen = await page(async () => ({ ...apiError, status: 200, canOpen: true }));

    screen.input(url);
    await screen.submit();
    assert.equal(screen.connections.length, 0);
    assert.equal(screen.element("connect").textContent, "Open webpage anyway");
    await screen.submit();
    assert.deepEqual(screen.connections, [{ url, unverified: true }]);
    assert.equal(screen.element("recovery").hidden, false);
    assert.equal(screen.element("settings-page").hidden, true);
    await screen.click("server-settings");
    assert.equal(screen.settingsOpened(), 1);
    assert.equal(screen.element("settings-page").hidden, false);
});

test("a late check result cannot connect after the person edits the address", async () => {
    let resolve!: (result: ProbeResult) => void;
    const screen = await page(() => new Promise<ProbeResult>((done) => { resolve = done; }));

    screen.input(url);
    await screen.submit();
    screen.input("https://example.com/something-else");
    resolve(found);
    await flush();
    assert.equal(screen.connections.length, 0);
    assert.equal(screen.element("url").value, "https://example.com/something-else");
    assert.equal(screen.element("connect").textContent, "Connect");
});

test("a saved address already known to be wrong has no enabled Connect button", async () => {
    const settings = defaultSettings();

    settings.server.mode = "remote";
    settings.server.url = url;
    const screen = await page(async () => apiError, { settings, probe: apiError });

    assert.equal(screen.element("connect").disabled, true);
    await screen.submit();
    assert.equal(screen.connections.length, 0);
});

test("a failed replacement check keeps Back to the existing server available", async () => {
    const screen = await page(async () => apiError, { connectedUrl: "https://example.com/working", canReturn: true, reason: { kind: "user" } });

    screen.input(url);
    await screen.click("test");
    assert.equal(screen.element("back").hidden, false);
    assert.equal(screen.element("connect").disabled, true);
    assert.equal(screen.connections.length, 0);
});

test("a click on a choice only shows that side: it does not connect, and Back stays on Another server", async () => {
    let checks = 0;
    const settings = defaultSettings();

    settings.server.mode = "remote";
    settings.server.url = url;
    const connected = { settings, connectedUrl: url, canReturn: true, reason: { kind: "user" } as const, probe: found,
        choices: { local: { label: "Stopped", state: "other" as const }, remote: { label: "Connected", state: "connected" as const } } };
    const screen = await page(async () => { checks++; return found; }, connected);

    assert.equal(screen.element("back").hidden, false);
    assert.equal(screen.element("choice-remote").textContent, "Connected");
    assert.equal(screen.element("choice-local").textContent, "Stopped");
    // Settings → Server shows only the chosen side's settings.
    const serverSettings = () => ["preferences", "server-local-settings", "remote-settings-heading", "remote-settings-card"]
        .map((id) => screen.element(id).hidden);
    assert.deepEqual(serverSettings(), [true, true, false, false]);
    await screen.choose("local");
    assert.equal(screen.element("local-card").hidden, false);
    assert.equal(screen.element("remote-card").hidden, true);
    assert.deepEqual(serverSettings(), [false, false, true, true]);
    assert.equal(screen.element("billion-context-card").hidden, false);
    await screen.choose("remote");
    assert.deepEqual(serverSettings(), [true, true, false, false]);
    assert.deepEqual(screen.views, ["local", "remote"]);
    assert.equal(screen.connections.length, 0);
    assert.equal(checks, 0);
    assert.equal(screen.element("remote-card").hidden, false);
    assert.equal(screen.element("status").textContent, "Connected");
});

test("a dropped connection shows Disconnected with its reason, an error on the choice, and no Back", async () => {
    const settings = defaultSettings();

    settings.server.mode = "remote";
    settings.server.url = url;
    const screen = await page(async () => found, {
        settings, canReturn: false, reason: { kind: "user" },
        disconnected: { url, line: "example.com stopped answering" },
        choices: { local: { label: "Running", state: "connected" }, remote: { label: "Error", state: "not-detected", detail: "example.com stopped answering" } },
    });

    assert.equal(screen.element("back").hidden, true);
    assert.equal(screen.element("status").textContent, "Disconnected");
    assert.equal(screen.element("status-detail").textContent, "Disconnected: example.com stopped answering.");
    assert.equal(screen.element("choice-remote").textContent, "Error");
    assert.equal(screen.element("choice-remote").dataset.state, "not-detected");
    assert.equal(screen.element("choice-remote-error").hidden, false);
    assert.equal(screen.element("choice-remote-error").textContent, "example.com stopped answering");
    assert.equal(screen.element("choice-local-error").hidden, true);
    assert.equal(screen.element("connect").disabled, false, "Connect works as before");
});

type Node = { textContent: string; children: Node[]; type: string; className: string; title: string; disabled: boolean; hidden: boolean; dataset: Record<string, string>; classes: Set<string>; attributes: Record<string, string>; fire(name: string): boolean };

/** The first node under this one (itself included) whose class list has this class. */
function find(node: Node, className: string): Node | undefined {
    if (node.className.split(" ").includes(className)) return node;
    for (const child of node.children ?? []) {
        if (typeof child !== "object" || child === null) continue;
        const found = find(child, className);
        if (found !== undefined) return found;
    }
    return undefined;
}

/** Every text under this node, in order, as a person (or screen reader) reads it. */
function text(node: Node | string): string {
    if (typeof node === "string") return node;
    return node.children.length === 0 ? node.textContent : node.children.map(text).join("");
}

const linked = (folders?: string[], extra: Partial<ConfigState["runner"]> = {}): Partial<ConfigState> => ({
    runner: { status: "connected", enabled: true, available: true, log: [], ...(folders === undefined ? {} : { folders }), link: { server: url, id: "id", name: "Computer" }, ...extra },
});

test("the Runner card reads allowed folders when the screen loads, renders paths as text, and removes one", async () => {
    const folder = "/home/person/<project>";
    const screen = await page(async () => found, linked([folder]));

    await flush();
    assert.deepEqual(screen.folderActions, [undefined]);
    const row = screen.element("runner-folders").children[0] as Node;
    const remove = find(row, "danger")!;

    assert.equal(find(row, "folder-text")!.children[0]!.textContent, "<project>", "the folder's own name, as text");
    assert.equal(text(find(row, "folder-text")!.children[1]!), folder, "its full path under it, whole");
    assert.equal(find(row, "folder-text")!.children[1]!.title, folder);
    assert.equal(remove.textContent, "Remove");
    assert.equal(remove.attributes["aria-label"], `Remove allowed folder ${folder}`);
    remove.fire("click");
    await flush();
    assert.deepEqual(screen.folderActions, [undefined, folder]);
    assert.equal(screen.element("runner-folders").hidden, true);
    assert.equal(screen.element("runner-folders-empty").hidden, false);
    assert.equal(screen.element("runner-folders-empty").textContent, "No allowed folders yet. A folder is added when you allow a session in it.");
    assert.equal(screen.element("runner-folders-count").hidden, true, "no count while none are allowed");
    assert.equal(screen.focused(), screen.element("runner-folders-toggle"), "with the last one removed, focus goes to the panel's title");
});

test("allowed folders: a count at a glance, open with a few, folded with many, and the person's choice holds", async () => {
    const few = ["/a/one", "C:\\Users\\Person\\two", "/a/three"];
    const many = Array.from({ length: 12 }, (_, index) => `/Users/person/Projects/project-${String(index)}`);
    const screen = await page(async () => found, linked());
    const section = screen.element("runner-folders-section");

    assert.equal(screen.element("runner-folders-empty").textContent, "Loading allowed folders…");
    assert.equal(screen.element("runner-folders-count").hidden, true);
    await screen.push(linked(few));
    assert.equal(screen.element("runner-folders-count").hidden, false);
    assert.equal(screen.element("runner-folders-count").textContent, "3");
    assert.equal(section.open, true, "a few folders show at once");
    assert.deepEqual((screen.element("runner-folders").children as Node[]).map((item) => find(item, "folder-text")!.children[0]!.textContent), ["one", "two", "three"]);
    await screen.push(linked(many));
    assert.equal(screen.element("runner-folders-count").textContent, "12");
    assert.equal(section.open, false, "many folders fold to the title and its count");
    // The person opens it: it stays open, also when the list grows.
    section.open = true;
    screen.element("runner-folders-toggle").fire("click");
    await screen.push(linked([...many, "/one/more"]));
    assert.equal(section.open, true);
    assert.equal(screen.element("runner-folders-count").textContent, "13");
    await screen.push({}, []);
    assert.equal(screen.element("runner-folders").children.length, 13);
});

test("allowed folders: the list is not redrawn while it stays the same, Remove follows busy, and an error shows", async () => {
    const folders = ["/a/one", "/a/two", "/a/three"];
    const screen = await page(async () => found, linked(folders));
    const first = screen.element("runner-folders").children[0];

    await screen.push(linked([...folders], { busy: "Linking…" }));
    assert.equal(screen.element("runner-folders").children[0], first, "the same list is kept, with its scroll and focus");
    assert.equal(find(first as Node, "danger")!.disabled, true, "Remove waits while the runner is busy");
    await screen.push(linked([...folders]));
    assert.equal(find(first as Node, "danger")!.disabled, false);
    // Remove the second: focus goes on to the folder now at its place.
    find((screen.element("runner-folders").children[1] as Node), "danger")!.fire("click");
    await flush();
    assert.deepEqual(screen.folderActions, [undefined, "/a/two"]);
    await screen.push(linked(["/a/one", "/a/three"]));
    assert.equal(screen.focused(), find(screen.element("runner-folders").children[1] as Node, "danger"));
    await screen.push(linked(undefined, { foldersError: "Could not read allowed folders: no runner" }));
    assert.equal(screen.element("runner-folders-error").hidden, false);
    assert.equal(screen.element("runner-folders-error").textContent, "Could not read allowed folders: no runner");
    assert.equal(screen.element("runner-folders-empty").textContent, "Allowed folders are unavailable.");
});

const NOW = Date.now();
const recentSamples: ConfigState["dictation"]["recent"] = [
    { id: 4, text: "Ship it.", at: NOW, where: "pi-pocket" },
    { id: 3, text: "word ".repeat(80).trim(), at: NOW - 1000, where: "anywhere" },
    { id: 2, text: "Delete the old screenshots", at: NOW - 2000, where: "anywhere", dropped: true },
    { id: 1, text: "Rename the section to", at: NOW - 3000, where: "pi-pocket", error: "The speech model stopped (code 9)" },
];
const withRecent = (recent: ConfigState["dictation"]["recent"]): Partial<ConfigState> => ({
    dictation: { supported: true, status: "idle", engine: { installed: false, size: 11e6 }, folder: "/test/dictation", models: [], downloading: false, recent },
});

test("recent dictations: an empty panel says none yet; with some, a count, Clear, and one card each", async () => {
    const screen = await page(async () => found);

    assert.equal(screen.element("dictation-recent-empty").hidden, false);
    assert.match(readFileSync(join(__dirname, "..", "renderer", "config", "index.html"), "utf8"), /id="dictation-recent-empty"[^>]*>None yet\. What you dictate shows here\.</);
    assert.equal(screen.element("dictation-recent-count").hidden, true);
    assert.equal(screen.element("dictation-recent-clear").hidden, true);
    assert.equal(screen.element("dictation-recent").hidden, true);
    await screen.push(withRecent(recentSamples));
    assert.equal(screen.element("dictation-recent-empty").hidden, true);
    assert.equal(screen.element("dictation-recent-count").hidden, false);
    assert.equal(screen.element("dictation-recent-count").textContent, "4");
    assert.equal(screen.element("dictation-recent-clear").hidden, false);
    const items = screen.element("dictation-recent").children as Node[];
    assert.equal(items.length, 4, "newest first, as the app keeps them");
    assert.deepEqual(items.map((item) => find(item, "recent-text")!.textContent), recentSamples.map((each) => each.text));
    assert.match(text(find(items[0]!, "recent-meta")!), / · Pi Pocket$/);
    assert.match(text(find(items[1]!, "recent-meta")!), / · Dictate anywhere$/);
});

test("recent dictations: Dropped and Stopped show as pills with their reasons, and a stopped one its error", async () => {
    const screen = await page(async () => found, withRecent(recentSamples));
    const items = screen.element("dictation-recent").children as Node[];
    const dropped = find(items[2]!, "recent-tag")!;
    const stopped = find(items[3]!, "recent-tag")!;

    assert.equal(find(items[0]!, "recent-tag"), undefined);
    assert.equal(dropped.textContent, "Dropped");
    assert.equal(dropped.title, "Dropped with Esc, not pasted");
    assert.equal(dropped.dataset.state, "other");
    assert.equal(items[2]!.dataset.state, "dropped");
    assert.equal(stopped.textContent, "Stopped");
    assert.equal(stopped.title, "Stopped: The speech model stopped (code 9)");
    assert.equal(stopped.dataset.state, "not-detected");
    assert.equal(find(items[3]!, "recent-error")!.textContent, "The speech model stopped (code 9)");
    assert.equal(find(items[2]!, "recent-error"), undefined);
});

test("recent dictations: long words fold, Show all or a click opens them, and a selection is no click", async () => {
    const screen = await page(async () => found, withRecent(recentSamples));
    const items = screen.element("dictation-recent").children as Node[];
    const short = find(items[0]!, "recent-more")!;
    const more = find(items[1]!, "recent-more")!;
    const words = find(items[1]!, "recent-text")!;

    assert.equal(short.hidden, true, "short words need no Show all");
    assert.equal(more.hidden, false);
    assert.equal(more.textContent, "Show all");
    assert.equal(more.attributes["aria-expanded"], "false");
    assert.equal(more.attributes["aria-controls"], "dictation-recent-3-text");
    more.fire("click");
    assert.equal(words.classes.has("open"), true);
    assert.equal(more.textContent, "Show less");
    assert.equal(more.attributes["aria-expanded"], "true");
    screen.selection.isCollapsed = false;
    words.fire("click");
    assert.equal(words.classes.has("open"), true, "selecting some words does not fold them");
    screen.selection.isCollapsed = true;
    words.fire("click");
    assert.equal(words.classes.has("open"), false);
    find(items[0]!, "recent-text")!.fire("click");
    assert.equal(find(items[0]!, "recent-text")!.classes.has("open"), false, "short words do not open");
    // An opened one stays open through a state push with the same dictations.
    more.fire("click");
    await screen.push(withRecent(recentSamples.map((each) => ({ ...each }))));
    assert.equal(screen.element("dictation-recent").children[1], items[1]);
    assert.equal(words.classes.has("open"), true);
});

test("recent dictations: Copy copies the exact words, says Copied for 1.5 s, and tells a screen reader", async () => {
    const screen = await page(async () => found, withRecent(recentSamples));
    const item = (screen.element("dictation-recent").children as Node[])[1]!;
    const copy = find(item, "recent-copy")!;

    assert.equal(text(copy), "Copy");
    assert.equal(copy.attributes["aria-describedby"], "dictation-recent-3-meta", "Copy says which dictation it copies");
    copy.fire("click");
    await flush();
    assert.deepEqual(screen.copies, [recentSamples[1]!.text]);
    assert.equal(text(copy), "Copied");
    assert.equal(copy.classes.has("done"), true);
    assert.equal(screen.element("dictation-recent-status").textContent, "Copied.");
    // A state push with the same ids keeps the Copied state.
    await screen.push(withRecent(recentSamples.map((each) => ({ ...each }))));
    assert.equal(text(copy), "Copied");
    for (const timer of screen.timers.filter((each) => each.ms === 1500)) timer.run();
    assert.equal(text(copy), "Copy");
    assert.equal(copy.classes.has("done"), false);
    assert.equal(screen.element("dictation-recent-status").textContent, "");
});

test("recent dictations: Clear empties the panel and keeps focus in it", async () => {
    const screen = await page(async () => found, withRecent(recentSamples));

    screen.trackFocus();
    screen.element("dictation-recent-clear").focus();
    await screen.click("dictation-recent-clear");
    assert.equal(screen.recentClears(), 1);
    assert.equal(screen.element("dictation-recent").hidden, true);
    assert.equal(screen.element("dictation-recent-empty").hidden, false);
    assert.equal(screen.element("dictation-recent-clear").hidden, true);
    assert.equal(screen.focused(), screen.element("dictation-recent-empty"));
    assert.equal(screen.element("dictation-recent-status").textContent, "Cleared.");
});

test("the authenticator row is linked-only, explains availability, and shows lockout time", async () => {
    const screen = await page(async () => found);
    assert.equal(screen.element("runner-authenticator-row").hidden, true);
    const runner: ConfigState["runner"] = { status: "connected", enabled: true, available: true, log: [], link: { server: url, id: "id", name: "Computer" } };
    await screen.push({ runner: { ...runner, authenticator: { unavailable: "Update Pi Pocket to set up an authenticator here" } } });
    assert.equal(screen.element("runner-authenticator-row").hidden, false);
    assert.equal(screen.element("runner-authenticator-action").hidden, true);
    assert.equal(screen.element("runner-authenticator-detail").textContent, "Update Pi Pocket to set up an authenticator here");
    assert.equal(screen.element("runner-authenticator-state").hidden, true, "no state pill when it cannot be set up here");
    await screen.push({ runner: { ...runner, authenticator: { set: false, locked: false } } });
    assert.equal(screen.element("runner-authenticator-state").hidden, false);
    assert.equal(screen.element("runner-authenticator-state").textContent, "Off");
    await screen.push({ runner: { ...runner, authenticator: { set: true, locked: false } } });
    assert.equal(screen.element("runner-authenticator-state").textContent, "On");
    assert.equal(screen.element("runner-authenticator-state").dataset.state, "connected");
    await screen.push({ runner: { ...runner, authenticator: { set: true, locked: true, lockedUntil: 1800000000000 } } });
    assert.equal(screen.element("runner-authenticator-action").textContent, "Turn off");
    assert.equal(screen.element("runner-authenticator-state").textContent, "Locked");
    assert.match(screen.element("runner-authenticator-detail").textContent, /^Too many wrong codes\. Codes are refused until .+\.$/);
});

test("the trust note follows the runner's status row, not the authenticator", () => {
    const html = readFileSync(join(__dirname, "..", "renderer", "config", "index.html"), "utf8");
    const at = (id: string) => html.indexOf(`id="${id}"`);
    assert.ok(at("runner-status") < at("runner-linked-note"));
    assert.ok(at("runner-linked-note") < at("runner-enabled-row"));
    assert.ok(at("runner-linked-note") < at("runner-authenticator-row"));
});

test("authenticator inline setup copies its key, keeps errors open, confirms with Enter, and clears secrets", async () => {
    const screen = await page(async () => found, { runner: { status: "connected", enabled: true, available: true, log: [], link: { server: url, id: "id", name: "Computer" }, authenticator: { set: false, locked: false } } });
    assert.equal(screen.element("runner-authenticator-action").textContent, "Set up");
    await screen.click("runner-authenticator-action");
    assert.equal(screen.element("runner-authenticator-panel").hidden, false);
    assert.equal(screen.element("runner-authenticator-action").hidden, true, "the row offers no second Set up while the panel is open");
    assert.equal(screen.element("runner-authenticator-setup").hidden, false);
    assert.equal(screen.element("runner-authenticator-enter").hidden, false);
    assert.equal(screen.element("runner-authenticator-loading").hidden, true);
    const groups = screen.element("runner-authenticator-secret").children as { textContent: string }[];
    assert.deepEqual(groups.map((group) => group.textContent), ["JBSW", "Y3DP", "EHPK", "3PXP"], "the key reads in groups of 4");
    await screen.click("runner-authenticator-copy");
    assert.deepEqual(screen.copies, ["JBSWY3DPEHPK3PXP"], "Copy copies the exact key, without spaces");
    assert.equal(screen.element("runner-authenticator-copy").textContent, "Copied");
    const code = screen.element("runner-authenticator-code");
    code.value = "000000";
    await screen.click("runner-authenticator-confirm");
    assert.equal(screen.element("runner-authenticator-error").textContent, "Wrong code.");
    assert.equal(screen.element("runner-authenticator-panel").hidden, false);
    code.value = "123456";
    assert.equal(screen.element("runner-authenticator-panel").fire("keydown", "Enter", code), true);
    await flush();
    assert.deepEqual(screen.authenticatorActions, ["start", "confirm:000000", "confirm:123456"]);
    assert.equal(screen.element("runner-authenticator-panel").hidden, true);
    assert.deepEqual(screen.element("runner-authenticator-secret").children, []);
    assert.equal(code.value, "");
    assert.equal(screen.element("runner-authenticator-action").hidden, false, "the row's button comes back when the panel closes");
    assert.equal(screen.element("runner-authenticator-action").textContent, "Turn off");
    assert.equal(screen.element("runner-authenticator-state").textContent, "On");
});

test("authenticator turn-off shows inline errors; Escape cancels and a right code turns it off", async () => {
    const screen = await page(async () => found, { runner: { status: "connected", enabled: true, available: true, log: [], link: { server: url, id: "id", name: "Computer" }, authenticator: { set: true, locked: false } } });
    await screen.click("runner-authenticator-action");
    assert.equal(screen.element("runner-authenticator-off").hidden, false);
    assert.equal(screen.element("runner-authenticator-setup").hidden, true);
    assert.equal(screen.element("runner-authenticator-action").hidden, true);
    assert.equal(screen.element("runner-authenticator-title").textContent, "Turn off the authenticator?");
    assert.equal(screen.element("runner-authenticator-enter").hidden, false);
    assert.equal(screen.element("runner-authenticator-enter-number").hidden, true, "turning off is one step, not numbered");
    assert.equal(screen.element("runner-authenticator-confirm").textContent, "Turn off");
    screen.element("runner-authenticator-code").value = "000000";
    await screen.click("runner-authenticator-confirm");
    assert.equal(screen.element("runner-authenticator-error").textContent, "Wrong code.");
    assert.equal(screen.focused(), screen.element("runner-authenticator-code"), "a wrong code keeps focus in the code field");
    assert.equal(screen.element("runner-authenticator-panel").fire("keydown", "Escape"), true);
    await flush();
    assert.equal(screen.element("runner-authenticator-panel").hidden, true);
    assert.equal(screen.element("runner-authenticator-action").hidden, false);
    assert.equal(screen.focused(), screen.element("runner-authenticator-action"), "focus goes back to the row's button");
    await screen.click("runner-authenticator-action");
    assert.equal(screen.focused(), screen.element("runner-authenticator-code"));
    screen.element("runner-authenticator-code").value = "123456";
    await screen.click("runner-authenticator-confirm");
    assert.equal(screen.element("runner-authenticator-panel").hidden, true);
    assert.equal(screen.element("runner-authenticator-action").textContent, "Set up");
    assert.deepEqual(screen.authenticatorActions, ["off:000000", "cancel", "off:123456"]);
});

test("authenticator setup can be cancelled while the runner makes its key", async () => {
    const screen = await page(async () => found, { runner: { status: "connected", enabled: true, available: true, log: [], link: { server: url, id: "id", name: "Computer" }, authenticator: { set: false, locked: false } } });
    screen.element("runner-authenticator-action").fire("click");
    assert.equal(screen.element("runner-authenticator-loading").hidden, false);
    assert.equal(screen.element("runner-authenticator-action").hidden, true);
    assert.equal(screen.focused(), screen.element("runner-authenticator-stop"), "the loading line's Cancel holds focus");
    await screen.click("runner-authenticator-stop");
    assert.equal(screen.element("runner-authenticator-panel").hidden, true);
    assert.equal(screen.element("runner-authenticator-secret").children.length, 0, "a key that arrives after Cancel is not shown");
    assert.equal(screen.focused(), screen.element("runner-authenticator-action"));
    assert.deepEqual(screen.authenticatorActions, ["start", "cancel"]);
});

test("authenticator focus waits for the row's button while a runner step keeps it disabled", async () => {
    const runner: ConfigState["runner"] = { status: "connected", enabled: true, available: true, log: [], link: { server: url, id: "id", name: "Computer" }, authenticator: { set: true, locked: false } };
    const screen = await page(async () => found, { runner });
    await screen.click("runner-authenticator-action");
    await screen.push({ runner: { ...runner, busy: "Turning off the authenticator…" } });
    assert.equal(screen.element("runner-authenticator-panel").fire("keydown", "Escape"), true);
    await flush();
    assert.equal(screen.element("runner-authenticator-action").disabled, true);
    assert.notEqual(screen.focused(), screen.element("runner-authenticator-action"));
    await screen.push({ runner });
    assert.equal(screen.focused(), screen.element("runner-authenticator-action"));
});

test("a menu opens Home, a section opens Settings at it, and a new failure brings Home back", async () => {
    const screen = await page(async () => found, { reason: { kind: "user" } });
    const home = () => screen.element("view-home").hidden === false && screen.element("settings-form").hidden === true;

    await screen.focus("dictation");
    assert.equal(home(), false);
    assert.equal(screen.element("settings-form").hidden, false);
    await screen.focus("home");
    assert.equal(home(), true);
    await screen.focus("appearance");
    assert.equal(home(), false);
    await screen.push({ reason: { kind: "not-detected", probe: apiError } });
    assert.equal(home(), true, "the reason the app shows this screen for is on Home");
    await screen.focus("not-a-section");
    assert.equal(home(), true, "an unknown section changes nothing");
});

test("Home offers Back to Pi Pocket only when there is a server to go back to", async () => {
    const settings = defaultSettings();

    settings.server.mode = "remote";
    settings.server.url = url;
    const screen = await page(async () => found, { settings, connectedUrl: url, canReturn: true, probe: found, reason: { kind: "user" } });

    assert.equal(screen.element("remote-back-row").hidden, false);
    assert.equal(screen.element("remote-address").textContent, url);
    assert.equal(screen.element("connection-title").textContent, "Connected to your Pi Pocket server");
    await screen.push({ canReturn: false }, ["connectedUrl"]);
    assert.equal(screen.element("remote-back-row").hidden, true);
    assert.equal(screen.element("connection-title").textContent, "Connect to your Pi Pocket server");
});

test("every sidebar link and Home tile leads to a section that exists", () => {
    const html = readFileSync(join(__dirname, "..", "renderer", "config", "index.html"), "utf8");
    const targets = new Set([...html.matchAll(/data-go="([^"]+)"/g)].map((match) => match[1]!));

    assert.ok(targets.has("home"));
    for (const target of targets) {
        if (target !== "home") {
            assert.match(html, new RegExp(`id="sec-${target}"`), `#sec-${target}`);
        }
    }
    for (const section of ["window", "appearance", "notifications", "dictation", "updates", "runner", "server"]) {
        assert.ok(targets.has(section), `the sidebar links ${section}`);
    }
});

test("a dictation key chosen with a button stays while other state arrives before it is saved", async () => {
    const screen = await page(async () => found, { reason: { kind: "user" } });

    await screen.push({});
    assert.equal(screen.element("dictation-key").value, "auto");

    await screen.click("dictation-key-off");
    assert.equal(screen.element("dictation-key").value, "off");

    // Any state that arrives (a model download's progress, an update check) re-renders the settings while the save waits.
    await screen.push({ update: { method: "source", status: "checking" } });
    assert.equal(screen.element("dictation-key").value, "off");
});
