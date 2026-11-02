// When to reload the server's page by itself, and when to call it hung.
//
// The page shows Pi Pocket's boot screen until the server answers. A healthy page leaves it by itself (its script asks
// again every 3 s), but a renderer that stalled while the server restarted can stay on it for good. The health check
// of the main process looks at both the server and the page: when the server answers and the page still shows the
// boot screen (or does not answer at all) for STUCK_MS, the page is reloaded once; if that does not help, its renderer
// is replaced (forcefullyCrashRenderer, then a load). Then nothing more until the page is fine again or the server
// goes away and comes back: no reload loops.
//
// Kept free of Electron so it can be tested.

/** How long the page may stay stuck while the server answers before a reload. */
export const STUCK_MS = 15_000;
/** How long the page may stay unresponsive before the app offers a reload. */
export const HANG_MS = 10_000;

/**
 * What a look at the page found: "ready" (the app runs, or a page that is not Pi Pocket's), "boot" (the full-screen
 * boot screen), "silent" (the page did not answer the look in time), or "empty" (nothing loaded at all).
 */
export type PageLook = "ready" | "boot" | "silent" | "empty";

export type RecoveryStep = "none" | "reload" | "force-reload";

export class PageRecovery {
    /** When the page was first seen stuck in this episode, or undefined while it is fine. */
    private stuckSince: number | undefined;
    /** When the server last came up (from down, or at the start). A stuck page counts from this, not before. */
    private upSince: number | undefined;
    /** What this episode already did. */
    private done: "none" | "reload" | "force-reload" = "none";
    /** When the last step was taken: the next one waits STUCK_MS after it. */
    private stepAt = 0;

    constructor(private readonly stuckMs = STUCK_MS) {}

    /** One look: the server's state and the page's. Returns what to do now. */
    check(now: number, serverUp: boolean, look: PageLook): RecoveryStep {
        if (!serverUp) {
            // A page waiting for a server that is down is right to wait. Start over when the server comes back.
            this.upSince = undefined;
            this.reset();

            return "none";
        }

        this.upSince ??= now;

        if (look === "ready") {
            this.reset();

            return "none";
        }

        this.stuckSince ??= now;

        const since = Math.max(this.stuckSince, this.upSince, this.stepAt);

        if (now - since < this.stuckMs) {
            return "none";
        }

        if (this.done === "none") {
            this.done = "reload";
            this.stepAt = now;

            return "reload";
        }

        if (this.done === "reload") {
            this.done = "force-reload";
            this.stepAt = now;

            return "force-reload";
        }

        return "none";
    }

    /**
     * The server came back (its launcher restarted it, which a health check may not see go down): a page that stays
     * stuck from now on counts from now.
     */
    serverRestarted(now: number): void {
        this.upSince = now;
        this.reset();
    }

    /** Forget the episode (the page is fine, or someone reloaded it by hand). */
    reset(): void {
        this.stuckSince = undefined;
        this.done = "none";
        this.stepAt = 0;
    }
}

/** Timers, so HangWatch can be tested with fake ones. */
export interface HangTimers {
    set(run: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

/**
 * Tracks whether the page is hung: Electron's `unresponsive` (or the health check's own look, when the page does not
 * answer it), held for HANG_MS. `changed` is called when the hung state flips.
 */
export class HangWatch {
    private timer: unknown;
    private hungNow = false;

    constructor(
        private readonly changed: (hung: boolean) => void,
        private readonly timers: HangTimers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as NodeJS.Timeout) },
        private readonly hangMs = HANG_MS,
    ) {}

    get hung(): boolean {
        return this.hungNow;
    }

    /** The page stopped answering. Repeated calls do not restart the wait. */
    unresponsive(): void {
        if (this.hungNow || this.timer !== undefined) {
            return;
        }

        this.timer = this.timers.set(() => {
            this.timer = undefined;
            this.hungNow = true;
            this.changed(true);
        }, this.hangMs);
    }

    /** The page answers again (or was replaced). */
    responsive(): void {
        if (this.timer !== undefined) {
            this.timers.clear(this.timer);
            this.timer = undefined;
        }

        if (this.hungNow) {
            this.hungNow = false;
            this.changed(false);
        }
    }
}

/**
 * The script the health check runs in the page: "boot" while the full-screen boot screen is there (the same test as
 * the preload's showsFullScreenBoot), else "ready".
 */
export const LOOK_SCRIPT = `(() => {
    for (const boot of document.querySelectorAll('[data-part="boot"]')) {
        if (!boot.classList.contains("inline")) return "boot";
    }
    return "ready";
})()`;

/** Runs a look with a time limit: a page that does not answer in time is "silent". */
export async function lookWithin(run: () => Promise<unknown>, ms: number): Promise<PageLook> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<PageLook>((resolve) => {
        timer = setTimeout(() => resolve("silent"), ms);
    });

    try {
        return await Promise.race([
            run().then(
                (answer): PageLook => (answer === "boot" ? "boot" : "ready"),
                // An error is an answer: the page runs (it may be navigating). Only no answer at all is silent.
                (): PageLook => "ready",
            ),
            late,
        ]);
    } finally {
        clearTimeout(timer);
    }
}
