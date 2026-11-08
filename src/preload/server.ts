/// <reference lib="dom" />
/**
 * The server page's preload: `window.pocketHost`, the app bridge Pi Pocket's web app uses (docs/embedders.md there).
 * The main process says first whether this frame may have it: only the main window's top frame, on the configured
 * server's origin. Anywhere else (a sign-in page in front of the server, another window) the page gets nothing.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { HostEvent, HostHello, ThemeToken } from "../shared/types";

/** The app bridge version this app speaks. */
const API_VERSION = 1;

const hello = ipcRenderer.sendSync("host:hello") as HostHello | null;

if (hello !== null && typeof hello === "object") {
    let visible = hello.visible;
    let listener: ((event: HostEvent) => void) | undefined;

    ipcRenderer.on("host:event", (_event, message: HostEvent) => {
        if (message.type === "visibility") {
            visible = message.visible;
        }

        try {
            listener?.(message);
        } catch (error) {
            console.error(error);
        }
    });

    contextBridge.exposeInMainWorld("pocketHost", {
        kind: "pi-pocket-gui",
        apiVersion: API_VERSION,
        capabilities: ["menu", "badge", "notify", "visibility", "pinned", "open", "newSession", "saveFile"],
        saveFile: (input: unknown) => ipcRenderer.invoke("host:save-file", input),
        // The heading of this app's group in Pi Pocket's menu (Pi Pocket's docs/embedders.md). An older Pi Pocket
        // does not ask for it, and shows its own heading.
        menuTitle: () => "Pi Pocket Desktop",
        menuItems: () => [{ id: "server-settings", label: "GUI Settings…", hint: "This desktop app's settings" }],
        invoke: (id: unknown) => {
            if (typeof id !== "string") {
                return false;
            }

            ipcRenderer.send("host:invoke", id);

            return true;
        },
        setBadge: (count: unknown) => {
            ipcRenderer.send("host:badge", count);
        },
        notify: (message: unknown) => {
            ipcRenderer.send("host:notify", message);
        },
        visible: () => visible,
        setPinned: (list: unknown) => {
            ipcRenderer.send("host:pinned", list);
        },
        // One listener: the page's `web/host.js` passes each event on to its own. A newer page also names the events
        // it handles: the app sends one added to version 1 later (newSession) only to a page that named it.
        subscribe: (next: unknown, events?: unknown) => {
            listener = typeof next === "function" ? (next as (event: HostEvent) => void) : undefined;
            ipcRenderer.send("host:events", Array.isArray(events) ? events.filter((each) => typeof each === "string") : []);
        },
    });

    watchTheme();
    reportRightClicks();
    openSessionLinksHere((url) => {
        if (listener === undefined) {
            return false;
        }

        try {
            listener({ type: "open", url });
        } catch (error) {
            console.error(error);
        }

        return true;
    });

    if (hello.dictation) {
        offerDictationKey(hello.dictationKey, offerDictation());
    }
}

/**
 * The session a click on a link asks to open here: the link's path (`/s/12`) when it is a plain click (the main button,
 * no ⌘, Ctrl, Shift, or Alt) on a link to one of this server's sessions. Null for anything else, which opens as it
 * would: a new window for ⌘ or Shift, the system browser for another site.
 */
export function sessionLinkHere(
    click: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
    href: string | null,
    base: string,
): string | null {
    if (href === null || click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) {
        return null;
    }

    let url: URL;

    try {
        url = new URL(href, base);
    } catch {
        return null;
    }

    return url.origin === new URL(base).origin && /^\/s\/\d+\/?$/.test(url.pathname) ? url.pathname.replace(/\/$/, "") : null;
}

/**
 * Pi Pocket opens every link in a reply in a new window, as a browser opens a new tab. In this app a plain click on a
 * link to a session opens it in this window instead, through the bridge's `open` event; ⌘ or Shift still opens a new
 * window. Only links the page left alone: PiP's panel opens its own session links already. `open` says whether the
 * page took it (it has subscribed).
 */
function openSessionLinksHere(open: (url: string) => boolean): void {
    document.addEventListener("click", (event) => {
        if (event.defaultPrevented || !(event.target instanceof Element)) {
            return;
        }

        const anchor = event.target.closest("a[href]");
        const path = anchor === null ? null : sessionLinkHere(event, anchor.getAttribute("href"), location.href);

        if (path !== null && open(path)) {
            event.preventDefault();
        }
    });
}

