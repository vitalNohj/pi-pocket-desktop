// Server addresses and address checks.
import { session } from "electron";
import type { ProbeResult } from "../../shared/types";
import { probe } from "./probe";
import { normalizeServerUrl } from "../core/url";
import { SERVER_PARTITION, state as appState } from "../app/state";
import { layout } from "../window/views";
import { pushConfigState } from "../settings-screen/screen";

/** The address the window opens: this computer's Pi Pocket, or the server set in settings. */
export function serverUrl(): string {
    const settings = appState.gui?.settings;

    if (settings?.server.mode === "local") {
        return appState.gui?.local?.url() ?? `http://127.0.0.1:${String(settings.local.port)}`;
    }

    return settings?.server.url ?? "";
}

export function currentOrigin(): string {
    const normalized = normalizeServerUrl(serverUrl());

    return normalized.ok ? normalized.origin : "null";
}

export async function checkAddress(url: string): Promise<ProbeResult> {
    const state = appState.gui!;
    const serverSession = session.fromPartition(SERVER_PARTITION);
    const result = await probe(
        url,
        (target, init) => serverSession.fetch(target, init),
        state.settings.connection.probeTimeoutMs,
    );

    if (sameAddress(url, serverUrl())) {
        state.probe = result;

        if (result.kind === "detected" && state.unverified) {
            state.unverified = false;
            layout();
            state.config.setVisible(state.showing === "config");
        }

        pushConfigState();
    }

    return result;
}

export function sameAddress(a: string, b: string): boolean {
    const left = normalizeServerUrl(a);
    const right = normalizeServerUrl(b);

    return left.ok && right.ok && left.url === right.url;
}

export function originOf(url: string): string | undefined {
    try {
        return new URL(url).origin;
    } catch {
        return undefined;
    }
}
