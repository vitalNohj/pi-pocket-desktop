/**
 * Dictate anywhere's page (src/renderer/anywhere): the small "recording" pill, which also reads the microphone. It only
 * hears what the main process tells it and sends audio back; the main process checks the sender.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("anywhere", {
    /** Calls `listener` with each message from the main process (src/main/dictation/anywhere.ts, PillMessage). */
    listen: (listener: unknown) => {
        if (typeof listener !== "function") {
            return;
        }

        ipcRenderer.on("anywhere:pill", (_event, message: unknown) => {
            (listener as (message: unknown) => void)(message);
        });
        ipcRenderer.send("anywhere:ready");
    },
    audio: (samples: unknown) => {
        if (samples instanceof Float32Array) {
            ipcRenderer.send("anywhere:audio", samples);
        }
    },
    /** The microphone is closed and its last audio sent; or it could not open (`error`). */
    stopped: (error: unknown) => {
        ipcRenderer.send("anywhere:stopped", typeof error === "string" ? error : undefined);
    },
});