/** How long Pi Pocket's boot screen shows before the Reload button comes. */
export const BOOT_RELOAD_DELAY_MS = 3_000;

/** The timers a {@link BootWait} uses: the page's own, or fake ones in a test. */
export interface BootTimers {
    set: (callback: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
}

/**
 * When the Reload button shows: once the boot screen has shown for `delayMs` without a break. It goes as soon as the
 * boot screen goes, and a boot screen that comes back waits again from the start. No DOM: the page tells it, with
 * {@link update}, whether a boot screen shows now.
 */
export class BootWait {
    #booting = false;
    #shown = false;
    #timer: unknown;

    constructor(
        private readonly delayMs: number,
        private readonly timers: BootTimers,
        private readonly show: () => void,
        private readonly hide: () => void,
    ) {}

    /** Whether a full-screen boot screen shows now. Called again with the same answer, it changes nothing. */
    update(booting: boolean): void {
        if (booting === this.#booting) {
            return;
        }

        this.#booting = booting;

        if (booting) {
            this.#timer = this.timers.set(() => {
                this.#timer = undefined;
                this.#shown = true;
                this.show();
            }, this.delayMs);

            return;
        }

        if (this.#timer !== undefined) {
            this.timers.clear(this.#timer);
            this.#timer = undefined;
        }

        if (this.#shown) {
            this.#shown = false;
            this.hide();
        }
    }
}

/**
 * Whether one of these `.boot` elements is Pi Pocket's full-screen boot screen (`data-part="boot"`, its theme API),
 * and not the small loader inside a panel (`.boot.inline`).
 */
export function showsFullScreenBoot(boots: ArrayLike<{ classList: { contains: (name: string) => boolean }; getAttribute: (name: string) => string | null }>): boolean {
    for (let index = 0; index < boots.length; index++) {
        const boot = boots[index];

        if (boot !== undefined && boot.getAttribute("data-part") === "boot" && !boot.classList.contains("inline")) {
            return true;
        }
    }

    return false;
}

const BOOT_RELOAD_CSS = `
:host {
    all: initial;
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 12px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
}
button {
    font: 500 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 7px 14px;
    cursor: pointer;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
    animation: in 300ms ease-out;
}
button:hover { border-color: var(--fg); }
button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
button:disabled { cursor: progress; opacity: 0.7; }
b { font-weight: 650; }
@keyframes in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { button { animation: none; } }
:host(.still) button { animation: none; }
`;

/**
 * A "Taking a while? Reload" button over Pi Pocket's boot screen once it has shown for 3 s: a server that never answers
 * the app's start (its first `/api/me`) otherwise leaves only the menu's Reload. It is in a closed shadow root, so the
 * page's styles do not reach it and its own stay inside. A click asks the main process to reload, as the menu does.
 */
function offerBootReload(): void {
    // A live list: reading it on each change costs little, also on a busy page.
    const boots = document.getElementsByClassName("boot");
    let host: HTMLElement | undefined;

    const color = (style: CSSStyleDeclaration, names: string[], fallback: string): string => {
        for (const name of names) {
            const value = style.getPropertyValue(`--${name}`).trim();

            // Pi Pocket's --border is a width, not a color: take only a color.
            if (value !== "" && CSS.supports("color", value)) {
                return value;
            }
        }

        return fallback;
    };

    const show = (): void => {
        const root = document.documentElement;
        const style = getComputedStyle(root);
        const light = root.dataset.mode === "light";

        host = document.createElement("pi-pocket-gui-reload");

        if (root.dataset.motion === "reduced") {
            host.className = "still";
        }

        const shadow = host.attachShadow({ mode: "closed" });
        const sheet = document.createElement("style");
        const button = document.createElement("button");
        const strong = document.createElement("b");

        sheet.textContent = BOOT_RELOAD_CSS;
        button.type = "button";
        button.style.setProperty("--fg", color(style, ["text"], light ? "#343b58" : "#c0caf5"));
        button.style.setProperty("--bg", color(style, ["card"], light ? "#e6e7ed" : "#1f2335"));
        button.style.setProperty("--line", color(style, ["border", "line"], light ? "#c4c8da" : "#3b4261"));
        strong.textContent = "Reload";
        button.append("Taking a while? ", strong);
        button.addEventListener("click", () => {
            button.disabled = true;
            ipcRenderer.send("host:reload");
        });
        shadow.append(sheet, button);
        (document.body ?? root).append(host);
    };

    const hide = (): void => {
        host?.remove();
        host = undefined;
    };

    const wait = new BootWait(BOOT_RELOAD_DELAY_MS, { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }, show, hide);
    const check = (): void => wait.update(showsFullScreenBoot(boots));

    // The document itself, not its root: the boot screen is in the HTML, before any script, and a page whose script
    // never loads never reaches DOMContentLoaded.
    new MutationObserver(check).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-part"] });
    check();
}

