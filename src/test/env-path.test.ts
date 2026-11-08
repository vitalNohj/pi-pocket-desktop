import assert from "node:assert/strict";
import { test } from "node:test";
import { withPath } from "../main/core/env-path";

test("Windows: the folder joins the Path key the environment has; no second PATH hides it", () => {
    const env = {
        Path: "C:\\Windows\\System32;C:\\Windows",
        SystemRoot: "C:\\Windows",
    };
    const result = withPath(env, "C:\\runtime\\bin", "last", "win32");

    assert.deepEqual(
        Object.keys(result).filter((key) => key.toUpperCase() === "PATH"),
        ["Path"],
    );
    assert.equal(result.Path, "C:\\Windows\\System32;C:\\Windows;C:\\runtime\\bin");
    assert.equal(withPath(env, "C:\\b", "first", "win32").Path, "C:\\b;C:\\Windows\\System32;C:\\Windows");
});

test("Windows: of two keys, the one with a value is kept, and only one is left", () => {
    const result = withPath({ PATH: "", Path: "C:\\x" }, "C:\\b", "last", "win32");

    assert.deepEqual(Object.keys(result), ["Path"]);
    assert.equal(result.Path, "C:\\x;C:\\b");
});

test("Linux and macOS: PATH, with colons", () => {
    assert.equal(withPath({ PATH: "/usr/bin" }, "/opt/b", "last", "linux").PATH, "/usr/bin:/opt/b");
    assert.equal(withPath({ PATH: "/usr/bin" }, "/opt/b", "first", "darwin").PATH, "/opt/b:/usr/bin");
    assert.equal(withPath({}, "/opt/b", "last", "linux").PATH, "/opt/b");
});
