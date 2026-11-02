// The main window and application startup.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BaseWindow, globalShortcut, nativeTheme, net, session, WebContentsView } from "electron";
import { CONFIG_URL, serveAppPages } from "../settings-screen/config-protocol";
import { eventCovered, PAGE_CLICK_WAIT_MS, pageClickInfo, readPageClick } from "../window/themed-menu";
import { setUpAppearance } from "../window/appearance";
import { parseAppsUseLightTheme, setUpTitleBar, titleBarOptions } from "../window/titlebar";
import { loadTheme, sameTheme, saveTheme } from "../window/theme";
import { setUpDesktop } from "../bridge/desktop";
import { offerNewSession } from "../bridge/new-session";
import { setUpDictation } from "../dictation/dictation";
import { setUpBillionContext } from "../billion-context/billion-context";
import { setUpRunner } from "../runner/runner";
import { askRunnerSession } from "../runner/runner-dialog";
import { setUpLocalServer } from "../local-server/local-server";
import { LocalStopNotice } from "../connection/server-choice";
import { setUpUpdates } from "../updates/updates";
import { startedAtLogin, trayAvailable } from "../core/platform";
import { probe } from "../connection/probe";
import { guardContents, guardSession, type OriginPolicy } from "../core/security";
import { loadSettings, saveSettings } from "../core/settings";
import { loadWindowState, saveWindowState } from "../window/window-state";
import { HangWatch, PageRecovery } from "../connection/page-recovery";
import { diagnose, stopDiagnostics } from "../diagnostics/stall-watchdog";
import { ASSETS, RENDERER, preloadPath } from "../core/paths";
import { SERVER_PARTITION, state as appState } from "./state";
import { pageHangChanged, startHealth, reloadServer, reloadShowing } from "../connection/health";
import { originOf, currentOrigin, checkAddress } from "../connection/address";
import { pushConfigState, lockConfigView, showConfig } from "../settings-screen/screen";
import { openSettings, openSettingsOn, quit, buildMenu, newSession } from "./menu";
import { localReady, localDown } from "../local-server/use";
import { show, showWindow, toggleWindow, layout } from "../window/views";
import { setUpNavigation } from "../window/navigation";
import { contextMenuEventAt, clipboardHasContent, openContextMenu } from "../window/page-menu";
import { openServerWindow, watchServerView, connect } from "../connection/connect";
import { registerIpc } from "../settings-screen/ipc";
import { applyDesktopSettings } from "../settings-screen/apply";
import { scheduleRetry } from "../connection/retry";

const CONFIG_PARTITION = "gui-config";

