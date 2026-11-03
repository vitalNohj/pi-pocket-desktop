/**
 * When this computer's Pi Pocket looks for updates: at the app's start in "This computer" mode, for a linked runner, or
 * when the person installs or starts Pi Pocket from "Another server"; and then each time the person opens Settings. No
 * timer: an app that stays open for days checks when Settings opens. Pure of Electron, for tests.
 */
export class UpdateSchedule {
    private active = false;

    constructor(
        /** The check; it does nothing when the settings turn automatic updates off (`keepUpdated`). */
        private readonly check: () => Promise<void>,
    ) {}

    /** Check now, and again each time Settings opens. */
    now(): void {
        this.active = true;
        void this.check();
    }

    /** The person installed or started Pi Pocket, or linked a runner: check now, unless it is kept current already. */
    ensure(): void {
        if (!this.active) {
            this.now();
        }
    }

    /** The person opened Settings: check again, when it is kept current. */
    settingsOpened(): void {
        if (this.active) {
            void this.check();
        }
    }

    /** Uninstall, or the app's quit: no more checks until the next `now` or `ensure`. */
    stop(): void {
        this.active = false;
    }
}
