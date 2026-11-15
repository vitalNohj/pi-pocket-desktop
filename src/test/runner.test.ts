import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { outdatedLink, runnerError, setUpRunner, type RunnerHost } from "../main/runner/runner";
import { validateSettings } from "../main/core/settings";

function host(home: string, overrides: Partial<RunnerHost> = {}): RunnerHost {
    let enabled = true;

    return {
        home,
        platform: process.platform,
        enabled: () => enabled,
        setEnabled: async (next) => {
            enabled = next;
        },
        runtime: () => undefined,
        prepare: async () => {},
        newerRunnerHint: () => "Choose Check now under Updates, then link again.",
        environment: async () => ({ ...process.env }),
        changed: () => {},
        ...overrides,
    };
}

/** A link file as the runner writes it now: with its server's key. */
const link = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ server: "https://pocket.example", id: "a", name: "Mac", key: "secret", serverKey: "server-secret", ...extra });

/** The runner's help, as it prints it after an unknown command. */
const HELP = "pi-pocket runner: run session tools on this computer.\n\n  pi-pocket runner start\n    Run with the saved link.";

test("without a link it is unlinked, and with one but no runtime it says what to do", () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));

    try {
        const runner = setUpRunner(host(home));

        runner.boot();
        assert.equal(runner.state().status, "unlinked");
        assert.equal(runner.state().link, undefined);

        writeFileSync(join(home, "runner.json"), link());
        runner.boot();

        const state = runner.state();

        assert.equal(state.status, "failed");
        assert.match(state.message ?? "", /Install or update Pi Pocket under This computer on Home/);
        assert.deepEqual(state.link, { server: "https://pocket.example", id: "a", name: "Mac" });
        assert.equal(JSON.stringify(state).includes("secret"), false, "no key leaves the file");
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

/** A stand-in launcher: links, runs, and records its arguments. */
function fakeRuntime(
    home: string,
    options: { script?: string; linkError?: string; exit?: number } = {},
): { node: string; launcher: string; bin: string } {
    const launcher = join(home, "fake-launcher.mjs");

    writeFileSync(
        launcher,
        `import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const file = args[args.indexOf("--config") + 1];
appendFileSync(${JSON.stringify(home)} + "/calls.jsonl", JSON.stringify(args) + "\\n");
if (args[1] === "link") {
    const error = ${JSON.stringify(options.linkError ?? "")};
    if (error) { console.error(error); process.exit(1); }
    if (args[3] === "BAD-CODE") { console.error("pi-pocket runner: refused the code"); process.exit(1); }
    writeFileSync(file, JSON.stringify({ server: args[2], id: "id", name: "Mac", key: "k", serverKey: "s", ...(args.includes("--allow-http") ? { allowHttp: true } : {}) }));
    console.log("Linked.");
} else if (args[1] === "start") {
    const exit = ${JSON.stringify(options.exit ?? null)};
    if (exit !== null) { console.error("pi-pocket runner: The server ended this link."); process.exit(exit); }
    console.log("[00:00:00] Connected to server as Mac.");
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
    ${options.script ?? ""}
} else {
    console.error("pi-pocket runner: Unknown command \\"" + args[1] + "\\".\\n\\n" + ${JSON.stringify(HELP)});
    process.exit(1);
}
`,
    );

    return { node: process.execPath, launcher, bin: home };
}

function calls(home: string): string[][] {
    const path = join(home, "calls.jsonl");

    return existsSync(path) ? readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as string[]) : [];
}

async function until(check: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (check()) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.fail(`timed out waiting for ${what}`);
}

test("off and on again quickly while it stops: it runs again, as the setting says", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    let enabled = true;
    const runtime = fakeRuntime(home);
    const runner = setUpRunner(host(home, { enabled: () => enabled, setEnabled: async (next) => { enabled = next; }, runtime: () => runtime }));

    try {
        await runner.linkTo("https://pocket.example", "GOOD-CODE", false);
        await until(() => runner.state().status === "connected", "connected");

        enabled = false;
        runner.enabledChanged();
        enabled = true;
        runner.enabledChanged();

        await until(() => runner.state().status === "connected", "connected again");
    } finally {
        await runner.quit();
        rmSync(home, { recursive: true, force: true });
    }
});

test("a failed link keeps the link before running", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    const runtime = fakeRuntime(home);
    const runner = setUpRunner(host(home, { runtime: () => runtime }));

    try {
        await runner.linkTo("https://pocket.example", "GOOD-CODE", false);
        await until(() => runner.state().status === "connected", "connected");
        await assert.rejects(runner.linkTo("https://other.example", "BAD-CODE", false), /^Error: refused the code$/);
        await until(() => runner.state().status === "connected", "connected again");
        assert.equal(runner.state().link?.server, "https://pocket.example");
    } finally {
        await runner.quit();
        rmSync(home, { recursive: true, force: true });
    }
});

