// Connection loss and automatic retries.
// ——— Retrying while the server cannot be reached ———
import type { ConfigReason } from "../../shared/types";
import { retryDelayMs } from "../core/backoff";
import { didNotLoad, reconnectsByItself, returnsByItself, stoppedAnswering, whenLost } from "./server-choice";
import { serverUrl, checkAddress } from "./address";
import { stopHealth } from "./health";
import { pushConfigState, showConfig } from "../settings-screen/screen";
import { connect } from "./connect";
import { state as appState } from "../app/state";

/** The server the window uses stopped answering, did not load, or its page crashed. */
export function serverLost(reason: ConfigReason, retry: boolean): void {
    const state = appState.gui!;
    const lost = state.settings.server.mode;
    const url = state.loadedUrl ?? serverUrl();

    state.loadedUrl = undefined;
    stopHealth();

    if (lost === "remote") {
        state.remoteError =
            reason.kind === "outage"
                ? stoppedAnswering(reason.url)
                : reason.kind === "load-failed"
                  ? didNotLoad(reason.url)
                  : { kind: "dropped", url, line: "The page stopped" };
    }

    const next = whenLost({ lost, showing: state.showing, viewing: state.viewing });

    if (!next.show) {
        // The person looks at the other side: nothing jumps. The lost side shows what happened when it is opened, and
        // a remote server is checked again in the background, as after any outage.
        state.reason = reason;

        if (retry && lost === "remote") {
            scheduleRetry();
        } else {
            pushConfigState();
        }

        return;
    }

    state.viewing = next.viewing;
    showConfig(reason);

    if (retry && next.retry) {
        scheduleRetry();
    }
}

/**
 * While the config screen shows a server that does not answer, it is checked again and again, each wait longer, up
 * to the longest wait in settings. When it answers: after an outage or a failed load the app goes back to it; on the
 * first run, or when the person opened the screen themselves, it only says "Detected" and waits for them.
 */
export function scheduleRetry(): void {
    const state = appState.gui!;

    stopRetry();

    // This computer's Pi Pocket: its process says when it is up, nothing to poll.
    if (state.settings.server.mode === "local") {
        return;
    }
    state.retryAttempt += 1;

    const delay = retryDelayMs(state.retryAttempt, state.settings.connection.retryMaxSeconds);

    state.retry = {
        at: Date.now() + delay,
        timer: setTimeout(() => {
            void retry();
        }, delay),
    };
    pushConfigState();
}

export function stopRetry(): void {
    if (appState.gui?.retry !== undefined) {
        clearTimeout(appState.gui.retry.timer);
        appState.gui.retry = undefined;
        pushConfigState();
    }
}

export async function retry(): Promise<void> {
    const state = appState.gui!;

    state.retry = undefined;

    const found = await checkAddress(state.settings.server.url);

    if (state.showing !== "config" || state.retry !== undefined) {
        return;
    }

    if (found.kind === "detected") {
        if (reconnectsByItself({ reason: state.reason, viewing: state.viewing, autoConnect: state.settings.connection.autoConnect })) {
            state.retryAttempt = 0;
            connect(state.settings.server.url);
        } else if (returnsByItself(state.reason) && state.settings.connection.autoConnect) {
            // The person looks at This computer: the app does not jump. It goes back at a check after they look at
            // Another server again.
            scheduleRetry();
        } else {
            state.retryAttempt = 0;
            pushConfigState();
        }

        return;
    }

    if (state.reason.kind === "not-detected") {
        state.reason = { kind: "not-detected", probe: found };
    }

    scheduleRetry();
}
