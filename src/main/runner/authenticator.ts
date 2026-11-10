/** The runner's JSON-only authenticator interface. Never send its stdout or secrets to a log. */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AuthenticatorResult, AuthenticatorSetup, RunnerState } from "../../shared/types";

export const AUTHENTICATOR_UNAVAILABLE = "Update Pi Pocket to set up an authenticator here";
const CANCELLED = "Cancelled. No authenticator was saved.";
const ENDED = "Authenticator setup ended. Cancel and start setup again.";
const TIMEOUT_MS = 3 * 60 * 1000;
const STOP_MS = 5000;
const OUTPUT_LIMIT = 32768;
type SpawnSetup = () => Promise<ChildProcessWithoutNullStreams>;

function object(text: string): Record<string, unknown> {
    let value: unknown;

    try {
        value = JSON.parse(text);
    } catch {
        // JSON.parse's own error can include part of a secret line.
        throw new Error("The runner returned invalid authenticator JSON.");
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("The runner returned invalid authenticator JSON.");
    }

    return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(value).every((key) => allowed.includes(key));
}

function failure(value: Record<string, unknown>): value is { ok: false; error: string } {
    return value.ok === false && typeof value.error === "string" && value.error.trim() !== "" && keys(value, ["ok", "error"]);
}

export function parseAuthenticatorStatus(text: string): Exclude<RunnerState["authenticator"], { unavailable: string } | undefined> {
    const value = object(text);

    if (failure(value)) {
        throw new Error(value.error);
    }

    if (typeof value.totp !== "boolean" || typeof value.locked !== "boolean"
        || !keys(value, ["totp", "locked", "lockedUntil"])
        || (value.lockedUntil !== undefined && (!Number.isSafeInteger(value.lockedUntil) || (value.lockedUntil as number) < 0))) {
        throw new Error("The runner returned an invalid authenticator status.");
    }

    return { set: value.totp, locked: value.locked, ...(value.lockedUntil === undefined ? {} : { lockedUntil: value.lockedUntil as number }) };
}

export function parseAuthenticatorSetup(text: string): Pick<AuthenticatorSetup, "secret" | "link"> {
    const value = object(text);

    if (failure(value)) {
        throw new Error(value.error);
    }

    if (!keys(value, ["secret", "link"]) || typeof value.secret !== "string" || value.secret !== value.secret.trim() || !/^[A-Z2-7]{16,128}$/.test(value.secret) || typeof value.link !== "string") {
        throw new Error("The runner returned an invalid authenticator key.");
    }

    try {
        const url = new URL(value.link);

        if (url.protocol !== "otpauth:" || url.hostname !== "totp" || url.searchParams.getAll("secret").length !== 1 || url.searchParams.get("secret") !== value.secret) {
            throw new Error();
        }
    } catch {
        throw new Error("The runner returned an invalid authenticator link.");
    }

    return { secret: value.secret, link: value.link };
}

export function parseAuthenticatorResult(text: string, set: boolean): AuthenticatorResult {
    const value = object(text);

    if (failure(value)) {
        return { ok: false, error: value.error };
    }

    if (value.ok !== true || value.totp !== set || !keys(value, ["ok", "totp"])) {
        throw new Error("The runner returned an invalid authenticator result.");
    }

    return { ok: true };
}

export function authenticatorCode(code: unknown): code is string {
    return typeof code === "string" && code.length === 6 && /^\d{6}$/.test(code);
}

/** One non-interactive JSON command. stderr is deliberately not mixed into its result or logged. */
export async function authenticatorCommand(spawnCommand: SpawnSetup): Promise<string> {
    const proc = await spawnCommand();

    return new Promise((resolve, reject) => {
        let stdout = "";
        let problem: Error | undefined;
        const timer = setTimeout(() => {
            problem = new Error("The runner's authenticator command timed out.");
            proc.kill("SIGKILL");
        }, 15000);

        proc.stdin.end();
        proc.stdin.on("error", () => {});
        proc.stderr.resume();
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (chunk: string) => {
            if (stdout.length + chunk.length > OUTPUT_LIMIT) {
                problem = new Error("The runner returned too much authenticator output.");
                proc.kill("SIGKILL");
            } else {
                stdout += chunk;
            }
        });
        proc.on("error", () => { problem = new Error("Could not start the runner's authenticator command."); });
        proc.on("close", (code) => {
            clearTimeout(timer);

            if (problem !== undefined) {
                reject(problem);
            } else {
                try {
                    const text = stdout.trim();

                    // Failure JSON is useful too, but a nonzero exit must never report success.
                    if (code !== 0 && !failure(object(text))) {
                        throw new Error("The runner's authenticator command failed.");
                    }

                    resolve(text);
                } catch (error) {
                    reject(error);
                }
            }
        });
    });
}

/** A session owns its child even while the asynchronous environment lookup is still under way. */
class SetupSession {
    private proc: ChildProcessWithoutNullStreams | undefined;
    private opening = false;
    private ended = false;
    private reason: string | undefined;
    private queue: string[] = [];
    private pending: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
    private timer: NodeJS.Timeout;
    private stopTimer: NodeJS.Timeout | undefined;
    private resolveClosed!: () => void;
    readonly closed = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
    failures = 0;
    confirming = false;
    ready = false;
    lastError = ENDED;

