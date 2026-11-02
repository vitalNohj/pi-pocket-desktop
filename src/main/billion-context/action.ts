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
        case "update":
            await extension.update();
            break;
        case "check":
            await extension.check();
            break;
        case "enable":
            await extension.enable();
            break;
        case "disable":
            await extension.disable();
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
                message: "Remove billion-context-pi-pocket from this computer's Pi Pocket?",
                detail: `This turns it off and removes its files from ${extension.state().folder}.\n\nIts settings file and its saved compression state stay. Install puts it back.`,
                buttons: ["Remove", "Cancel"],
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