test("an older file's runner.confirmSessions is dropped quietly, and Allow plain HTTP is off unless true", () => {
    for (const input of [undefined, { runner: { enabled: false } }, { runner: { confirmSessions: false } }, { runner: { confirmSessions: "off" } }]) {
        const result = validateSettings(input);

        assert.equal("confirmSessions" in result.settings.runner, false);
        assert.equal(result.settings.runner.allowHttp, false);
        assert.deepEqual(result.problems, []);
    }

    assert.equal(validateSettings({ runner: { allowHttp: true } }).settings.runner.allowHttp, true);
    assert.deepEqual(validateSettings({ runner: { allowHttp: "yes" } }).problems, [{ path: "runner.allowHttp", message: "must be true or false" }]);
    assert.deepEqual(validateSettings({ runner: { other: true } }).problems, [{ path: "runner.other", message: "is not a setting" }]);
});

test("the app only links and starts the runner: no settings, folders, or authenticator commands", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    const runtime = fakeRuntime(home, { script: `console.log('PI-POCKET-ACTIVITY {"working":true,"folders":["/secret/project"]}');` });
    const runner = setUpRunner(host(home, { runtime: () => runtime }));
    const file = join(home, "runner.json");

    try {
        await runner.linkTo("https://pocket.example", "GOOD-CODE", false);
        await until(() => runner.state().status === "connected", "connected");
        runner.state();
        await new Promise((resolve) => setTimeout(resolve, 200));

        assert.deepEqual(calls(home), [
            ["runner", "link", "https://pocket.example", "GOOD-CODE", "--config", file],
            ["runner", "start", "--config", file],
        ]);
        assert.ok(runner.state().log.some((line) => line.includes("Connected to server")));
        assert.equal(runner.state().log.some((line) => line.includes("PI-POCKET-")), false, "lines for a program stay out of the log");
        assert.deepEqual(Object.keys(runner.state()).sort(), ["available", "enabled", "link", "log", "status"]);
    } finally {
        await runner.quit();
        rmSync(home, { recursive: true, force: true });
    }
});

test("the card follows the runner's own lines: dropped, back, and why it cannot connect", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    const say = (line: string, ms: number) => `setTimeout(() => console.log(${JSON.stringify(`[00:00:01] ${line}`)}), ${String(ms)});`;
    const runtime = fakeRuntime(home, {
        script: say("Disconnected (server restart). Reconnecting automatically. Commands keep running; their sessions continue when the link is back.", 300)
            + say("Connection error (connect ECONNREFUSED 127.0.0.1:8787). If the runner does not connect, check the address and network.", 600)
            + say("https://pocket.example returned HTTP 502. Retrying automatically. If this continues, check that Pi Pocket is running at this address.", 900)
            + say("Reconnected to https://pocket.example. Running commands continue.", 1200),
    });
    const runner = setUpRunner(host(home, { runtime: () => runtime }));
    const seen: string[] = [];
    const note = () => {
        const state = runner.state();
        const now = `${state.status}: ${state.message ?? ""}`;

        if (seen.at(-1) !== now) {
            seen.push(now);
        }

        return state.status;
    };

    try {
        await runner.linkTo("https://pocket.example", "GOOD-CODE", false);
        await until(() => note() === "connected", "connected");
        await until(() => note() === "connecting", "dropped");
        await until(() => note() === "connected", "back");
        assert.deepEqual(seen.slice(-5), [
            "connected: ",
            "connecting: Reconnecting. Sessions must wait for the server.",
            "connecting: Cannot reach the server: connect ECONNREFUSED 127.0.0.1:8787.",
            "connecting: https://pocket.example returned HTTP 502. Retrying automatically. If this continues, check that Pi Pocket is running at this address.",
            "connected: ",
        ]);
    } finally {
        await runner.quit();
        rmSync(home, { recursive: true, force: true });
    }
});

test("Allow plain HTTP is each link's own choice, and only the link keeps it", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    const runtime = fakeRuntime(home);
    const runner = setUpRunner(host(home, { runtime: () => runtime }));
    const saved = () => (JSON.parse(readFileSync(join(home, "runner.json"), "utf8")) as { allowHttp?: boolean }).allowHttp;

    try {
        await runner.linkTo("http://pocket.lan:8787", "GOOD-CODE", true);
        await until(() => runner.state().status === "connected", "connected");
        assert.deepEqual(calls(home)[0]?.slice(1, 5), ["link", "http://pocket.lan:8787", "GOOD-CODE", "--allow-http"]);
        assert.equal(saved(), true);

        // Nothing changes it afterwards: a restart runs no command but the start.
        await runner.restart();
        await until(() => runner.state().status === "connected", "connected again");
        assert.equal(saved(), true);
        assert.equal(calls(home).filter((args) => args[1] !== "link" && args[1] !== "start").length, 0);

        // The next link says no: it gets no flag, whatever the link before had.
        await runner.linkTo("https://pocket.example", "GOOD-CODE", false);
        assert.equal(saved(), undefined);
        assert.equal(calls(home).filter((args) => args[1] === "link").at(-1)?.includes("--allow-http"), false);
    } finally {
        await runner.quit();
        rmSync(home, { recursive: true, force: true });
    }
});