export async function start(): Promise<void> {
    await app.whenReady();

    const configPath = join(app.getPath("userData"), "config.json");
    const firstRun = !existsSync(configPath);
    const loaded = loadSettings(configPath);
    const statePath = join(app.getPath("userData"), "window-state.json");
    const placed = loadWindowState(statePath);
    // Linux makes a window see-through only when it is made; macOS and Windows change it at any time.
    const translucentAtStart = process.platform === "linux" && loaded.settings.appearance.translucent;
    const themePath = join(app.getPath("userData"), "theme.json");
    const theme = loadTheme(themePath);
    const solid = theme.colors.bg;
    const titleBarAtStart = loaded.settings.window.titleBar;

    const window = new BaseWindow({
        title: "Pi Pocket",
        width: placed.bounds.width,
        height: placed.bounds.height,
        ...(placed.placed ? { x: placed.bounds.x, y: placed.bounds.y } : {}),
        minWidth: 360,
        minHeight: 480,
        show: false,
        backgroundColor: solid,
        ...(translucentAtStart ? { transparent: true } : {}),
        icon: join(ASSETS, "icon-512.png"),
        autoHideMenuBar: !loaded.settings.window.showMenuBar,
        ...titleBarOptions(process.platform, titleBarAtStart, theme),
    });

    const serverSession = session.fromPartition(SERVER_PARTITION);
    const configSession = session.fromPartition(CONFIG_PARTITION);

    for (const viewSession of [serverSession, configSession]) {
        viewSession.registerPreloadScript({ type: "frame", filePath: preloadPath("navigation") });
    }

    serverSession.setUserAgent(`${serverSession.getUserAgent()} PiPocketGUI/${app.getVersion()}`);
    serveAppPages(configSession, RENDERER);
    configSession.setPermissionRequestHandler((_contents, permission, callback) => {
        callback(permission === "clipboard-sanitized-write");
    });

    const server = new WebContentsView({
        webPreferences: {
            session: serverSession,
            // window.pocketHost, the host bridge; the main process decides at its start whether the page gets it.
            preload: preloadPath("server"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
            spellcheck: true,
            // Notifications and the live connection keep working while the window is hidden in the tray.
            backgroundThrottling: false,
        },
    });
    const config = new WebContentsView({
        webPreferences: {
            session: configSession,
            preload: preloadPath("config"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
        },
    });

    server.setBackgroundColor(solid);
    config.setBackgroundColor(solid);
    window.contentView.addChildView(server);
    window.contentView.addChildView(config);

    const tray = await trayAvailable();

    appState.gui = {
        window,
        server,
        config,
        tray: undefined,
        trayAvailable: tray,
        settings: loaded.settings,
        problems: loaded.problems,
        configPath,
        showing: "config",
        reason: { kind: "first-run" },
        navigation: {},
        viewing: loaded.settings.server.mode,
        remoteError: undefined,
        localAsked: false,
        localLogin: undefined,
        localStopNotice: new LocalStopNotice(),
        probe: undefined,
        loadedUrl: undefined,
        unverified: false,
        connectionAttempt: 0,
        retry: undefined,
        retryAttempt: 0,
        health: undefined,
        quitting: false,
        desktop: undefined,
        updates: undefined,
        appearance: undefined,
        translucentAtStart,
        titleBar: undefined,
        titleBarAtStart,
        theme,
        themePath,
        toldNoBridge: false,
        local: undefined,
        dictation: undefined,
        billionContext: undefined,
        runner: undefined,
        signingIn: false,
        pageHang: new HangWatch((hung) => pageHangChanged(hung)),
        recovery: new PageRecovery(),
        replacing: undefined,
        reloadCheck: undefined,
        askingHang: false,
        loadFailed: false,
    };

    appState.gui.titleBar = setUpTitleBar({
        platform: process.platform,
        style: titleBarAtStart,
        window,
        server: server.webContents,
        theme,
        nativeTheme,
        systemScheme: () =>
            new Promise((resolve) => {
                execFile(
                    "reg",
                    ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", "/v", "AppsUseLightTheme"],
                    { windowsHide: true, timeout: 3000 },
                    (_error, stdout) => resolve(parseAppsUseLightTheme(String(stdout))),
                );
            }),
    });

    appState.gui.appearance = setUpAppearance({
        platform: process.platform,
        systemVersion: process.getSystemVersion(),
        window,
        views: [server, config],
        server: server.webContents,
        onServerOrigin: () => originOf(server.webContents.getURL()) === currentOrigin(),
        translucentAtStart,
        solid: () => appState.gui!.theme.colors.bg,
    });

    appState.gui.updates = setUpUpdates({
        assets: ASSETS,
        window: () => window,
        settings: () => appState.gui!.settings,
        changed: () => {
            pushConfigState();
            appState.gui?.desktop?.refreshTray();
        },
        quitting: () => {
            if (appState.gui !== undefined) {
                appState.gui.quitting = true;
            }
        },
    });

    appState.gui.dictation = setUpDictation({
        home: app.getPath("userData"),
        platform: process.platform,
        arch: process.arch,
        settings: () => appState.gui!.settings,
        choose: (model) => {
            const state = appState.gui!;

            state.settings = { ...state.settings, dictation: { ...state.settings.dictation, model } };
            saveSettings(state.configPath, state.settings);
        },
        fetch: (url) => net.fetch(url, { headers: { "user-agent": `pi-pocket-gui/${app.getVersion()}` } }),
        fromServerPage: (event) => appState.gui?.desktop?.fromServerPage(event) === true,
        toPage: (message) => {
            if (!server.webContents.isDestroyed()) {
                server.webContents.send("host:dictation", message);
            }
        },
        changed: () => {
            pushConfigState();
        },
        needModel: () => {
            openSettingsOn(undefined, "dictation");
        },
    });

    appState.gui.local = setUpLocalServer({
        home: join(app.getPath("userData"), "server"),
        platform: process.platform,
        arch: process.arch,
        settings: () => appState.gui!.settings,
        fetch: (url) => net.fetch(url, { headers: { "user-agent": `pi-pocket-gui/${app.getVersion()}` } }),
        probe: (url) =>
            probe(url, (target, init) => serverSession.fetch(target, init), appState.gui!.settings.connection.probeTimeoutMs),
        changed: () => {
            pushConfigState();
            appState.gui?.desktop?.refreshTray();
            appState.gui?.runner?.runtimeChanged();
        },
        ready: (url, loginPath) => {
            appState.gui?.billionContext?.serverReady();
            localReady(url, loginPath);
        },
        down: (why) => {
            appState.gui?.billionContext?.serverDown();
            localDown(why);
        },
        restarted: () => {
            // Its launcher restarted the server (an update, a crash): the page reconnects by itself, and the health
            // check reloads it if it stays on the boot screen.
            appState.gui?.recovery.serverRestarted(Date.now());

            if (appState.gui !== undefined && appState.gui.settings.server.mode === "local" && appState.gui.loadedUrl !== undefined && appState.gui.health === undefined) {
                startHealth();
            }
        },
    });

    appState.gui.billionContext = setUpBillionContext({
        home: join(app.getPath("userData"), "billion-context"),
        platform: process.platform,
        settings: () => appState.gui!.settings,
        dataFolder: () => appState.gui!.local!.dataFolder(),
        local: () => {
            const local = appState.gui!.local!;

            return { installed: local.installed(), url: local.state().status === "running" ? local.url() : undefined };
        },
        fetch: (url, headers = {}) => net.fetch(url, { headers: { "user-agent": `pi-pocket-gui/${app.getVersion()}`, ...headers } }),
        request: (url, init) => net.fetch(url, init),
        changed: () => {
            pushConfigState();
        },
    });

    appState.gui.runner = setUpRunner({
        home: join(app.getPath("userData"), "runner"),
        platform: process.platform,
        enabled: () => appState.gui!.settings.runner.enabled,
        confirmSessions: () => appState.gui!.settings.runner.confirmSessions,
        allowHttp: () => appState.gui!.settings.runner.allowHttp,
        ask: (request, signal) => askRunnerSession(window, request, signal),
        setEnabled: async (enabled) => {
            const state = appState.gui!;

            if (state.settings.runner.enabled !== enabled) {
                state.settings = { ...state.settings, runner: { ...state.settings.runner, enabled } };
                saveSettings(state.configPath, state.settings);
            }
        },
        runtime: () => appState.gui!.local!.runnerRuntime(),
        // No Pi Pocket here yet: install it (it starts only in "This computer" mode). One without the runner: update it.
        prepare: async () => {
            const local = appState.gui!.local!;

            if (!local.installed()) {
                await local.install();
            } else {
                await local.checkUpdates();
            }
        },
        environment: () => appState.gui!.local!.environment(),
        changed: () => {
            pushConfigState();
        },
    });

    appState.gui.desktop = setUpDesktop({
        assets: ASSETS,
        window: () => window,
        contents: () => server.webContents,
        origin: () => currentOrigin(),
        settings: () => appState.gui!.settings,
        showingServer: () => appState.gui?.showing === "server",
        showServer: () => {
            if (appState.gui === undefined || appState.gui.loadedUrl === undefined) {
                return false;
            }

            if (appState.gui.showing !== "server") {
                appState.gui.reason = { kind: "user" };
                appState.gui.viewing = appState.gui.settings.server.mode;
                show("server");
            }

            return true;
        },
        serverLoaded: () => appState.gui?.loadedUrl !== undefined,
        tray: () => appState.gui?.tray,
        showWindow,
        toggleWindow,
        openSettings,
        reloadServer: () => reloadServer(),
        reloadItem: () =>
            appState.gui === undefined || appState.gui.window.isDestroyed()
                ? undefined
                : { label: appState.gui.pageHang.hung ? "Reload (page not responding)" : "Reload", click: reloadShowing },
        quit,
        updateItem: () => appState.gui?.updates?.trayItem() ?? appState.gui?.local?.trayItem(),
        theme: () => appState.gui!.theme,
        dictation: () => appState.gui?.dictation?.state().supported === true,
        themeChanged: (next) => {
            const state = appState.gui!;

            if (sameTheme(state.theme, next)) {
                return;
            }

            state.theme = next;
            saveTheme(state.themePath, next);
            state.appearance?.themeChanged();
            state.titleBar?.themeChanged(next);
            pushConfigState();
        },
        pageRightClick: (input) => {
            const click = readPageClick(input);
            const at = Date.now();

            if (click === undefined) {
                return;
            }

            // Electron's event, where it fires, comes with the spelling: wait a moment for it, and open from the
            // page's report only when it did not come (macOS).
            setTimeout(() => {
                const contents = appState.gui?.server.webContents;

                if (contents === undefined || contents.isDestroyed() || eventCovered(contextMenuEventAt.get(contents.id), at)) {
                    return;
                }

                void clipboardHasContent().then((pasteable) => {
                    if (appState.gui !== undefined && !contents.isDestroyed()) {
                        openContextMenu(appState.gui.window, contents, pageClickInfo(click, pasteable), click, { openSettings });
                    }
                });
            }, PAGE_CLICK_WAIT_MS);
        },
    });

    for (const change of ["show", "hide", "minimize", "restore", "focus"] as const) {
        window.on(change as "show", () => appState.gui?.desktop?.visibilityChanged());
    }

    const policy: OriginPolicy = {
        server: () => currentOrigin(),
        allowed: () => new Set([currentOrigin(), ...(appState.gui?.settings.server.extraOrigins ?? [])]),
    };

    guardSession(serverSession, policy);
    guardContents(server.webContents, policy, openServerWindow);
    lockConfigView();
    watchServerView();
    setUpNavigation();
    layout();
    window.on("resize", layout);
    window.on("maximize", layout);
    window.on("unmaximize", layout);
    window.on("enter-full-screen", layout);
    window.on("leave-full-screen", layout);

    const remember = () => {
        if (!window.isMinimized() && !window.isMaximized()) {
            saveWindowState(statePath, { bounds: window.getBounds(), maximized: false });
        } else {
            saveWindowState(statePath, { bounds: window.getNormalBounds(), maximized: window.isMaximized() });
        }
    };

    window.on("close", (event) => {
        remember();

        if (appState.gui === undefined || appState.gui.quitting) {
            return;
        }

        if (appState.gui.settings.window.closeToTray) {
            event.preventDefault();

            if (appState.gui.tray !== undefined) {
                window.hide();
            } else {
                window.minimize();
            }
        }
    });
    window.on("closed", () => {
        app.quit();
    });

    app.on("second-instance", () => {
        showWindow();
    });
    let stopped = false;

    app.on("before-quit", (event) => {
        if (appState.gui !== undefined) {
            appState.gui.quitting = true;
        }

        // This computer's Pi Pocket stops with the app: its sessions resume at the next start.
        if (!stopped && appState.gui?.local !== undefined) {
            event.preventDefault();
            stopped = true;
            void Promise.allSettled([appState.gui.local.quit(), appState.gui.runner?.quit()]).finally(() => app.quit());
        }
    });
    app.on("activate", () => {
        showWindow();
    });

    // Every page and helper process that goes away, for the diagnostics log (README, Diagnostics).
    app.on("render-process-gone", (_event, contents, details) => {
        const which = contents === appState.gui?.server.webContents ? "server page" : contents === appState.gui?.config.webContents ? "settings page" : "a page";

        diagnose(`render-process-gone: ${which}, ${details.reason} (exit code ${String(details.exitCode)})`);
    });
    app.on("child-process-gone", (_event, details) => {
        diagnose(`child-process-gone: ${details.type}${details.name === undefined ? "" : ` (${details.name})`}, ${details.reason} (exit code ${String(details.exitCode)})`);
    });

    // A system shutdown or `kill`: quit the usual way, so this computer's Pi Pocket stops with the app.
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
        process.on(signal, quit);
    }
    app.on("will-quit", () => {
        diagnose("app quits");
        stopDiagnostics();
        globalShortcut.unregisterAll();
        appState.gui?.dictation?.quit();
        appState.gui?.billionContext?.quit();
    });

    registerIpc();
    applyDesktopSettings(undefined);
    buildMenu();
    offerNewSession(newSession);
    await config.webContents.loadURL(CONFIG_URL);

    if (placed.maximized) {
        window.maximize();
    }

    const hidden = appState.gui.settings.window.startHidden && startedAtLogin() && appState.gui.tray !== undefined;

    if (!hidden) {
        window.show();
    }

    // This computer as a runner, for whichever server it is linked to.
    appState.gui.runner!.boot();

    // Its runner comes from Pi Pocket on this computer: keep that current also while another server is in use.
    if (appState.gui.settings.server.mode !== "local" && appState.gui.runner!.linked()) {
        appState.gui.local!.keepCurrent();
    }

    // This computer's Pi Pocket: the window opens it once it is ready, and shows its state until then.
    if (appState.gui.settings.server.mode === "local") {
        appState.gui.viewing = "local";
        showConfig({ kind: "local" });
        void appState.gui.local!.boot();

        return;
    }

    // First run: always show the config screen, with what the check found, so the person confirms the address.
    if (firstRun) {
        showConfig({ kind: "first-run" });

        if ((await checkAddress(appState.gui.settings.server.url)).kind !== "detected") {
            scheduleRetry();
        }

        return;
    }

    const found = await checkAddress(appState.gui.settings.server.url);

    if (found.kind === "detected" && appState.gui.settings.connection.autoConnect) {
        connect(appState.gui.settings.server.url);
    } else if (found.kind === "detected") {
        showConfig({ kind: "user" });
    } else {
        showConfig({ kind: "not-detected", probe: found });
        scheduleRetry();
    }
}
