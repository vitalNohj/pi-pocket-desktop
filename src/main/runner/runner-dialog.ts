/** Native session questions stay in the main process, separate from the server's page and its sign-in. */
import { app, dialog, Notification, type BaseWindow, type MessageBoxOptions } from "electron";
import type { RunnerConfirmation } from "./runner";
import { runnerQuestion } from "./runner-question";

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
    const { title, message, detail, buttons, notification: body } = runnerQuestion(request);
    const options: MessageBoxOptions = {
        type: "warning", title, message, detail, buttons,
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
                body,
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
