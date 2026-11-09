/** The native runner question's words, kept independent of Electron so the permission promises can be tested. */
import type { RunnerConfirmation } from "./runner";

export function runnerQuestion(request: RunnerConfirmation) {
    if (request.kind === "pi-preview") {
        return {
            title: "Allow seeing a Pi session?",
            message: `${request.person} wants to see your Pi session "${request.title}": its last messages and model. Nothing is changed.`,
            detail: `Asked by: ${request.person}\nServer: ${request.server}\nComputer: ${request.computer}\nFolder: ${request.folder}`,
            buttons: ["Deny", "Allow"],
            notification: `${request.person} wants to see your Pi session "${request.title}". Open Pi Pocket to answer.`,
        };
    }

    const session = request.kind === "fork" ? "a copy of a session" : "a session";
    const action = request.kind === "move" ? "move a session to this folder" : `start ${session} in this folder`;
    const title = request.kind === "move" ? "Allow a session move?" : "Allow a new session?";
    const broad = request.broad !== false;
    const permission = broad
        ? "This folder holds everything in it. Allowing it permanently would allow sessions in all of it. This answer allows only this session and saves no folder."
        : "Allow also lets later sessions in this folder start without asking.";

    return {
        title,
        message: `${request.person} on ${request.server} wants to ${action}.`,
        detail: `Asked by: ${request.person}\nComputer: ${request.computer}\nFolder: ${request.folder}\n\n${permission}\n\nThe session can read and change files and run commands as you, also outside this folder.`,
        buttons: ["Deny", broad ? "Allow this session only" : "Allow"],
        notification: `${request.person} on ${request.server} wants to ${action}: ${request.folder}. Open Pi Pocket to answer.`,
    };
}