test("a failed command's message is its first paragraph: never the runner's help", () => {
    assert.equal(runnerError(`pi-pocket runner: Unknown command "settings".\n\n${HELP}`, 1), 'Unknown command "settings".');
    assert.equal(runnerError("pi-pocket runner: line one\nline two\r\n\r\nmore", 1), "line one\nline two");
    // The launcher's warning comes before the runner's error: the message starts at the error.
    assert.equal(
        runnerError(`Node.js 24.21.0 lacks security fixes: update to 24.22.1 or newer.\npi-pocket runner: Unknown command "folders".\n\n${HELP}`, 1),
        'Unknown command "folders".',
    );
    assert.equal(runnerError("\n\nno mark here\nsecond line\n\nlater", 1), "no mark here\nsecond line");
    assert.equal(runnerError("\n\n  \n", 2), "The runner stopped with code 2.");
    assert.equal(runnerError("", null), "The runner stopped with code null.");

    const long = runnerError("x".repeat(5000), 1);

    assert.equal(long.length, 601);
    assert.ok(long.endsWith("…"));
});

test("a link the runner refuses with its help shows one short message in the form and the log", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    const runtime = fakeRuntime(home, { linkError: `pi-pocket runner: The address is not a Pi Pocket server.\n\n${HELP}` });
    const runner = setUpRunner(host(home, { runtime: () => runtime }));

    try {
        await assert.rejects(runner.linkTo("https://pocket.example", "GOOD-CODE", false), (error: Error) => {
            assert.equal(error.message, "The address is not a Pi Pocket server.");

            return true;
        });
        assert.equal(runner.state().status, "unlinked");
        assert.equal(JSON.stringify(runner.state()).includes("pi-pocket runner start"), false, "no help text anywhere in the card");
    } finally {
        await runner.quit();
        rmSync(home, { recursive: true, force: true });
    }
});

test("a link from an older Pi Pocket says Link again, is never started, and a new link runs", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    const runtime = fakeRuntime(home);
    let enabled = true;
    const runner = setUpRunner(host(home, { enabled: () => enabled, setEnabled: async (next) => { enabled = next; }, runtime: () => runtime }));

    try {
        // Before the runner kept its server's key: no `serverKey`.
        writeFileSync(join(home, "runner.json"), JSON.stringify({ server: "https://pocket.example", id: "a", name: "Mac", key: "secret" }));
        runner.boot();

        assert.equal(runner.state().status, "ended");
        assert.equal(runner.state().message, outdatedLink("Mac"));
        assert.match(runner.state().message ?? "", /Menu → Runners, choose Link again on “Mac”/);
        assert.deepEqual(runner.state().link, { server: "https://pocket.example", id: "a", name: "Mac" });

        await runner.restart();
        enabled = false;
        runner.enabledChanged();
        await new Promise((resolve) => setTimeout(resolve, 100));
        enabled = true;
        runner.enabledChanged();
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(runner.state().status, "ended", "it stays so through Reconnect and the switch");
        assert.deepEqual(calls(home), [], "the runner would only stop at once: it is not started");

        await runner.linkTo("https://pocket.example", "GOOD-CODE", false);
        await until(() => runner.state().status === "connected", "connected");
        assert.equal(runner.state().message, undefined);
    } finally {
        await runner.quit();
        rmSync(home, { recursive: true, force: true });
    }
});

test("a link the server ended stops for good; Unlink forgets it", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    const runtime = fakeRuntime(home, { exit: 3 });
    const runner = setUpRunner(host(home, { runtime: () => runtime }));

    try {
        await runner.linkTo("https://pocket.example", "GOOD-CODE", false);
        await until(() => runner.state().status === "ended", "ended");
        assert.equal(runner.state().message, "The server ended this link.");
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(calls(home).filter((args) => args[1] === "start").length, 1, "no restart");

        await runner.unlink();
        assert.equal(runner.state().status, "unlinked");
        assert.equal(runner.state().link, undefined);
        assert.equal(runner.linked(), false);
    } finally {
        await runner.quit();
        rmSync(home, { recursive: true, force: true });
    }
});

