/**
 * Dictate anywhere: a key starts dictation in any app, and the words go where the cursor is.
 *
 * - The key: uiohook-napi (a keyboard hook) hears it in every app and hands it to the dictation key
 *   (src/main/dictation/dictation-key.ts), which says what each press means and where it dictates.
 * - The microphone: a small window, the "recording" pill (src/renderer/anywhere), reads it. It never takes focus, so the
 *   app you type in keeps it, and it sends the audio here.
 * - The words: offline dictation (src/main/dictation/dictation.ts) recognises them, then they are pasted: put on the
 *   clipboard, ⌘V or Ctrl+V pressed for you, and the clipboard given back what it held.
 * - Wayland lets no app hear keys or type into others: there the tray's Dictate item starts it, and the words are only
 *   copied.
 */
import { join } from "node:path";
import {
    BrowserWindow,
    clipboard,
    ClipboardItem,
    ipcMain,
    nativeImage,
    Notification,
    screen,
    session,
    systemPreferences,
    type IpcMainEvent,
} from "electron";
import type { AnywhereState, Settings, ThemeColors } from "../../shared/types";
import { APP_ORIGIN, serveAppPages } from "../settings-screen/config-protocol";
import { preloadPath } from "../core/paths";
import { KEY, keptType, pasteText, PILL, pillPlace, pillWindowOptions } from "./anywhere-keys";
import { comboOf } from "./key-combo";
import { resetAccessibility } from "./mac-accessibility";
import { diagnose } from "../diagnostics/stall-watchdog";
import type { Listening, PageMessage } from "./dictation";

/** uiohook-napi, as used here. Loaded only once Dictate anywhere is turned on. */
interface Hook {
    on(event: "keydown" | "keyup", listener: (event: { keycode: number }) => void): unknown;
    removeAllListeners(): unknown;
    start(): void;
    stop(): void;
    keyTap(key: number, modifiers?: number[]): void;
}

/** One recording: what it heard so far, and how it ends. */
interface Take {
    listening: Listening;
    phrases: string[];
    error?: string;
    timer: NodeJS.Timeout;
    /** The microphone is closed and its last audio is in. */
    micClosed: boolean;
    stopping: boolean;
    dropped: boolean;
}

export interface AnywhereHost {
    platform: NodeJS.Platform;
    renderer: string;
    assets: string;
    settings: () => Settings;
    theme: () => ThemeColors;
    dictation: () => { ready(): boolean; listen(owner: (message: PageMessage) => void): Listening | undefined } | undefined;
    /** The state changed: show it in the settings. */
    changed: () => void;
    /** Recording or not: the tray's π turns red. */
    recording: (on: boolean) => void;
    /** No speech model yet: open the settings at Dictation. */
    needModel: () => void;
    /** A key the hook heard, in any app, for the dictation key. */
    key: (type: "down" | "up", code: number) => void;
    /** The dictation key is held down now. */
    keyHeld: () => boolean;
    /** A recording ended some other way than the key (the tray, an error, the time limit). */
    ended: () => void;
    /** The keyboard hook started or stopped. */
    hookChanged: () => void;
    /** Runs `then` once the app's window is on screen: macOS's question must not open behind it. */
    afterWindow: (then: () => void) => void;
}

const PARTITION = "gui-anywhere";
const PILL_URL = `${APP_ORIGIN}/anywhere/index.html`;

/** A recording ends by itself after this long. */
const LONGEST_MS = 5 * 60 * 1000;
/** How long "Pasted" stays, and the clipboard keeps the words before it gets back what it held. */
const DONE_MS = 900;
const RESTORE_MS = 1500;
/** While macOS has not given Accessibility, how often to look again (quietly: no prompt). */
const ACCESSIBILITY_CHECK_MS = 10_000;

type PillMessage =
    | { type: "record"; title: string; colors: Record<string, string>; mode: "dark" | "light"; sound: boolean }
    | { type: "stop" }
    | { type: "show"; state: "working" | "done" | "error"; title: string; detail?: string }
    | { type: "words"; text: string }
    | { type: "edge"; edge: "top" | "bottom" }
    | { type: "hide" };

/** Wayland lets no app hear keys pressed in other apps, or type into them. */
export function waylandOnly(platform: string, env: NodeJS.ProcessEnv): boolean {
    return platform === "linux" && (env.XDG_SESSION_TYPE === "wayland" || (env.WAYLAND_DISPLAY !== undefined && env.DISPLAY === undefined));
}

