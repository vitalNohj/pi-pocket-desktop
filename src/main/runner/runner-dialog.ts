/** Native session questions stay in the main process, separate from the server's page and its sign-in. */
import { app, dialog, Notification, type BaseWindow, type MessageBoxOptions } from "electron";
import type { RunnerConfirmation } from "./runner";

export async function askRunnerSession(
    window: BaseWindow,
    request: RunnerConfirmation,
    signal: AbortSignal,
): Promise<boolean> {
    if (signal.aborted) {
        return false;
    }

    // A hidden or minimized window must not own a sheet that the person cannot see.
    const visible = !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    const session = request.kind === "fork" ? "a copy of a session" : "a session";
    const action = request.kind === "move" ? "move a session to this folder" : `start ${session} in this folder`;
    const title = request.kind === "move" ? "Allow a session move?" : "Allow a new session?";
    const broad = request.broad !== false;
    const permission = broad
        ? "This folder holds everything in it. Allowing it permanently would allow sessions in all of it. This answer allows only this session and saves no folder."
        : "Allow also lets later sessions in this folder start without asking.";
    const options: MessageBoxOptions = {
        type: "warning",
        title,
        message: `${request.person} on ${request.server} wants to ${action}.`,
        detail: `Asked by: ${request.person}\nComputer: ${request.computer}\nFolder: ${request.folder}\n\n${permission}\n\nThe session can read and change files and run commands as you, also outside this folder.`,
        buttons: ["Deny", broad ? "Allow this session only" : "Allow"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal,
    };
    let notification: Notification | undefined;
    let bounce: number | undefined;

    try {
        if (!visible && Notification.isSupported()) {
            notification = new Notification({
                title,
                body: `${request.person} on ${request.server} wants to ${action}: ${request.folder}. Open Pi Pocket to answer.`,
                urgency: "critical",
                timeoutType: "never",
            });
            notification.on("click", () => app.focus({ steal: true }));
            notification.show();
        }

        if (process.platform === "darwin") {
            bounce = app.dock?.bounce("critical");
            app.focus({ steal: true });
        } else {
            app.focus();
        }

        const { response } = await (visible ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));

        return !signal.aborted && response === 1;
    } finally {
        notification?.close();

        if (bounce !== undefined && bounce >= 0) {
            app.dock?.cancelBounce(bounce);
        }
    }
}
