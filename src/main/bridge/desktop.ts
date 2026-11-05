/**
 * The app's side of the app bridge (src/preload/server.ts): what the server's page asks for (the badge, native
 * notifications, the pinned sessions, menu items), and what the app tells it (its window shown or hidden, a session to
 * open, an approval answered in a notification). It also owns the tray's menu and icon, which show the pins and badge.
 *
 * Every call is checked: it must come from the main window's server view, its top frame, on the server's origin.
 */
import { join } from "node:path";
import {
    app,
    ipcMain,
    Menu,
    nativeImage,
    nativeTheme,
    Notification,
    powerMonitor,
    systemPreferences,
    type BaseWindow,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
    type MenuItemConstructorOptions,
    type NativeImage,
    type Tray,
    type WebContents,
} from "electron";
import type { HostEvent, HostHello, HostNotification, PinnedSession, Settings, ThemeColors } from "../../shared/types";
import { cornerDot, dotBitmap, paintDot, tint } from "./badge-image";
import { readTheme, rgbOf } from "../window/theme";
import { pinLabel, readBadge, readNotification, readPinned } from "./bridge-input";
import { offersAllow, showCall } from "./notice-text";
import { FinishNotices, IDLE_SECONDS, isFinish, type Notice } from "./notice-group";
import { buildTrayMenu, readAccent } from "../tray/tray-menu";
import { setUpTrayPopup } from "../tray/tray-popup";
import { type NewSessionView, PendingNewSession, readPageEvents } from "./new-session";
import { activity, diagnose } from "../diagnostics/stall-watchdog";
import { saveFile } from "./save-file";

/** What the bridge needs from the rest of the app. */
export interface DesktopHost {
    assets: string;
    window: () => BaseWindow;
    /** The server view's contents: the only page that gets the bridge. */
    contents: () => WebContents;
    /** The configured server's origin. */
    origin: () => string;
    settings: () => Settings;
    /** The server view shows (not the config screen). */
    showingServer: () => boolean;
    /** The server view has a server's page loaded, or loading. */
    serverLoaded: () => boolean;
    /** Show the server view, when it has the server loaded. Whether it shows now. */
    showServer: () => boolean;
    tray: () => Tray | undefined;
    showWindow: () => void;
    toggleWindow: () => void;
    openSettings: () => void;
    /** Load the server's page again, as the menu's Reload does: the page's boot screen took too long. */
    reloadServer: () => void;
    /** The tray's Reload line while the window is up (its label says when the page does not answer). */
    reloadItem: () => { label: string; click: () => void } | undefined;
    quit: () => void;
    /** A tray line for the app's own update, when there is one to take. */
    updateItem: () => { label: string; click: () => void } | undefined;
    /** Pi Pocket's colors now: the tray's π takes the brand color. */
    theme: () => ThemeColors;
    /** The server's page shows other colors. */
    themeChanged: (theme: ThemeColors) => void;
    /** Offline dictation has an engine for this computer. */
    dictation: () => boolean;
    /** The dictation key as the page names it (KeyboardEvent.code); undefined: none. */
    dictationKey: () => string | undefined;
    /** A right-click the page left alone, as its preload saw it (src/main/window/themed-menu.ts reads it). */
    pageRightClick: (click: unknown) => void;
    /** The tray's Dictate item (Dictate anywhere is on), with what a click does; undefined when it is off. */
    dictateItem: () => { label: string; click: () => void } | undefined;
}

function originOf(url: string): string | undefined {
    try {
        return new URL(url).origin;
    } catch {
        return undefined;
    }
}