// Only on the server's page (the same check as the bridge), never the settings page or the tray popup.
if (hello !== null && typeof hello === "object") {
    offerBootReload();
}

/** What the main process sends about one dictation (src/main/dictation/dictation.ts, PageMessage). */
type DictationMessage =
    | { id: number; type: "result"; text: string; final: boolean }
    | { id: number; type: "error"; error: string }
    | { id: number; type: "end" };

/**
 * Offline dictation: stands in the browser's SpeechRecognition (Electron has no speech service of its own), so Pi
 * Pocket's mic button and Alt+V work unchanged. The microphone is read here, at 16 kHz, and goes to the main process,
 * which recognises it on this computer.
 */
/**
 * The dictation key in this window (src/main/dictation/page-mic.ts): presses the mic Alt+V would use, PiP's while it
 * shows, else the session's, and none under a sheet or the launcher, as with Alt+V. A click on Pi Pocket's own button, so
 * its dictation runs and the button shows it.
 */
/** Whether a key event is part of the dictation key (as src/main/dictation/key-combo.ts writes it). */
function keyOfCombo(combo: string, event: KeyboardEvent): boolean {
    const parts = combo.split("+");
    const main = parts.find((part) => !/^(Control|Alt|Shift|Meta)(Left|Right)?$/.test(part));

    if (main === undefined) {
        return parts.includes(event.code);
    }

    const families = { Control: event.ctrlKey, Alt: event.altKey, Shift: event.shiftKey, Meta: event.metaKey };

    return event.code === main && Object.entries(families).every(([family, down]) => down === parts.includes(family));
}