    constructor(timeoutMs: number, private readonly onEnd: () => void) {
        this.timer = setTimeout(() => void this.cancel("Authenticator setup timed out. Cancel and start setup again."), timeoutMs);
    }

    async open(spawnSetup: SpawnSetup): Promise<void> {
        if (this.reason !== undefined) {
            throw new Error(this.reason);
        }

        this.opening = true;

        try {
            const proc = await spawnSetup();

            this.proc = proc;
            proc.stderr.resume();
            proc.stdin.on("error", () => void this.cancel(this.lastError));
            proc.on("error", () => void this.cancel("Could not start authenticator setup."));
            proc.on("close", () => this.finish());
            const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });

            lines.on("line", (line) => {
                if (this.reason !== undefined) {
                    return;
                }

                if (line.length > OUTPUT_LIMIT || this.queue.length >= 8) {
                    void this.cancel("The runner returned too much authenticator output.");
                } else if (this.pending !== undefined) {
                    const pending = this.pending;

                    this.pending = undefined;
                    pending.resolve(line);
                } else {
                    this.queue.push(line);
                }
            });

            if (this.reason !== undefined) {
                this.endInput();
                throw new Error(this.reason);
            }
        } catch (error) {
            if (this.proc === undefined) {
                this.finish();
            }

            throw error;
        }
    }

    next(): Promise<string> {
        if (this.reason !== undefined) {
            return Promise.reject(new Error(this.reason));
        }

        const line = this.queue.shift();

        if (line !== undefined) {
            return Promise.resolve(line);
        }

        if (this.ended) {
            return Promise.reject(new Error(this.lastError));
        }

        return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
    }

    write(code: string): void {
        if (this.ended || this.reason !== undefined || this.proc === undefined || !this.proc.stdin.writable) {
            throw new Error(this.reason ?? this.lastError);
        }

        this.proc.stdin.write(`${code}\n`);
    }

    drain(): string[] {
        return this.queue.splice(0);
    }

    succeeded(): boolean {
        return this.proc?.exitCode === 0;
    }

    cancel(reason = CANCELLED): Promise<void> {
        if (this.ended) {
            return this.closed;
        }

        this.reason ??= reason;
        this.pending?.reject(new Error(this.reason));
        this.pending = undefined;
        this.queue = [];

        if (this.proc !== undefined) {
            this.endInput();
        } else if (!this.opening) {
            this.finish();
        }

        return this.closed;
    }

    private endInput(): void {
        this.proc!.stdin.end();
        // A broken/older runner must not stay alive after the page cancels or the app quits.
        this.stopTimer ??= setTimeout(() => this.proc?.kill("SIGKILL"), STOP_MS);
    }

    private finish(): void {
        if (this.ended) {
            return;
        }

        this.ended = true;
        clearTimeout(this.timer);
        clearTimeout(this.stopTimer);
        this.pending?.reject(new Error(this.reason ?? this.lastError));
        this.pending = undefined;
        this.resolveClosed();
        this.onEnd();
    }
}

/** Drives exactly one setup. A replacement cancels the old process before it spawns another. */
export function setUpAuthenticatorSetup(spawnSetup: SpawnSetup, options: { timeoutMs?: number; onEnd?: () => void } = {}) {
    let current: SetupSession | undefined;

    return {
        async start(): Promise<Pick<AuthenticatorSetup, "secret" | "link">> {
            const previous = current;
            const session = new SetupSession(options.timeoutMs ?? TIMEOUT_MS, () => {
                if (current === session) {
                    current = undefined;
                }

                options.onEnd?.();
            });

            current = session;
            await previous?.cancel();

            try {
                await session.open(spawnSetup);
                const setup = parseAuthenticatorSetup(await session.next());

                session.ready = true;
                return setup;
            } catch (error) {
                await session.cancel();
                throw error;
            }
        },
        async confirm(code: string): Promise<AuthenticatorResult> {
            const session = current;

            if (session === undefined || !session.ready) {
                return { ok: false, error: ENDED };
            }

            if (!authenticatorCode(code)) {
                return { ok: false, error: "Enter a 6-digit code from your authenticator." };
            }

            if (session.confirming) {
                return { ok: false, error: "Wait for the current code to be checked." };
            }

            session.confirming = true;

            try {
                session.write(code);
                let result = parseAuthenticatorResult(await session.next(), true);

                if (!result.ok) {
                    session.lastError = result.error;
                    session.failures += 1;
                }

                if (result.ok || session.failures >= 5) {
                    await session.closed;

                    // The fifth wrong code is followed by the runner's final, more useful error line.
                    for (const line of session.drain()) {
                        result = parseAuthenticatorResult(line, true);
                    }

                    if (result.ok && !session.succeeded()) {
                        throw new Error("The runner's authenticator setup failed.");
                    }
                }

                return result;
            } catch (error) {
                await session.cancel();
                return { ok: false, error: (error as Error).message };
            } finally {
                session.confirming = false;
            }
        },
        async cancel(): Promise<void> {
            const session = current;

            current = undefined;
            await session?.cancel();
        },
    };
}
