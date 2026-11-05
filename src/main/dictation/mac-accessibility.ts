/**
 * macOS gives Accessibility to one build of the app. After an update, System Settings can still show Pi Pocket switched
 * on while macOS refuses the new build, and it never asks again while that old entry is in its list. Removing the
 * entry with `tccutil` (no admin rights needed) makes macOS ask the new build as it does the first time.
 */
import { execFile } from "node:child_process";

/** The app's bundle id (package.json build.appId): the entry tccutil removes. */
export const BUNDLE_ID = "io.github.vitalnohj.pipocketgui";

/** Removes Pi Pocket's Accessibility entry. Resolves false when it could not (not macOS, or tccutil failed). */
export function resetAccessibility(platform: string = process.platform, run: typeof execFile = execFile): Promise<boolean> {
    if (platform !== "darwin") {
        return Promise.resolve(false);
    }

    return new Promise((done) => {
        run("/usr/bin/tccutil", ["reset", "Accessibility", BUNDLE_ID], { timeout: 5_000 }, (error) => done(error === null));
    });
}
