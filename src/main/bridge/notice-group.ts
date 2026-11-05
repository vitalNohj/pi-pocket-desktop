/**
 * "Pi finished" notifications as one. The server sends one for each session that finishes (tag `done-<id>`), and on
 * macOS each was a banner of its own, shown one after another. Here they gather in one notification that lists the
 * sessions not yet seen, latest first. While the person is away (the computer sleeps, its screen is locked, or nobody
 * has touched it for a while, as when the display is off), they wait without a banner, and one notification shows when
 * the person is back. Approvals and the other notifications never come here: they show at once, as before.
 */
import type { HostNotification } from "../../shared/types";

/** Nobody touched the computer for this long: the person is away (the display is off, or they left it). */
export const IDLE_SECONDS = 120;
/** How often to look whether the person is back, only while finishes wait for them. */
export const CHECK_MS = 5000;
/** The most session names one notification lists; the rest are counted. */
export const LISTED = 6;
/** The server's title for a session that finished (Pi Pocket's src/server/alerts.ts); a list shows the name only. */
const FINISHED = "Pi finished · ";

/** A notification of the server's that says a session or PiP finished, or stopped with an error. */
export function isFinish(message: HostNotification): boolean {
    return message.approval === undefined && message.tag.startsWith("done-");
}

/** What one notification says, and the path a click opens. */
export interface Notice {
    title: string;
    body: string;
    url: string;
}

/** What the computer says of the person, as Electron's powerMonitor.getSystemIdleState answers. */
export type IdleState = "active" | "idle" | "locked" | "unknown";

/**
 * The one notification for these finishes, oldest first: a single one as the server wrote it; more as a count, their
 * names latest first, and a click that opens the latest.
 */
export function groupNotice(finishes: readonly HostNotification[]): Notice | undefined {
    const latest = finishes.at(-1);

    if (latest === undefined) {
        return undefined;
    }

    if (finishes.length === 1) {
        return { title: latest.title, body: latest.body, url: latest.url };
    }

    const names = finishes
        .map((finish) => (finish.title.startsWith(FINISHED) ? finish.title.slice(FINISHED.length) : finish.title))
        .reverse();
    const more = names.length - LISTED;

    return {
        title: `${finishes.length} sessions finished`,
        body: [...names.slice(0, LISTED), ...(more > 0 ? [`and ${more} more`] : [])].join("\n"),
        url: latest.url,
    };
}

/** What FinishNotices needs: the computer's idle state, a way to show, and a timer. */
export interface FinishHost {
    /** powerMonitor.getSystemIdleState(IDLE_SECONDS). */
    idle: () => IdleState;
    /** Show this notification, in place of the one shown before. */
    show: (notice: Notice) => void;
    setTimer: (run: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
}

export class FinishNotices {
    /** The finishes not yet seen, oldest first, one per session. */
    #finishes: HostNotification[] = [];
    /** The computer sleeps, its screen is locked, or another person's login is active: the system said so. */
    #asleep = false;
    /** Finishes came while the person was away: they show when the person is back. */
    #held = false;
    #timer: unknown;

    constructor(private readonly host: FinishHost) {}

    /** The person is away: the system said so, or nobody has touched the computer for IDLE_SECONDS. */
    away(): boolean {
        if (this.#asleep) {
            return true;
        }

        const state = this.host.idle();

        return state === "idle" || state === "locked";
    }

    /** A session finished: show it with the others not yet seen, or keep it for when the person is back. */
    add(message: HostNotification): void {
        this.#finishes = [...this.#finishes.filter((finish) => finish.tag !== message.tag), message];

        if (this.away()) {
            this.#held = true;
            this.#watch();
        } else {
            this.#show();
        }
    }

    /** The computer went to sleep or locked (true), or woke or unlocked (false). */
    asleep(on: boolean): void {
        this.#asleep = on;

        if (!on) {
            this.#check();
        }
    }

    /** The person saw them: they clicked or closed the notification, or the window shows Pi Pocket. */
    seen(): void {
        this.#finishes = [];
        this.#held = false;
        this.#unwatch();
    }

    /** How many finishes are not yet seen. */
    get size(): number {
        return this.#finishes.length;
    }

    #show(): void {
        this.#held = false;
        this.#unwatch();

        const notice = groupNotice(this.#finishes);

        if (notice !== undefined) {
            this.host.show(notice);
        }
    }

    /** Finishes wait: show them once the person is back, else look again soon. */
    #check(): void {
        if (!this.#held) {
            return;
        }

        if (this.away()) {
            this.#watch();
        } else {
            this.#show();
        }
    }

    #watch(): void {
        if (this.#timer === undefined) {
            this.#timer = this.host.setTimer(() => {
                this.#timer = undefined;
                this.#check();
            }, CHECK_MS);
        }
    }

    #unwatch(): void {
        if (this.#timer !== undefined) {
            this.host.clearTimer(this.#timer);
            this.#timer = undefined;
        }
    }
}
