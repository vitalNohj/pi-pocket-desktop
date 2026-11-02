import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { readSaveFile, saveFileName, saveFilePath } from "../main/bridge/save-file-input";

test("save-file accepts only a server file URL and a string name", () => {
    const input = { url: "/api/c/12/download?path=%2Ftmp%2Fa.txt", name: "a.txt" };

    assert.deepEqual(readSaveFile(input), input);
    assert.deepEqual(readSaveFile({ ...input, name: "" }), { ...input, name: "" });

    for (const value of [null, undefined, "file", [], {}, { ...input, name: 12 }, { ...input, url: null }]) {
        assert.equal(readSaveFile(value), undefined);
    }

    for (const url of ["https://elsewhere.test/api/c/12/download?path=a", "//elsewhere.test/api/c/12/download?path=a", "/api/other/download?path=a", "/api/c/12/file?path=a", "/api/c/12/download", "/api/c/12/download?other=a"]) {
        assert.equal(readSaveFile({ url, name: "a" }), undefined, url);
    }
});

test("save-file names are bounded, not paths, and not hidden", () => {
    assert.equal(saveFileName("report.txt"), "report.txt");
    assert.equal(saveFileName("../a\\b\0\n\x1f\x7f\x85.txt"), "_._a_b_____.txt");
    assert.equal(saveFileName(".secret"), "_secret");
    assert.equal(saveFileName(""), "download");
    assert.equal(saveFileName("a".repeat(250)).length, 200);
    assert.equal(saveFileName("résumé.txt"), "résumé.txt");
});

test("Windows names cannot use invalid characters, device names, or trailing dots and spaces", () => {
    assert.equal(saveFileName("report?.txt", "win32"), "report_.txt");
    assert.equal(saveFileName("report:notes.txt", "win32"), "report_notes.txt");
    assert.equal(saveFileName('a<b>c"d|e?f*g.txt', "win32"), "a_b_c_d_e_f_g.txt");
    assert.equal(saveFileName("report.txt.  ", "win32"), "report.txt");
    assert.equal(saveFileName("   ", "win32"), "download");
    assert.equal(saveFileName("a".repeat(199) + ".rest", "win32"), "a".repeat(199));

    for (const name of ["CON", "con.txt", "PRN", "AUX.log", "nul.txt", "COM1", "com9.txt", "LPT1", "lpt9.txt", "COM¹.txt", "LPT²", "COM³", "CONIN$", "CONOUT$.log", "con .txt"]) {
        assert.equal(saveFileName(name, "win32"), "_" + name, name);
    }
    for (const name of ["content.txt", "COM10.txt", "LPT0.txt", "ordinary.txt"]) {
        assert.equal(saveFileName(name, "win32"), name);
    }

    assert.equal(saveFileName("CON" + " ".repeat(197) + "x", "win32"), "_CON");
    assert.equal(saveFileName("NUL" + ".".repeat(197) + "x", "win32"), "_NUL");
    const longDevice = saveFileName("CON." + "x".repeat(194) + ".x", "win32");

    assert.ok(longDevice.startsWith("_CON."));
    assert.ok(longDevice.length <= 200);
    assert.ok(!/[. ]$/.test(longDevice));

    // Unix names retain characters that are valid there.
    assert.equal(saveFileName("report:notes?.txt", "linux"), "report:notes?.txt");
    assert.equal(saveFileName("report.txt. ", "darwin"), "report.txt. ");
});

test("save-file collisions count before the extension, including in-progress paths", () => {
    const folder = join("tmp", "downloads");
    const existing = new Set([join(folder, "notes.txt"), join(folder, "notes (1).txt")]);

    assert.equal(saveFilePath(folder, "notes.txt", (path) => existing.has(path)), join(folder, "notes (2).txt"));
    assert.equal(saveFilePath(folder, "notes.txt", () => false), join(folder, "notes.txt"));
    assert.equal(saveFilePath(folder, "archive.tar.gz", (path) => path === join(folder, "archive.tar.gz")), join(folder, "archive.tar (1).gz"));
    assert.equal(saveFilePath(folder, "README", (path) => path === join(folder, "README")), join(folder, "README (1)"));
});
