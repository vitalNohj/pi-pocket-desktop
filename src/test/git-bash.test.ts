import assert from "node:assert/strict";
import { test } from "node:test";
import { missingGitBash } from "../main/local-server/git-bash";

const fileAt = (expected: string) => async (path: string) => path === expected;

test("Git Bash check finds bash.exe on Windows Path, including quoted paths with spaces", async () => {
    const env = { Path: 'C:\\Windows\\System32;;"D:\\My tools\\Git\\bin";' };

    assert.equal(await missingGitBash("win32", env, fileAt("D:\\My tools\\Git\\bin\\bash.exe")), false);
});

test("Git Bash check finds the usual system and per-user installs even when not on PATH", async () => {
    const env = {
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        ProgramW6432: "D:\\Program Files",
        LOCALAPPDATA: "C:\\Users\\Pi\\AppData\\Local",
        PATH: "C:\\Windows\\System32",
    };

    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, `${env.LOCALAPPDATA}\\Programs`]) {
        assert.equal(await missingGitBash("win32", env, fileAt(`${root}\\Git\\bin\\bash.exe`)), false, root);
    }

    assert.equal(await missingGitBash("win32", env, fileAt("D:\\elsewhere\\bash.exe")), true);
});

test("Git Bash check does not search the working directory for empty PATH entries", async () => {
    assert.equal(await missingGitBash("win32", { PATH: ";;" }, async () => assert.fail("no folders to check")), true);
});

test("Git Bash is not checked and no notice is needed on macOS or Linux", async () => {
    for (const platform of ["darwin", "linux"] as const) {
        assert.equal(
            await missingGitBash(platform, { Path: "C:\\Windows" }, async () => assert.fail("Windows only")),
            false,
        );
    }
});
