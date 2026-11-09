import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runnerQuestion } from "../main/runner/runner-question";
import type { RunnerConfirmation } from "../main/runner/runner";

const request: RunnerConfirmation = {
    id: 1, kind: "pi-preview", title: "Fix the cart", person: "Sam",
    folder: "/Users/me/cart", computer: "Laptop", server: "https://pocket.example",
};

test("a Pi preview promises only the last messages and model, with no saved-folder words", () => {
    const question = runnerQuestion(request);

    assert.equal(question.title, "Allow seeing a Pi session?");
    assert.equal(question.message, 'Sam wants to see your Pi session "Fix the cart": its last messages and model. Nothing is changed.');
    assert.deepEqual(question.buttons, ["Deny", "Allow"]);
    assert.match(question.detail, /Server: https:\/\/pocket.example/);
    assert.match(question.detail, /Folder: \/Users\/me\/cart/);
    assert.doesNotMatch(JSON.stringify(question), /permanent|later sessions|commands|save.*folder/i);
    const source = readFileSync("src/main/runner/runner-dialog.ts", "utf8");

    assert.match(source, /runnerQuestion\(request\)/);
    assert.match(source, /defaultId: 0/);
    assert.match(source, /cancelId: 0/);
});

test("ordinary session and move questions keep their original folder permission warnings", () => {
    assert.match(runnerQuestion({ ...request, kind: "new", broad: false }).detail, /Allow also lets later sessions/);
    assert.deepEqual(runnerQuestion({ ...request, kind: "fork", broad: true }).buttons, ["Deny", "Allow this session only"]);
    assert.equal(runnerQuestion({ ...request, kind: "move" }).title, "Allow a session move?");
});