/** What a hook that failed to start means, in words. */
export function hookProblem(error: unknown, platform: string): string {
    const text = error instanceof Error ? error.message : String(error);

    if (/AXAPI/.test(text)) {
        return "macOS does not let Pi Pocket see keys in other apps. macOS asks for Accessibility: allow Pi Pocket there. If System Settings already shows Pi Pocket on, that switch belongs to an earlier version: use Ask again below.";
    }

    if (/X_OPEN_DISPLAY|X_RECORD|XRECORD/i.test(text)) {
        return "This desktop does not let apps hear keys in other apps (it needs X11 with the RECORD extension). Use the tray's Dictate item instead.";
    }

    return `The key could not be watched: ${text}`;
}

export function setUpAnywhere(host: AnywhereHost) {
    const copyOnly = waylandOnly(host.platform, process.env);
    let hook: Hook | undefined;
    let hookRunning = false;
    let problem: string | undefined;
    /** macOS answered that Pi Pocket has no Accessibility. */
    let refused = false;
    let status: AnywhereState["status"] = "off";
    let pill: BrowserWindow | undefined;
    let pillReady: Promise<void> | undefined;
    let served = false;
    /** The pill's page answered: it hears messages. */
    let pillLoaded = false;

    /** The recording now: what it heard so far, and how it ends. */
    let take: Take | undefined;
    let hideTimer: NodeJS.Timeout | undefined;

    const setStatus = (next: AnywhereState["status"]): void => {
        if (status !== next) {
            status = next;
            host.recording(next === "recording");
            host.changed();
        }
    };

    // ——— The pill ———

    const anywhereSession = () => {
        const own = session.fromPartition(PARTITION);

        if (!served) {
            served = true;
            serveAppPages(own, host.renderer);
            // The pill may use the microphone, and nothing else.
            own.setPermissionRequestHandler((contents, permission, callback, details) => {
                const audioOnly =
                    permission === "media" &&
                    "mediaTypes" in details &&
                    (details.mediaTypes ?? []).length > 0 &&
                    (details.mediaTypes ?? []).every((type) => type === "audio");

                callback(contents === pill?.webContents && audioOnly);
            });
            own.setPermissionCheckHandler((contents, permission) => contents === pill?.webContents && permission === "media");
            own.setDevicePermissionHandler(() => false);
        }

        return own;
    };

    const pillWindow = (): BrowserWindow => {
        if (pill !== undefined && !pill.isDestroyed()) {
            return pill;
        }

        const window = new BrowserWindow({
            ...pillWindowOptions(host.platform),
            webPreferences: {
                session: anywhereSession(),
                preload: preloadPath("anywhere"),
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                // It records while hidden for a moment, and while other windows cover it.
                backgroundThrottling: false,
            },
        });

        // Window managers judge a window by its title too (see pillWindowOptions): the page's title must not reach it.
        window.on("page-title-updated", (event) => event.preventDefault());
        window.setTitle("");
        window.setAlwaysOnTop(true, "screen-saver");
        // On macOS, Electron would otherwise hide and show the app's dock icon to float over full-screen apps, and that
        // switch can bring Pi Pocket's window to the front. A panel floats over them already.
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
        window.setIgnoreMouseEvents(true);
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event) => event.preventDefault());
        window.webContents.on("render-process-gone", () => {
            if (take !== undefined) {
                const lost = take;

                lost.micClosed = true;
                lost.error = "The recording window stopped.";
                finish(true);
                lost.listening.stop(true);
            }

            pill = undefined;
            pillReady = undefined;
            window.destroy();
        });

        pill = window;
        pillLoaded = false;
        pillReady = new Promise((resolve) => {
            const ready = (event: IpcMainEvent): void => {
                if (event.sender === window.webContents) {
                    ipcMain.off("anywhere:ready", ready);
                    pillLoaded = true;
                    resolve();
                }
            };

            ipcMain.on("anywhere:ready", ready);
        });
        void window.loadURL(PILL_URL);

        return window;
    };

    const toPill = (message: PillMessage): void => {
        if (pill !== undefined && !pill.isDestroyed()) {
            pill.webContents.send("anywhere:pill", message);
        }
    };

    /**
     * Shows the pill without focus on the screen the pointer is on: at its bottom, or at its top when the pointer is in
     * the lower half, so it does not cover where you type. It stays where it is until the recording's pill hides.
     */
    const showPill = (): void => {
        const window = pillWindow();

        if (!window.isVisible()) {
            const pointer = screen.getCursorScreenPoint();
            const place = pillPlace(screen.getDisplayNearestPoint(pointer).workArea, pointer, PILL);

            window.setBounds({ x: place.x, y: place.y, ...PILL });
            toPill({ type: "edge", edge: place.edge });
        }

        if (!window.isVisible()) {
            window.showInactive();
        }
    };

    const hidePillSoon = (ms: number): void => {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            toPill({ type: "hide" });
            // The fade, then the window goes.
            setTimeout(() => {
                if (take === undefined) {
                    pill?.hide();
                }
            }, 150);
        }, ms);
    };

    const fromPill = (event: IpcMainEvent): boolean => pill !== undefined && !pill.isDestroyed() && event.sender === pill.webContents;

    ipcMain.on("anywhere:audio", (event, samples: unknown) => {
        if (fromPill(event) && take !== undefined && !take.micClosed && samples instanceof Float32Array) {
            take.listening.audio(samples);
        }
    });

    ipcMain.on("anywhere:stopped", (event, error: unknown) => {
        if (!fromPill(event) || take === undefined || take.micClosed) {
            return;
        }

        take.micClosed = true;

        if (typeof error === "string") {
            take.error =
                error === "not-allowed"
                    ? host.platform === "darwin"
                        ? "Pi Pocket may not use the microphone. Allow it in System Settings → Privacy & Security → Microphone."
                        : "Pi Pocket may not use the microphone."
                    : error === "no-microphone"
                      ? "No microphone was found."
                      : error;
            host.ended();
            take.listening.stop(true);

            return;
        }

        // The last audio is in: the last phrase is recognised, then the dictation ends (its "end" message).
        take.listening.stop(take.dropped);
    });

    // ——— A recording ———

    const theme = (): { colors: Record<string, string>; mode: "dark" | "light" } => {
        const current = host.theme();

        return { colors: { ...current.colors }, mode: current.mode };
    };

    const start = async (): Promise<void> => {
        if (take !== undefined) {
            return;
        }

        const dictation = host.dictation();

        if (dictation === undefined || !dictation.ready()) {
            host.ended();
            notify("Dictate anywhere needs a speech model", "Download one in GUI Settings → Dictation.");
            host.needModel();

            return;
        }

        // macOS asks once whether the app may use the microphone.
        if (host.platform === "darwin" && systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
            const allowed = await systemPreferences.askForMediaAccess("microphone").catch(() => false);

            if (!allowed) {
                host.ended();
                notify("Pi Pocket may not use the microphone", "Allow it in System Settings → Privacy & Security → Microphone.");

                return;
            }
        }

        // Messages of an earlier recording, still ending, never reach this one.
        let mine: Take | undefined;
        const listening = dictation.listen((message) => {
            if (mine !== undefined && take === mine) {
                onDictation(message);
            }
        });

        if (listening === undefined) {
            host.ended();

            return;
        }

        clearTimeout(hideTimer);

        const current: Take = {
            listening,
            phrases: [],
            timer: setTimeout(() => stop(false), LONGEST_MS),
            micClosed: false,
            stopping: false,
            dropped: false,
        };

        take = current;
        mine = current;
        setStatus("recording");
        showPill();
        await pillReady;

        // Stopped while the pill loaded: its "stop" already went, and the microphone must not open now.
        if (take !== current || current.stopping) {
            if (take === current && !current.micClosed) {
                current.micClosed = true;
                current.listening.stop(current.dropped);
            }

            return;
        }

        toPill({
            type: "record",
            title: "Listening",
            sound: host.settings().anywhere.sound,
            ...theme(),
        });
    };

    /** Ends the recording: `drop` throws its words away (Escape, a shortcut, or turning the feature off). */
    const stop = (drop: boolean): void => {
        if (take === undefined || take.stopping) {
            return;
        }

        take.stopping = true;
        take.dropped = drop;
        clearTimeout(take.timer);
        host.ended();
        if (pillLoaded) {
            toPill({ type: "stop" });
        }

        if (drop) {
            // Nothing more is wanted from the microphone: the dictation ends now, without waiting for the pill.
            take.micClosed = true;
            take.listening.stop(true);
            toPill({ type: "hide" });
            hidePillSoon(0);
            setStatus(problem === undefined ? "ready" : "error");
        } else {
            setStatus("working");
            toPill({ type: "show", state: "working", title: "Transcribing…" });
        }
    };

    function onDictation(message: PageMessage): void {
        if (take === undefined) {
            return;
        }

        switch (message.type) {
            case "result":
                if (message.final) {
                    take.phrases.push(message.text);
                    toPill({ type: "words", text: pasteText(take.phrases) });
                } else if (!take.stopping) {
                    toPill({ type: "words", text: pasteText([...take.phrases, message.text]) });
                }
                break;
            case "error":
                // "aborted" is a recording dropped on purpose.
                if (message.error !== "aborted") {
                    take.error = message.error;
                }
                break;
            case "end":
                finish(false);
                break;
        }
    }

    const finish = (lost: boolean): void => {
        const done = take;

        if (done === undefined) {
            return;
        }

        take = undefined;
        clearTimeout(done.timer);
        host.ended();

        // The dictation ended before the microphone closed (an error, the model unloaded): close it.
        if (!done.micClosed) {
            toPill({ type: "stop" });
        }

        setStatus(problem === undefined && hookRunning ? "ready" : hookRunning ? "error" : "off");

        if (done.dropped && !lost) {
            return;
        }

        const text = pasteText(done.phrases);

        if (done.error !== undefined && text === "") {
            showPill();
            toPill({ type: "show", state: "error", title: "Dictation stopped", detail: done.error });
            hidePillSoon(3500);

            return;
        }

        if (text === "") {
            showPill();
            toPill({ type: "show", state: "error", title: "No words heard" });
            hidePillSoon(1200);

            return;
        }

        void deliver(text).then(
            (pasted) => {
                showPill();
                toPill({ type: "show", state: "done", title: pasted ? "Pasted" : "Copied · " + (host.platform === "darwin" ? "⌘V" : "Ctrl+V") + " to paste", detail: text });
                hidePillSoon(pasted ? DONE_MS : 2500);
            },
            (error: unknown) => {
                showPill();
                toPill({ type: "show", state: "error", title: "Could not paste", detail: (error as Error).message });
                hidePillSoon(3500);
            },
        );
    };

    // ——— Paste ———

    /** The clipboard's items, read out in full so they can be written back. Empty when it held nothing or could not be read. */
    const saveClipboard = async (): Promise<ClipboardItem[]> => {
        try {
            const items = await clipboard.read();
            const copies: ClipboardItem[] = [];

            for (const item of items) {
                const data: Record<string, Blob | string> = {};

                for (const type of item.types.filter(keptType)) {
                    const value = await item.getType(type).catch(() => undefined);

                    // An empty value is a promise of data the clipboard's owner no longer gives: written back, it
                    // would hide the real types.
                    if (value instanceof Blob && value.size > 0) {
                        data[type] = value;
                    }
                }

                if (Object.keys(data).length > 0) {
                    copies.push(new ClipboardItem(data));
                }
            }

            return copies;
        } catch {
            return [];
        }
    };

    /** The trigger key is let go (or a moment passed): a held Alt or ⌘ would change the paste into another shortcut. */
    const keyReleased = async (): Promise<void> => {
        for (let waited = 0; host.keyHeld() && waited < 3000; waited += 30) {
            await new Promise((resolve) => setTimeout(resolve, 30));
        }
    };

    /** Pastes the words where the cursor is, or only copies them. Whether they were pasted. */
    const deliver = async (text: string): Promise<boolean> => {
        if (host.settings().anywhere.output === "copy" || copyOnly || hook === undefined || !hookRunning) {
            await clipboard.writeText(text);

            return false;
        }

        // What the clipboard holds now, every type of it, to give back after the paste.
        const before = await saveClipboard();

        await keyReleased();
        await clipboard.writeText(text);
        hook.keyTap(KEY.V, [host.platform === "darwin" ? KEY.Meta : KEY.Ctrl]);

        setTimeout(() => {
            void (async () => {
                // Something else was copied since: keep it.
                if ((await clipboard.readText()) !== text) {
                    return;
                }

                if (before.length === 0) {
                    clipboard.clear();
                } else {
                    await clipboard.write(before);
                }
            })().catch(() => undefined);
        }, RESTORE_MS);

        return true;
    };

    // ——— The key ———

    const onKeyDown = (event: { keycode: number }): void => host.key("down", event.keycode);
    const onKeyUp = (event: { keycode: number }): void => host.key("up", event.keycode);

    const loadHook = (): Hook => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        hook ??= (require("uiohook-napi") as { uIOhook: Hook }).uIOhook;

        return hook;
    };

    const stopHook = (): void => {
        if (hook !== undefined && hookRunning) {
            hook.removeAllListeners();

            try {
                hook.stop();
            } catch {
                // Already stopped.
            }
        }

        hookRunning = false;
    };

    let accessibilityTimer: NodeJS.Timeout | undefined;
    /** macOS was asked for Accessibility in this run of the app: once, or again with Ask again. */
    let asked = false;

    /**
     * Asks macOS for Accessibility, after the window shows. An entry from an earlier build makes macOS refuse this one and
     * not ask: the entry is removed first (it is on for an older build, or off), so macOS asks as it does the first time.
     */
    const askAccessibility = (): void => {
        if (asked) {
            return;
        }

        asked = true;
        host.afterWindow(() => {
            void (async () => {
                if (systemPreferences.isTrustedAccessibilityClient(false)) {
                    return;
                }

                const removed = await resetAccessibility(host.platform);

                diagnose(`dictate anywhere: asking macOS for Accessibility (old entry ${removed ? "removed" : "not removed"})`);

                if (!systemPreferences.isTrustedAccessibilityClient(false)) {
                    systemPreferences.isTrustedAccessibilityClient(true);
                }
            })();
        });
    };

    /** Starts or stops watching the key, as the settings say. */
    const apply = (): void => {
        applyHook();
        host.hookChanged();
    };

    const applyHook = (): void => {
        const settings = host.settings().anywhere;
        const { key } = host.settings().dictation;

        clearInterval(accessibilityTimer);
        stopHook();
        problem = undefined;
        refused = false;

        if (!settings.enabled) {
            stop(true);
            setStatus("off");
            pill?.destroy();
            pill = undefined;
            pillReady = undefined;

            return;
        }

        if (comboOf(key, host.platform) === undefined) {
            problem = "Choose a dictation key above: it is the key that starts Dictate anywhere.";
            setStatus("error");

            return;
        }

        if (copyOnly) {
            problem = "Wayland does not let apps hear keys in other apps or type into them. Use the tray's Dictate item: the words are copied for you to paste.";
            setStatus("error");
            pillWindow();

            return;
        }

        // macOS: the hook needs Accessibility. Ask once, then wait for it to be given.
        if (host.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(false)) {
            askAccessibility();
            problem = hookProblem(new Error("AXAPI"), host.platform);
            refused = true;
            setStatus("error");
            diagnose("dictate anywhere: macOS reports no Accessibility permission");
            accessibilityTimer = setInterval(() => {
                if (systemPreferences.isTrustedAccessibilityClient(false)) {
                    apply();
                }
            }, ACCESSIBILITY_CHECK_MS);

            return;
        }

        try {
            const loaded = loadHook();

            loaded.on("keydown", onKeyDown);
            loaded.on("keyup", onKeyUp);
            loaded.start();
            hookRunning = true;
            pillWindow();
            setStatus("ready");
        } catch (error) {
            stopHook();
            problem = hookProblem(error, host.platform);
            diagnose(`dictate anywhere could not start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
            setStatus("error");
        }
    };

    const notify = (title: string, body: string): void => {
        if (Notification.isSupported()) {
            new Notification({ title, body, icon: nativeImage.createFromPath(join(host.assets, "icon-192.png")) }).show();
        }
    };

    const applying = (): string => JSON.stringify([host.settings().anywhere, host.settings().dictation.key]);
    let applied = applying();

    apply();

    return {
        state(): AnywhereState {
            return { status, ...(problem === undefined ? {} : { message: problem }), copyOnly, permission: refused };
        },
        /** The settings were saved: watch another key, or stop, when Dictate anywhere's settings changed. */
        /**
         * macOS refuses the permission though its settings show it on (an older build's entry): remove the entry, then
         * start again, which asks macOS anew. Resolves false when the entry could not be removed.
         */
        async resetPermission(): Promise<boolean> {
            const removed = await resetAccessibility(host.platform);

            if (removed) {
                asked = false;
                apply();
            }

            return removed;
        },
        settingsChanged(): void {
            const next = applying();

            if (next !== applied) {
                applied = next;
                apply();
            }
        },
        /** The tray's Dictate item: starts a recording, or stops the one running (the key's too). */
        toggle(): void {
            if (take === undefined) {
                void start();
            } else {
                stop(false);
            }
        },
        recording: (): boolean => take !== undefined,
        /** Dictate anywhere can record now (it is on, and not Wayland's tray-only kind). */
        usable: (): boolean => host.settings().anywhere.enabled && status !== "off",
        /** The keyboard hook runs: it hears the key in every app, the app's own window too. */
        hooked: (): boolean => hookRunning,
        /** Starts a recording (the key pressed outside Pi Pocket's window). */
        start: (): void => void start(),
        /** Ends the recording: its words are pasted, or with `drop`, thrown away. */
        stop: (drop: boolean): void => stop(drop),
        /** Presses a key in whatever app has the focus. */
        tap: (code: number): void => {
            if (hookRunning) {
                hook?.keyTap(code);
            }
        },
        quit(): void {
            clearInterval(accessibilityTimer);
            stop(true);
            stopHook();
        },
    };
}
