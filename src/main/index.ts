/**
 * The main process. One window holds two views: the server's page (Pi Pocket itself) and the app's config screen. The
 * server's page stays loaded while the config screen shows, so going back is instant and nothing it was doing stops.
 */
import { join } from "node:path";
import { app } from "electron";
import { registerAppScheme } from "./settings-screen/config-protocol";
import { listenForNewSessionLinks } from "./bridge/new-session";
import { diagnose, startDiagnostics } from "./diagnostics/stall-watchdog";
import { start } from "./app/start";

// Settings and the server's cookies live in <appData>/pi-pocket-gui, apart from the display name, which may change.
const userData = process.env.PI_POCKET_GUI_USER_DATA;

app.setName("Pi Pocket");
app.setPath(
    "userData",
    userData !== undefined && userData !== "" ? userData : join(app.getPath("appData"), "pi-pocket-gui"),
);
registerAppScheme();

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    // First: a stall of the main process from here on lands in the log (src/main/diagnostics/stall-watchdog.ts).
    startDiagnostics(join(app.getPath("userData"), "diagnostics.log"));
    diagnose(`app started: version ${app.getVersion()}, Electron ${process.versions.electron}, ${process.platform} ${process.getSystemVersion()}`);
    listenForNewSessionLinks();
    void start();
}