/** Notifications that show now, by tag: Electron drops a notification's events once nothing holds it. */
const shown = new Map<string, Notification>();
/** The one notification for sessions that finished (src/main/bridge/notice-group.ts): its id, and the one that shows. */
const FINISHED_ID = "pi-finished";
let finished: Notification | undefined;
let pins: PinnedSession[] = [];
let badge = 0;
let lastVisible: boolean | undefined;
/** The host events the page said it handles, as it subscribed; undefined until it did. */
let pageEvents: Set<string> | undefined;
let trayIcons: { plain: NativeImage; dot: NativeImage; recording: NativeImage; brand: string; dotColor: string } | undefined;
/** Dictate anywhere records: the tray's π is red. */
let recording = false;

export function setUpDesktop(host: DesktopHost): {
    /** The window was shown, hidden, minimized, restored, or the view changed: tell the page if that changed. */
    visibilityChanged: () => void;
    /** The tray was made, or the desktop's settings changed: draw the tray again. */
    refreshTray: () => void;
    /** The call came from the server's page: its view, its top frame, on the server's origin. */
    fromServerPage: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
    /** The server view left the server, or loaded again: what its page said no longer holds. */
    reset: () => void;
    /**
     * New session: show the window, and ask the page to open its New session sheet when it shows and can. On the
     * settings screen, with no server, or with an older Pi Pocket, only the window shows. `starting`: the app was
     * started for it (a link), and connects now: it waits for the page as for one that is loading.
     */
    newSession: (starting?: boolean) => void;
    /** Dictate anywhere starts or stops recording: the tray's π turns red, and back. */
    setRecording: (on: boolean) => void;
} {
    const fromServerPage = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
        const frame = event.senderFrame;

        return (
            event.sender === host.contents() &&
            frame !== null &&
            frame.parent === null &&
            originOf(frame.url) === host.origin()
        );
    };

    const visible = (): boolean => {
        const window = host.window();

        return window.isVisible() && !window.isMinimized() && host.showingServer();
    };

    /** The person looks at Pi Pocket: its window shows it, in front. */
    const looking = (): boolean => visible() && host.window().isFocused();

    const send = (event: HostEvent): void => {
        const contents = host.contents();

        if (!contents.isDestroyed()) {
            contents.send("host:event", event);
        }
    };

    // A New session that waits for the page to subscribe (it is loading).
    const pendingNewSession = new PendingNewSession(() => send({ type: "newSession" }));
    const view = (): NewSessionView => ({ showingServer: host.showingServer(), serverLoaded: host.serverLoaded(), pageEvents });

    const newSession = (starting = false): void => {
        host.showWindow();
        pendingNewSession.request(view(), starting);
    };

    const open = (url: string): void => {
        host.showWindow();

        if (host.showServer()) {
            send({ type: "open", url });
        }
    };

    /** The tray's π, as the rail of Pi Pocket's page draws it, in the theme's brand color; with a dot when sessions need you. */
    const icons = (): { plain: NativeImage; dot: NativeImage; recording: NativeImage } => {
        const colors = host.theme().colors;

        if (trayIcons !== undefined && trayIcons.brand === colors.brand && trayIcons.dotColor === colors.err) {
            return trayIcons;
        }

        // 18 points in macOS's menu bar, 22 in other trays; drawn at twice that for sharp screens.
        const mask = nativeImage.createFromPath(join(host.assets, process.platform === "darwin" ? "tray-pi-36.png" : "tray-pi-44.png"));
        const { width, height } = mask.getSize();
        const pixels = Buffer.from(mask.toBitmap());
        const red = Buffer.from(pixels);

        tint(red, rgbOf(colors.err));
        paintDot(red, width, height, cornerDot(width, height), rgbOf(colors.err));

        const recordingIcon = nativeImage.createFromBitmap(red, { width, height, scaleFactor: 2 });

        tint(pixels, rgbOf(colors.brand));

        const plain = nativeImage.createFromBitmap(Buffer.from(pixels), { width, height, scaleFactor: 2 });

        paintDot(pixels, width, height, cornerDot(width, height), rgbOf(colors.err));

        const dot = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 2 });

        trayIcons = { plain, dot, recording: recordingIcon, brand: colors.brand, dotColor: colors.err };

        return trayIcons;
    };

    // The tray is created after this runs (createTray), so the clicks are attached on the first refresh, once.
    let clicksAttached = false;

    const attachClicks = (tray: Tray): void => {
        if (clicksAttached || process.platform !== "win32") {
            return;
        }

        clicksAttached = true;
        // The left-click handler lives in createTray and shows or hides the window. A right-click opens the menu, and
        // the next left-click closes it first, so the window does not also move.
        tray.on("right-click", () => popup?.toggle());
        tray.on("click", () => {
            if (popup?.isOpen() === true) {
                popup.close();
            }
        });
    };

    /** The native tray menu: macOS and Linux always, Windows when its popup does not appear. */
    const nativeTemplate = (): MenuItemConstructorOptions[] => {
        const pinItems: MenuItemConstructorOptions[] = pins.map((pin) => ({
            label: pinLabel(pin),
            toolTip: pin.label,
            click: () => open(pin.url),
        }));
        const update = host.updateItem();
        const reload = host.reloadItem();
        const dictate = host.dictateItem();

        return [
            { label: badge > 0 ? `Open Pi Pocket  (${badge} need you)` : "Open Pi Pocket", click: host.showWindow },
            { label: "New session", click: () => newSession() },
            ...(dictate === undefined ? [] : [{ label: dictate.label, click: dictate.click }]),
            ...(reload === undefined ? [] : [{ label: reload.label, click: reload.click }]),
            ...(update === undefined ? [] : [{ label: update.label, click: update.click }]),
            ...(pinItems.length > 0
                ? [{ type: "separator" as const }, { label: "Pinned", enabled: false }, ...pinItems]
                : []),
            { type: "separator" },
            { label: "GUI Settings…", click: host.openSettings },
            { type: "separator" },
            { label: "Quit", click: host.quit },
        ];
    };

    const refreshTray = (): void => {
        const tray = host.tray();

        if (tray === undefined || tray.isDestroyed()) {
            return;
        }

        attachClicks(tray);
        if (process.platform === "win32") {
            // A native Win32 menu cannot be restyled, so Windows gets the popup. It opens on click and on right-click.
            tray.setContextMenu(null);
        } else {
            tray.setContextMenu(Menu.buildFromTemplate(nativeTemplate()));
        }

        tray.setImage(recording ? icons().recording : badge > 0 ? icons().dot : icons().plain);
        tray.setToolTip(recording ? "Pi Pocket — recording" : badge > 0 ? `Pi Pocket — ${badge} ${badge === 1 ? "session needs" : "sessions need"} you` : "Pi Pocket");
        popup?.refresh();
    };

    const menuModel = () =>
        buildTrayMenu({
            badge,
            update: host.updateItem(),
            reload: host.reloadItem(),
            pins,
            showWindow: host.showWindow,
            newSession: () => newSession(),
            dictate: host.dictateItem(),
            openSettings: host.openSettings,
            quit: host.quit,
            openPin: open,
        });

    // Windows only. macOS and Linux keep the native menu above, and the trayMenu setting is ignored there.
    const popup =
        process.platform === "win32"
            ? setUpTrayPopup({
                  tray: host.tray,
                  menu: menuModel,
                  style: () => host.settings().appearance.trayMenu,
                  windowsDark: () => nativeTheme.shouldUseDarkColors,
                  theme: host.theme,
                  accent: () => readAccent(systemPreferences.getAccentColor()),
                  activate: (id) => menuModel().actions.find((action) => action.id === id)?.run(),
                  focusTray: () => host.tray()?.focus(),
                  fallback: () => {
                      const tray = host.tray();

                      if (tray !== undefined && !tray.isDestroyed()) {
                          tray.popUpContextMenu(Menu.buildFromTemplate(nativeTemplate()));
                      }
                  },
                  activity,
                  diagnose,
              })
            : undefined;

    const setBadge = (count: number): void => {
        badge = count;
        // macOS's dock, and Unity launchers on Linux. Windows has no count: an overlay dot instead.
        app.setBadgeCount(count);

        if (process.platform === "win32") {
            const window = host.window() as BaseWindow & {
                setOverlayIcon?: (overlay: NativeImage | null, description: string) => void;
            };
            const size = 16;

            window.setOverlayIcon?.(
                count > 0 ? nativeImage.createFromBitmap(dotBitmap(size), { width: size, height: size }) : null,
                count > 0 ? `${count} need you` : "",
            );
        }

        refreshTray();
    };

    /** The one "Pi finished" notification shows this, in place of what it said before. */
    const showFinished = (notice: Notice): void => {
        const settings = host.settings().notifications;

        // Notifications were turned off while finishes waited for the person.
        if (!settings.enabled || !Notification.isSupported()) {
            return;
        }

        const notification = new Notification({
            title: notice.title,
            body: notice.body,
            silent: !settings.sound,
            icon: join(host.assets, "icon-192.png"),
            id: FINISHED_ID,
            groupId: "pi-pocket",
        });

        // The one it replaces goes first: on macOS a close removes what shows with its id, so after the show it would
        // remove the new one. Its close event then finds that it is no longer the one that shows.
        const before = finished;
        finished = notification;
        before?.close();

        notification.on("click", () => {
            if (finished === notification) {
                finished = undefined;
                finishes.seen();
            }

            open(notice.url);
        });
        notification.on("close", (event) => {
            // On Windows a banner that times out moves to the Action Center: it is still there to see.
            if (finished === notification && event.reason !== "timedOut") {
                finished = undefined;
                finishes.seen();
            }
        });
        notification.on("failed", () => {
            if (finished === notification) {
                finished = undefined;
            }
        });
        activity("notification show");
        notification.show();
    };

    const finishes = new FinishNotices({
        idle: () => powerMonitor.getSystemIdleState(IDLE_SECONDS),
        show: showFinished,
        setTimer: (run, ms) => setTimeout(run, ms),
        clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
    });

    // Sleep and the lock screen: finishes wait for the person, and show as one when they are back.
    powerMonitor.on("suspend", () => finishes.asleep(true));
    powerMonitor.on("lock-screen", () => finishes.asleep(true));
    powerMonitor.on("user-did-resign-active", () => finishes.asleep(true));
    powerMonitor.on("resume", () => finishes.asleep(false));
    powerMonitor.on("unlock-screen", () => finishes.asleep(false));
    powerMonitor.on("user-did-become-active", () => finishes.asleep(false));

    const notify = (message: HostNotification): void => {
        const settings = host.settings().notifications;

        if (!settings.enabled || !Notification.isSupported()) {
            return;
        }

        if (isFinish(message)) {
            // The person looks at Pi Pocket now: the finishes before this one were seen there.
            if (looking() && !finishes.away()) {
                finishes.seen();
            }

            finishes.add(message);

            return;
        }

        const approval = message.approval;
        const call = approval === undefined ? undefined : showCall(approval.call, settings.maxCallLength);
        const allow = approval !== undefined && call !== undefined && offersAllow(settings.allowFromNotification, approval.may, call);
        // Allow comes first where it is offered; Deny is always there for an approval.
        const actions = approval === undefined ? [] : allow ? ["Allow", "Deny"] : ["Deny"];
        const notification = new Notification({
            title: message.title,
            body: call !== undefined ? call.text : message.body,
            silent: !settings.sound,
            icon: join(host.assets, "icon-192.png"),
            urgency: message.urgency === "high" ? "critical" : "normal",
            timeoutType: message.urgency === "high" ? "never" : "default",
            actions: actions.map((text) => ({ type: "button", text })),
            ...(message.tag === "" ? {} : { id: message.tag, groupId: "pi-pocket" }),
        });
        const tag = message.tag === "" ? `untagged-${Date.now()}-${Math.random()}` : message.tag;

        shown.get(tag)?.close();
        shown.set(tag, notification);

        const forget = () => {
            if (shown.get(tag) === notification) {
                shown.delete(tag);
            }
        };

        notification.on("click", () => {
            forget();
            open(message.url);
        });
        notification.on("action", (event) => {
            const chosen = actions[event.actionIndex];

            forget();

            if (approval === undefined || chosen === undefined) {
                return;
            }

            // The page answers with its own sign-in; the server checks again that the person may.
            send({ type: "approve", id: approval.id, allow: chosen === "Allow" });
        });
        notification.on("close", forget);
        notification.on("failed", forget);
        activity("notification show");
        notification.show();
    };

    ipcMain.on("host:hello", (event) => {
        // Only the server view's top frame on the server's origin gets the bridge: never a frame, another window, or a
        // sign-in page in front of the server.
        const hello: HostHello | null = fromServerPage(event)
            ? { visible: visible(), dictation: host.dictation(), dictationKey: host.dictationKey() ?? null }
            : null;

        event.returnValue = hello;
    });

    ipcMain.handle("host:save-file", (event, input: unknown) => {
        if (!fromServerPage(event)) {
            return { ok: false, error: "Not allowed." };
        }

        return saveFile(input, host.contents(), host.origin());
    });

    // The page subscribed to the app's events, and named the ones it handles (an older page names none).
    ipcMain.on("host:events", (event, input: unknown) => {
        if (!fromServerPage(event)) {
            return;
        }

        pageEvents = readPageEvents(input);
        pendingNewSession.pageSubscribed(view());
    });

    ipcMain.on("host:invoke", (event, id: unknown) => {
        if (fromServerPage(event) && id === "server-settings") {
            host.openSettings();
        }
    });

    // The page's Reload button (src/preload/server.ts, offerBootReload): its boot screen took too long.
    ipcMain.on("host:reload", (event) => {
        if (fromServerPage(event)) {
            host.reloadServer();
        }
    });

    ipcMain.on("host:context-menu", (event, click: unknown) => {
        if (fromServerPage(event)) {
            host.pageRightClick(click);
        }
    });

    ipcMain.on("host:badge", (event, count: unknown) => {
        const value = readBadge(count);

        if (fromServerPage(event) && value !== undefined && value !== badge) {
            setBadge(value);
        }
    });

    ipcMain.on("host:notify", (event, input: unknown) => {
        const message = readNotification(input);

        if (fromServerPage(event) && message !== undefined) {
            notify(message);
        }
    });

    ipcMain.on("host:theme", (event, input: unknown) => {
        const theme = readTheme(input);

        if (fromServerPage(event) && theme !== undefined) {
            host.themeChanged(theme);
            refreshTray();
        }
    });

    ipcMain.on("host:pinned", (event, input: unknown) => {
        if (fromServerPage(event)) {
            pins = readPinned(input);
            refreshTray();
        }
    });

    return {
        visibilityChanged: () => {
            // The settings screen shows: a New session asked for on the server no longer opens the sheet.
            pendingNewSession.screenChanged(host.showingServer());

            const now = visible();

            if (now !== lastVisible) {
                lastVisible = now;
                send({ type: "visibility", visible: now });
            }

            // The person looks at Pi Pocket: the sessions that finished are there to see. Their notification stays.
            if (looking()) {
                finishes.seen();
            }
        },
        refreshTray,
        fromServerPage,
        reset: () => {
            pins = [];

            if (badge !== 0) {
                setBadge(0);
            } else {
                refreshTray();
            }

            lastVisible = undefined;
            pageEvents = undefined;
        },
        newSession,
        setRecording: (on) => {
            if (recording !== on) {
                recording = on;
                refreshTray();
            }
        },
    };
}