function offerDictationKey(first: string | null, dictation: Dictation): void {
    let code = first;

    ipcRenderer.on("host:dictation-key", (_event, next: unknown) => {
        code = typeof next === "string" ? next : null;
    });

    // The app acts on the key (before-input-event); Pi Pocket never sees it, nor the window's menu an Alt alone. A key
    // alone or modifiers alone ("AltRight", "ControlLeft+AltLeft"): each of their keys. A combination with a key
    // ("Control+Shift+KeyD"): that key while exactly its modifiers are down, so the modifiers still work as usual.
    const swallow = (event: KeyboardEvent): void => {
        if (code !== null && keyOfCombo(code, event)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    };

    window.addEventListener("keydown", swallow, true);
    window.addEventListener("keyup", swallow, true);

    const shown = (element: Element | null): element is HTMLElement =>
        element instanceof HTMLElement && element.isConnected && element.getClientRects().length > 0;

    const mic = (): HTMLElement | undefined => {
        if (shown(document.querySelector('[data-part~="sheet"]')) || shown(document.querySelector('[data-part~="launcher"]'))) {
            return undefined;
        }

        const pip = document.querySelector('[data-part~="pip"] .mic-button');

        if (shown(pip)) {
            return pip;
        }

        const boxes = Array.from(document.querySelectorAll('[data-part~="composer"] .mic-button')).filter(shown);

        return boxes.at(-1);
    };

    const field = dictateIntoField(dictation, shown);

    ipcRenderer.on("host:dictate", (_event, request: { n: number; action: "toggle" | "stop" }) => {
        const own = field(request.action);

        if (own !== undefined) {
            ipcRenderer.send("host:dictate-answer", request.n, own);

            return;
        }

        const button = mic();
        const listening = button?.getAttribute("aria-pressed") === "true";

        if (button !== undefined && (request.action === "toggle" || listening)) {
            button.click();
        }

        ipcRenderer.send("host:dictate-answer", request.n, { found: button !== undefined, listening });
    });
}

/** The page's offline dictation (offerDictation), for the dictation key's own use too. */
interface Dictation {
    start: (listener: unknown) => number;
    stop: (id: unknown, drop: unknown) => void;
}

/** Fields with a mic of their own: the session's message box and PiP's. The key presses that mic instead. */
const OWN_MIC = '[data-part~="composer"], [data-part~="pip"]';

/** The words to insert after `before` (the text left of the caret): a space between them, unless one is there. */
export function joinDictated(before: string, words: string): string {
    const text = words.trim();

    return text === "" || before === "" || /\s$/.test(before) ? text : ` ${text}`;
}

/**
 * The dictation key in any other text field of the page (an ask card's own answer, a search box, a rename): it
 * dictates into that field, and each finished phrase is typed at the caret, as if typed (an input event, one undo
 * step). The field shows that it listens by an outline. Returns the answer for the key, or undefined to press a mic.
 */
function dictateIntoField(dictation: Dictation, shown: (element: Element | null) => element is HTMLElement) {
    let current: { id: number; field: HTMLElement } | undefined;

    const mark = (field: HTMLElement, on: boolean): void => {
        if (on) {
            field.setAttribute("data-gui-dictating", "");
        } else {
            field.removeAttribute("data-gui-dictating");
        }
    };

    const style = document.createElement("style");

    style.textContent = `[data-gui-dictating] { outline: 2px solid var(--err, #e5484d) !important; outline-offset: 1px !important; }`;
    (document.head ?? document.documentElement).append(style);

    const type = (field: HTMLElement, words: string): void => {
        if (!field.isConnected) {
            return;
        }

        if (document.activeElement !== field) {
            field.focus({ preventScroll: true });
        }

        let before = "";

        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
            before = field.value.slice(0, field.selectionStart ?? field.value.length);
        } else {
            const selection = document.getSelection();
            const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : undefined;

            if (range !== undefined && field.contains(range.startContainer)) {
                range.setStart(field, 0);
                before = range.toString();
            }
        }

        const text = joinDictated(before, words);

        if (text !== "") {
            // As typing does: the page hears an input event, and Ctrl+Z takes it back.
            document.execCommand("insertText", false, text);
        }
    };

    const start = (field: HTMLElement): void => {
        let id = 0;

        id = dictation.start((message: DictationMessage) => {
            if (current?.id !== id) {
                return;
            }

            if (message.type === "result" && message.final) {
                type(field, message.text);
            } else if (message.type === "end") {
                mark(field, false);
                current = undefined;
            }
        });
        current = { id, field };
        mark(field, true);
    };

    return (action: "toggle" | "stop"): { found: boolean; listening: boolean } | undefined => {
        if (current !== undefined) {
            dictation.stop(current.id, false);

            return { found: true, listening: true };
        }

        const focused = textField(document.activeElement);

        // A mic already listening (pressed by hand) is ended by the key, wherever the caret went since.
        const listening = document.querySelector('.mic-button[aria-pressed="true"]') !== null;

        if (action === "stop" || listening || focused === undefined || !shown(focused) || focused.closest(OWN_MIC) !== null) {
            return undefined;
        }

        start(focused);

        return { found: true, listening: false };
    };
}

function offerDictation(): Dictation {
    let next = 0;
    const listeners = new Map<number, (message: DictationMessage) => void>();
    const captures = new Map<number, () => void>();

    const release = (id: number): void => {
        captures.get(id)?.();
        captures.delete(id);
    };

    ipcRenderer.on("host:dictation", (_event, message: DictationMessage) => {
        const listener = listeners.get(message.id);

        if (message.type === "end") {
            release(message.id);
            listeners.delete(message.id);
        }

        try {
            listener?.(message);
        } catch (error) {
            console.error(error);
        }
    });

    const capture = async (id: number): Promise<void> => {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });

        // Stopped while the microphone was asked for.
        if (!listeners.has(id)) {
            stream.getTracks().forEach((track) => track.stop());

            return;
        }

        // The browser resamples the microphone to the model's rate. A script processor needs no module, which a page's
        // content security policy could block.
        const context = new AudioContext({ sampleRate: 16_000 });
        const source = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(2048, 1, 1);
        const mute = context.createGain();

        mute.gain.value = 0;
        processor.onaudioprocess = (event) => {
            ipcRenderer.send("host:dictation-audio", id, new Float32Array(event.inputBuffer.getChannelData(0)));
        };
        source.connect(processor);
        processor.connect(mute);
        mute.connect(context.destination);

        captures.set(id, () => {
            processor.onaudioprocess = null;
            source.disconnect();
            processor.disconnect();
            stream.getTracks().forEach((track) => track.stop());
            void context.close();
        });
    };

    const dictation = {
        /** Starts listening; returns the dictation's number. `listener` hears its results, errors, and end. */
        start: (listener: unknown): number => {
            const id = ++next;

            if (typeof listener !== "function") {
                return id;
            }

            listeners.set(id, listener as (message: DictationMessage) => void);

            const fail = (error: string): void => {
                release(id);
                ipcRenderer.send("host:dictation-stop", id, true);
                (listener as (message: DictationMessage) => void)({ id, type: "error", error });
                (listener as (message: DictationMessage) => void)({ id, type: "end" });
                listeners.delete(id);
            };

            void (ipcRenderer.invoke("host:dictation-start", id) as Promise<{ ok?: true; error?: string }>).then(
                async (answer) => {
                    if (answer.error !== undefined) {
                        fail(answer.error);

                        return;
                    }

                    try {
                        await capture(id);
                    } catch (error) {
                        const name = (error as Error).name;

                        fail(name === "NotAllowedError" ? "not-allowed" : name === "NotFoundError" ? "audio-capture" : (error as Error).message);
                    }
                },
                (error: unknown) => {
                    fail((error as Error).message);
                },
            );

            return id;
        },
        /** Stops listening; the words said so far are still recognised, unless `drop`. */
        stop: (id: unknown, drop: unknown): void => {
            if (typeof id === "number" && listeners.has(id)) {
                release(id);
                ipcRenderer.send("host:dictation-stop", id, drop === true);
            }
        },
    };

    contextBridge.executeInMainWorld({ func: installRecognition, args: [dictation] });

    return dictation;
}

