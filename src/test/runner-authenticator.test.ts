import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import {
    authenticatorCode,
    authenticatorCommand,
    parseAuthenticatorResult,
    parseAuthenticatorSetup,
    parseAuthenticatorStatus,
    setUpAuthenticatorSetup,
} from "../main/runner/authenticator";

const secret = "JBSWY3DPEHPK3PXP";
const link = `otpauth://totp/Pi%20Pocket:test?secret=${secret}&issuer=Pi%20Pocket`;
const first = { secret, link };

test("authenticator status accepts only the runner's typed JSON status", () => {
    assert.deepEqual(parseAuthenticatorStatus('{"totp":false,"locked":false}'), { set: false, locked: false });
    assert.deepEqual(parseAuthenticatorStatus('{"totp":true,"locked":true,"lockedUntil":1800000000000}'), { set: true, locked: true, lockedUntil: 1800000000000 });
    for (const text of ["", "usage: totp", "null", "[]", "true", '{}', '{"totp":1,"locked":false}', '{"totp":true,"locked":"false"}', '{"totp":true,"locked":false,"lockedUntil":"soon"}', '{"totp":true,"locked":true,"lockedUntil":-1}', '{"totp":true,"locked":false,"key":"hidden"}', '{"totp":true,"locked":false}\n{}']) {
        assert.throws(() => parseAuthenticatorStatus(text));
    }
    assert.throws(() => parseAuthenticatorStatus('{"ok":false,"error":"Not linked."}'), /Not linked\./);
});

test("setup first line validates a base32 key and matching otpauth TOTP link, without echoing bad secrets", () => {
    assert.deepEqual(parseAuthenticatorSetup(JSON.stringify(first)), first);
    for (const value of [null, [], {}, { ...first, secret: 123 }, { ...first, secret: "not-base32" }, { ...first, secret: `${secret}\n` }, { secret }, { ...first, extra: true }, { ...first, link: "https://example.com/" }, { ...first, link: link.replace("totp", "hotp") }, { ...first, link: `${link}&secret=OTHER` }, { ...first, link: link.replace(secret, "AAAAAAAAAAAAAAAA") }]) {
        assert.throws(() => parseAuthenticatorSetup(JSON.stringify(value)));
    }
    assert.throws(() => parseAuthenticatorSetup('{"ok":false,"error":"Already set up."}'), /Already set up\./);
    assert.throws(() => parseAuthenticatorSetup(`{"secret":"${secret}" BROKEN`), (error: Error) => !error.message.includes(secret));
});

test("setup/off result lines require a boolean ok, the expected totp value, or a nonempty error", () => {
    assert.deepEqual(parseAuthenticatorResult('{"ok":true,"totp":true}', true), { ok: true });
    assert.deepEqual(parseAuthenticatorResult('{"ok":true,"totp":false}', false), { ok: true });
    assert.deepEqual(parseAuthenticatorResult('{"ok":false,"error":"Wrong code."}', true), { ok: false, error: "Wrong code." });
    for (const text of ["", "garbage", "null", "[]", "{}", '{"ok":"true","totp":true}', '{"ok":true}', '{"ok":true,"totp":false}', '{"ok":false}', '{"ok":false,"error":""}', '{"ok":false,"error":123}', '{"ok":true,"totp":true,"secret":"hidden"}']) {
        assert.throws(() => parseAuthenticatorResult(text, true));
    }
    for (const value of ["12345", "1234567", "12345\n", "123456\n", "123456\r", "123456\n123456", "abcdef", "１２３４５６", 123456, null]) assert.equal(authenticatorCode(value), false);
    assert.equal(authenticatorCode("012345"), true);
});

/** A real child process, with the runner's JSON setup protocol (including its 2 final failure lines). */
const fakeSetup = `
import { createInterface } from "node:readline";
console.error("stderr is not JSON and must not enter the setup panel or log");
console.log(${JSON.stringify(JSON.stringify(first))});
const input = createInterface({ input: process.stdin });
let tries = 0;
let saved = false;
input.on("line", code => {
    if (code === "123456") {
        saved = true;
        console.log(JSON.stringify({ ok: true, totp: true }));
        process.exit(0);
    }
    console.log(JSON.stringify({ ok: false, error: "Wrong code." }));
    if (++tries >= 5) {
        console.log(JSON.stringify({ ok: false, error: "Too many wrong codes. No authenticator was saved. Run the setup again." }));
        process.exit(1);
    }
});
input.on("close", () => {
    if (!saved) console.log(JSON.stringify({ ok: false, error: "Cancelled. No authenticator was saved." }));
    process.exit(1);
});
`;

function driver(timeoutMs = 10000) {
    const children: ChildProcessWithoutNullStreams[] = [];
    const output: string[][] = [];
    let ended = 0;
    const setup = setUpAuthenticatorSetup(async () => {
        const proc = spawn(process.execPath, ["--input-type=module", "-e", fakeSetup], { stdio: ["pipe", "pipe", "pipe"] });
        const lines: string[] = [];

        proc.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
        children.push(proc);
        output.push(lines);
        return proc;
    }, { timeoutMs, onEnd: () => { ended++; } });

    return { setup, children, output, ended: () => ended };
}

