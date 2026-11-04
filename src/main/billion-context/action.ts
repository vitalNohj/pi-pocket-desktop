// Actions for the billion-context integration.
import { join } from "node:path";
import { dialog, shell } from "electron";
import type { BillionContextAction } from "../../shared/types";
import { INTEGRATION, INTEGRATION_PAGE } from "./billion-context";
import { state as appState } from "../app/state";

export async function billionContextAction(action: BillionContextAction): Promise<void> {
    const state = appState.gui!;
    const extension = state.billionContext!;

    switch (action) {
        case "install":
            await extension.install();
            break;
        case "check":
            await extension.check();
            break;
        case "show-folder":
            shell.showItemInFolder(join(extension.state().folder, extension.state().installed?.file ?? INTEGRATION.file));
            break;
        case "open-page":
            void shell.openExternal(INTEGRATION_PAGE);
            break;
        case "uninstall": {
            const { response } = await dialog.showMessageBox(state.window, {
                type: "warning",
                message: "Uninstall billion-context-pi?",
                detail: "This removes the downloaded program. Your chats, compression history, and settings stay. Pi Pocket manages context normally until you install it again.",
                buttons: ["Uninstall", "Cancel"],
                defaultId: 1,
                cancelId: 1,
            });

            if (response === 0) {
                await extension.uninstall();
            }

            break;
        }
    }
}