/**
 * Runs in the page's own world: a SpeechRecognition with the calls Pi Pocket's web/voice.js makes (lang, continuous,
 * interimResults, start, stop, abort, onresult, onerror, onend). Self-contained: it is sent to the page as source.
 */
function installRecognition(dictation: {
    start: (listener: (message: DictationMessage) => void) => number;
    stop: (id: number, drop: boolean) => void;
}): void {
    interface Alternative {
        transcript: string;
        confidence: number;
    }

    const result = (transcript: string, isFinal: boolean) => {
        const alternative: Alternative = { transcript, confidence: 1 };

        return Object.assign([alternative], { isFinal, item: (index: number) => (index === 0 ? alternative : null) });
    };

    class OfflineSpeechRecognition extends EventTarget {
        lang = "";
        continuous = false;
        interimResults = false;
        maxAlternatives = 1;
        onresult: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onend: ((event: Event) => void) | null = null;
        onstart: ((event: Event) => void) | null = null;
        #id: number | undefined;
        #finals: ReturnType<typeof result>[] = [];

        start(): void {
            if (this.#id !== undefined) {
                throw new DOMException("Dictation has already started.", "InvalidStateError");
            }

            this.#finals = [];

            const id = dictation.start((message) => {
                if (this.#id !== id) {
                    return;
                }

                if (message.type === "result") {
                    if (message.text === "" || (!message.final && !this.interimResults)) {
                        return;
                    }

                    const heard = result(message.text, message.final);
                    const results = [...this.#finals, heard];

                    if (message.final) {
                        this.#finals.push(heard);
                    }

                    this.#fire("result", { resultIndex: this.#finals.length - (message.final ? 1 : 0), results: Object.assign(results, { item: (index: number) => results[index] ?? null }) });

                    if (message.final && !this.continuous) {
                        this.stop();
                    }
                } else if (message.type === "error") {
                    this.#fire("error", { error: message.error, message: message.error });
                } else {
                    this.#id = undefined;
                    this.#fire("end", {});
                }
            });

            this.#id = id;
            queueMicrotask(() => {
                this.#fire("start", {});
            });
        }

        stop(): void {
            if (this.#id !== undefined) {
                dictation.stop(this.#id, false);
            }
        }

        abort(): void {
            if (this.#id !== undefined) {
                dictation.stop(this.#id, true);
            }
        }

        #fire(type: string, fields: Record<string, unknown>): void {
            const event = Object.assign(new Event(type), fields);
            const handler = (this as unknown as Record<string, unknown>)[`on${type}`];

            if (typeof handler === "function") {
                (handler as (event: Event) => void).call(this, event);
            }

            this.dispatchEvent(event);
        }
    }

    Object.defineProperty(globalThis, "SpeechRecognition", { value: OfflineSpeechRecognition, configurable: true, writable: true });
    Object.defineProperty(globalThis, "webkitSpeechRecognition", { value: OfflineSpeechRecognition, configurable: true, writable: true });
}

/**
 * The page's own right-click, for the app's menu (src/main/window/themed-menu.ts). Electron's `context-menu` event opens the
 * menu wherever it fires; macOS has been known not to fire it for this view, and then this report is what opens it.
 * Only a right-click the page left alone: Pi Pocket's own menus (a session row's) call preventDefault, and the
 * listener runs after theirs, as the event bubbles. A right-click, a two-finger click, and a Control+click on macOS
 * all arrive as this one event.
 */
function reportRightClicks(): void {
    document.addEventListener("contextmenu", (event) => {
        if (event.defaultPrevented) {
            return;
        }

        const field = textField(event.target);
        const selection = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
            ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)
            : document.getSelection()?.toString() ?? "";

        ipcRenderer.send("host:context-menu", {
            x: event.clientX,
            y: event.clientY,
            isEditable: field !== undefined,
            selectionText: selection,
        });
    });
}

const TEXT_INPUTS = new Set(["", "text", "search", "url", "tel", "email", "password", "number"]);

/** The text field a right-click landed in, the way Chromium decides what is editable; none on anything else. */
function textField(target: EventTarget | null): HTMLElement | undefined {
    if (!(target instanceof HTMLElement)) {
        return undefined;
    }

    if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && TEXT_INPUTS.has(target.type))) {
        return target.readOnly || target.disabled ? undefined : target;
    }

    return target.isContentEditable ? target : undefined;
}