test("setup driver confirms a right code and forgets the closed process", async () => {
    const { setup, children, ended } = driver();
    try {
        assert.deepEqual(await setup.start(), first);
        assert.deepEqual(await setup.confirm("123456"), { ok: true });
        assert.equal(children[0]!.exitCode, 0);
        assert.equal(ended(), 1);
        assert.equal((await setup.confirm("123456")).ok, false);
    } finally { await setup.cancel(); }
});

test("setup driver keeps a wrong-code attempt open, rejects multiline input, then accepts a right code", async () => {
    const { setup, children } = driver();
    try {
        await setup.start();
        assert.deepEqual(await setup.confirm("000000"), { ok: false, error: "Wrong code." });
        assert.equal(children[0]!.exitCode, null);
        assert.equal((await setup.confirm("123456\n123456")).ok, false);
        assert.deepEqual(await setup.confirm("123456"), { ok: true });
    } finally { await setup.cancel(); }
});

test("setup driver returns the final error after 5 wrong tries and forgets the process", async () => {
    const { setup, children } = driver();
    try {
        await setup.start();
        for (let i = 0; i < 4; i++) assert.deepEqual(await setup.confirm("000000"), { ok: false, error: "Wrong code." });
        assert.deepEqual(await setup.confirm("000000"), { ok: false, error: "Too many wrong codes. No authenticator was saved. Run the setup again." });
        assert.equal(children[0]!.exitCode, 1);
        assert.equal((await setup.confirm("123456")).ok, false);
    } finally { await setup.cancel(); }
});

test("cancel closes stdin and lets the runner cancel without saving", async () => {
    const { setup, children, output } = driver();
    await setup.start();
    await setup.cancel();
    assert.equal(children[0]!.exitCode, 1);
    assert.match(output[0]!.join(""), /Cancelled\. No authenticator was saved\./);
    assert.equal((await setup.confirm("123456")).ok, false);
});

test("timeout ends setup through stdin, without saving", async () => {
    const { setup, children, output } = driver(1500);
    try {
        await setup.start();
        await once(children[0]!, "close");
        assert.equal(children[0]!.exitCode, 1);
        assert.match(output[0]!.join(""), /Cancelled\. No authenticator was saved\./);
        assert.equal((await setup.confirm("123456")).ok, false);
    } finally { await setup.cancel(); }
});

test("a second start cancels the first before opening another setup", async () => {
    const { setup, children, output } = driver();
    try {
        await setup.start();
        assert.deepEqual(await setup.start(), first);
        assert.equal(children.length, 2);
        assert.equal(children[0]!.exitCode, 1);
        assert.match(output[0]!.join(""), /Cancelled\. No authenticator was saved\./);
        assert.equal(children[1]!.exitCode, null);
        assert.deepEqual(await setup.confirm("123456"), { ok: true });
    } finally { await setup.cancel(); }
});

test("cancel during the environment lookup still closes the child when it arrives", async () => {
    let release!: () => void;
    let proc: ChildProcessWithoutNullStreams | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const setup = setUpAuthenticatorSetup(async () => {
        await waiting;
        proc = spawn(process.execPath, ["--input-type=module", "-e", fakeSetup], { stdio: ["pipe", "pipe", "pipe"] });
        return proc;
    });
    const starting = setup.start();
    const failed = assert.rejects(starting, /Cancelled/);
    // start() enters the asynchronous spawn after its initial microtask.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const cancelled = setup.cancel();
    release();
    await Promise.all([failed, cancelled]);
    assert.equal(proc?.exitCode, 1);
});

test("a failed child or malformed setup line fails safely and closes", async () => {
    for (const command of ["missing", "bad-json"]) {
        const setup = setUpAuthenticatorSetup(async () => command === "missing"
            ? spawn(`${process.execPath}-does-not-exist`, [], { stdio: ["pipe", "pipe", "pipe"] })
            : spawn(process.execPath, ["-e", `console.log(${JSON.stringify(`broken ${secret}`)})`], { stdio: ["pipe", "pipe", "pipe"] }));
        try {
            await assert.rejects(setup.start(), (error: Error) => !error.message.includes(secret));
        } finally { await setup.cancel(); }
    }
});

test("one-shot commands reject a nonzero exit that claims success", async () => {
    await assert.rejects(authenticatorCommand(async () => spawn(process.execPath, ["-e", 'console.log(JSON.stringify({ok:true,totp:false}));process.exit(1)'], { stdio: ["pipe", "pipe", "pipe"] })), /command failed/);
});

test("one-shot commands ignore stderr but preserve error JSON from exit 1", async () => {
    const text = await authenticatorCommand(async () => spawn(process.execPath, ["-e", 'console.error("usage details");console.log(JSON.stringify({ok:false,error:"Wrong code."}));process.exit(1)'], { stdio: ["pipe", "pipe", "pipe"] }));
    assert.deepEqual(parseAuthenticatorResult(text, false), { ok: false, error: "Wrong code." });
});
