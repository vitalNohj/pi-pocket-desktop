// Shared application state and constants.
import type { BaseWindow, Tray, WebContentsView } from "electron";
import type { ConfigReason, ProbeResult, Settings, SettingsProblem, Side, ThemeColors, TitleBarStyle } from "../../shared/types";
import type { setUpAppearance } from "../window/appearance";
import type { setUpTitleBar } from "../window/titlebar";
import type { setUpDesktop } from "../bridge/desktop";
import type { setUpDictation } from "../dictation/dictation";
import type { setUpAnywhere } from "../dictation/anywhere";
import type { setUpBillionContext } from "../billion-context/billion-context";
import type { setUpRunner } from "../runner/runner";
import type { setUpLocalServer } from "../local-server/local-server";
import type { LocalStopNotice, RemoteError } from "../connection/server-choice";
import type { setUpUpdates } from "../updates/updates";
import type { HangWatch, PageRecovery } from "../connection/page-recovery";
import type { NavigationState } from "../window/navigation-state";

export const SERVER_PARTITION = "persist:server";

/** Everything the app holds while it runs. */
export interface Gui {
    window: BaseWindow;
    server: WebContentsView;
    config: WebContentsView;
    tray: Tray | undefined;
    trayAvailable: boolean;
    settings: Settings;
    problems: SettingsProblem[];
    configPath: string;
    showing: "server" | "config";
    reason: ConfigReason;
    navigation: NavigationState;
    /**
     * The side of Connection the config screen shows. Choosing one only shows it; the server the window uses is
     * `settings.server.mode` (src/main/connection/server-choice.ts).
     */
    viewing: Side;
    /** Why the window has no other server: its connection dropped, or the last Connect failed. */
    remoteError: RemoteError | undefined;
    /** The person asked for this computer's Pi Pocket (Start, Install): once it is ready, the window uses it. */
    localAsked: boolean;
    /** This computer's Pi Pocket, while it runs: its address and login link, for Open. */
    localLogin: { url: string; loginPath: string } | undefined;
    /** When this computer's Pi Pocket stopped on its own and the person was told. */
    localStopNotice: LocalStopNotice;
    probe: ProbeResult | undefined;
    /** The address the server view has loaded, once it did: of the server the window uses. */
    loadedUrl: string | undefined;
    /** An explicitly opened, unverified HTML page keeps an app-owned way back visible. */
    unverified: boolean;
    connectionAttempt: number;
    /** The next automatic check while the config screen shows a server that does not answer. */
    retry: { timer: NodeJS.Timeout; at: number } | undefined;
    /** Checks that failed in a row: the wait grows with each. */
    retryAttempt: number;
    health: { timer: NodeJS.Timeout; failures: number } | undefined;
    quitting: boolean;
    /** The app bridge's main-process side (src/main/bridge/desktop.ts). */
    desktop: ReturnType<typeof setUpDesktop> | undefined;
    /** The app's own updates (src/main/updates/updates.ts). */
    updates: ReturnType<typeof setUpUpdates> | undefined;
    /** The see-through window (src/main/window/appearance.ts). */
    appearance: ReturnType<typeof setUpAppearance> | undefined;
    /** Linux: the window was made see-through at start; turning that on needs a new window. */
    translucentAtStart: boolean;
    /** The title bar (src/main/window/titlebar.ts), as the window was made: a change takes a restart. */
    titleBar: ReturnType<typeof setUpTitleBar> | undefined;
    titleBarAtStart: TitleBarStyle;
    /** Pi Pocket's colors, the last its page showed (src/main/window/theme.ts), and where they are kept. */
    theme: ThemeColors;
    themePath: string;
    /** The notice about a server without the bridge was shown in this run. */
    toldNoBridge: boolean;
    /** Pi Pocket on this computer (src/main/local-server/local-server.ts). */
    local: ReturnType<typeof setUpLocalServer> | undefined;
    /** Offline dictation (src/main/dictation/dictation.ts). */
    dictation: ReturnType<typeof setUpDictation> | undefined;
    /** Dictate anywhere (src/main/dictation/anywhere.ts). */
    anywhere: ReturnType<typeof setUpAnywhere> | undefined;
    /** billion-context-pi-pocket in this computer's Pi Pocket (src/main/billion-context/billion-context.ts). */
    billionContext: ReturnType<typeof setUpBillionContext> | undefined;
    /** This computer as a runner for a server (src/main/runner/runner.ts). */
    runner: ReturnType<typeof setUpRunner> | undefined;
    /** The login link was opened: the next page drops it from the view's history. */
    signingIn: boolean;
    /** Whether the server's page answers (Electron's unresponsive, and the health check's look at the page). */
    pageHang: HangWatch;
    /** When to reload a page that stays stuck while its server answers (src/main/connection/page-recovery.ts). */
    recovery: PageRecovery;
    /**
     * The page's renderer is being replaced on purpose (reloadServer): its render-process-gone is not a crash, and the
     * load waits for it (a load started before the old renderer is gone fails). The timer loads anyway.
     */
    replacing: NodeJS.Timeout | undefined;
    /** A reload that waits to see whether it helped; if the page still does not answer, its renderer is replaced. */
    reloadCheck: NodeJS.Timeout | undefined;
    /** The "page not responding" question shows. */
    askingHang: boolean;
    /**
     * A load of this computer's Pi Pocket failed while its process runs (it was restarting): the health check loads
     * the page again once the server answers. Its process, not a failed load, says when it is down.
     */
    loadFailed: boolean;
}

export const state: { gui: Gui | undefined } = { gui: undefined };