test("a runner that stops by itself starts again, and the card says when", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    const runtime = fakeRuntime(home, { exit: 1 });
    const runner = setUpRunner(host(home, { runtime: () => runtime }));

    try {
        await runner.linkTo("https://pocket.example", "GOOD-CODE", false);
        await until(() => runner.state().status === "failed", "failed");
        assert.match(runner.state().message ?? "", /^The runner stopped \(code 1\)\. Restarting in 2 s\. The server ended this link\.$/);
    } finally {
        await runner.quit();
        rmSync(home, { recursive: true, force: true });
    }
});

test("linking installs Pi Pocket first when no runtime has the runner, and says so when it still has none", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    let prepared = 0;

    try {
        const runner = setUpRunner(host(home, { prepare: async () => { prepared++; } }));

        await assert.rejects(runner.linkTo("https://pocket.example", "ABCD-EFGH-JKLM", false), /The runner is not available\. Choose Check now under Updates/);
        assert.equal(prepared, 1);
        assert.equal(runner.state().busy, undefined);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("every link looks for a newer runner first, and is made by the one found", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    const older = join(home, "older");
    const newer = join(home, "newer");

    mkdirSync(older);
    mkdirSync(newer);

    // The runner this computer has is too old for its server; the check before the link brings the newer one.
    const old = fakeRuntime(older, { linkError: "pi-pocket runner: https://pocket.example did not accept the code: Update Pi Pocket's runner on this computer, then link it again." });
    const fresh = fakeRuntime(newer);
    let current = old;
    const shown: string[] = [];
    const runner = setUpRunner(
        host(home, {
            runtime: () => current,
            prepare: async () => {
                current = fresh;
            },
            changed: () => {
                shown.push(`${runner.state().busy ?? ""}${runner.state().preparing === true ? " (preparing)" : ""}`);
            },
        }),
    );

    try {
        await runner.linkTo("https://pocket.example", "GOOD-CODE", false);
        await until(() => runner.state().status === "connected", "connected");
        assert.ok(shown.includes("Looking for a newer runner… (preparing)"), "the card says what it waits for");
        assert.equal(shown.at(-1), "", "and nothing once the link is made");
        assert.equal(runner.state().preparing, undefined);
        assert.deepEqual(calls(older), [], "the older runner never sent the code");
        assert.equal(calls(newer)[0]?.[1], "link");
    } finally {
        await runner.quit();
        rmSync(home, { recursive: true, force: true });
    }
});

test("a server that needs a newer runner than the app could get: the form says where the newer one comes from", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    const runtime = fakeRuntime(home, { linkError: "pi-pocket runner: https://pocket.example did not accept the code: Update Pi Pocket's runner on this computer, then link it again." });
    let prepared = 0;
    const runner = setUpRunner(
        host(home, {
            runtime: () => runtime,
            // The check found nothing newer, or failed: the runtime there is stays.
            prepare: async () => { prepared++; },
            newerRunnerHint: () => "The app could not get a newer one: api.github.com answered HTTP 403. Choose Check now under Updates, then link again.",
        }),
    );

    try {
        await assert.rejects(runner.linkTo("https://pocket.example", "GOOD-CODE", false), (error: Error) => {
            assert.equal(
                error.message,
                "https://pocket.example needs a newer runner than this computer has. The app could not get a newer one: api.github.com answered HTTP 403. Choose Check now under Updates, then link again.",
            );

            return true;
        });
        assert.equal(prepared, 1);
        assert.equal(runner.state().status, "unlinked");
    } finally {
        await runner.quit();
        rmSync(home, { recursive: true, force: true });
    }
});

test("an update moves a running runner to the newest runtime before the older one goes away", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    const older = join(home, "older");
    const newer = join(home, "newer");

    mkdirSync(older);
    mkdirSync(newer);

    const old = fakeRuntime(older);
    const fresh = fakeRuntime(newer);
    let current = old;
    const runner = setUpRunner(host(home, { runtime: () => current }));

    try {
        await runner.linkTo("https://pocket.example", "GOOD-CODE", false);
        await until(() => runner.state().status === "connected", "connected");
        assert.equal(calls(newer).length, 0);

        current = fresh;
        await runner.runtimeChanged();
        // Its promise ends once nothing runs from the older runtime: only then may that one be removed.
        assert.notEqual(runner.state().status, "connected", "the older runner has stopped");
        await until(() => runner.state().status === "connected", "connected again");
        assert.deepEqual(calls(newer).map((args) => args[1]), ["start"]);

        // Nothing changed: it keeps running.
        await runner.runtimeChanged();
        assert.equal(runner.state().status, "connected");
        assert.equal(calls(newer).length, 1);
    } finally {
        await runner.quit();
        rmSync(home, { recursive: true, force: true });
    }
});