// The tokens src/main/window/theme.ts takes. A preload cannot import a module of its own, so the list is here too.
const TOKENS: ThemeToken[] = [
    "desk",
    "bg",
    "card",
    "text",
    "body",
    "muted",
    "accent",
    "accent-fill",
    "accent-ink",
    "brand",
    "ok",
    "warn",
    "err",
    "code-bg",
];

/**
 * Pi Pocket's colors as the page shows them, for the app's settings screen, window, and tray (src/main/window/theme.ts): read
 * at start and again whenever the theme changes (the root's attributes and inline variables, or a theme stylesheet).
 * Each token is resolved to #rrggbb[aa] by painting it, so color-mix() and theme files of any form come out the same.
 */
function watchTheme(): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sent = "";

    const read = (): void => {
        const root = document.documentElement;
        const style = getComputedStyle(root);

        // The configured origin can also serve an error, sign-in, or unrelated page. A missing/invalid var()
        // inherits its text color (often black), which is not a theme. Wait for a complete palette instead.
        if (TOKENS.some((token) => {
            const value = style.getPropertyValue(`--${token}`).trim();

            return value === "" || !CSS.supports("color", value);
        })) {
            return;
        }

        const probe = document.createElement("span");
        const canvas = document.createElement("canvas");

        canvas.width = canvas.height = 1;

        const paint = canvas.getContext("2d", { willReadFrequently: true });

        if (paint === null) {
            return;
        }

        probe.style.display = "none";
        root.append(probe);

        const colors: Record<string, string> = {};

        try {
            for (const token of TOKENS) {
                // The root's own value: the app's see-through CSS changes --bg on the body, never on the root.
                probe.style.color = "";
                probe.style.color = `var(--${token})`;

                const color = getComputedStyle(probe).color;

                paint.clearRect(0, 0, 1, 1);
                paint.fillStyle = color;
                paint.fillRect(0, 0, 1, 1);

                const [r = 0, g = 0, b = 0, a = 0] = paint.getImageData(0, 0, 1, 1).data;
                const hex = (value: number) => value.toString(16).padStart(2, "0");

                colors[token] = `#${hex(r)}${hex(g)}${hex(b)}${a === 255 ? "" : hex(a)}`;
            }
        } finally {
            probe.remove();
        }

        const theme = { mode: root.dataset.mode === "light" ? "light" : "dark", colors };
        const json = JSON.stringify(theme);

        if (json !== sent) {
            sent = json;
            ipcRenderer.send("host:theme", theme);
        }
    };

    const soon = (): void => {
        clearTimeout(timer);
        timer = setTimeout(read, 150);
    };

    const start = (): void => {
        read();
        new MutationObserver(soon).observe(document.documentElement, { attributes: true });
        new MutationObserver(soon).observe(document.head, { childList: true, subtree: true, attributes: true });
        // A theme's stylesheet applies when it loads, after the element that asks for it.
        document.addEventListener("load", soon, true);
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
        start();
    }
}
