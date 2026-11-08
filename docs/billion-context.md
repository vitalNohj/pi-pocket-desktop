# Billion context (experimental)

**Billion context** installs [billion-context-pi-pocket](https://github.com/vitalNohj/billion-context-pi-pocket), an extension that compresses the context of long conversations. It summarizes older messages, and Pi can read the originals when it needs them.

This feature is experimental. I have used it every day for over a month, and I want it available to everybody I made this app for. It can still change, and it may not suit every model or session.

## Install

Open **Desktop Settings → Server → Extensions → Billion context**.

- **Pi Pocket on this computer:** choose **Install**. Pi Pocket must be running. The app installs the extension and turns it on.
- **Another server:** the card shows the steps to install the extension on that server (Linux or macOS). On that server, use **Menu → Billion context** to install the extension's runtime.

## The card

The card shows the extension's state (active, bundled, not installed, uninstalled, or needs repair), the installed version, available updates, the last check, and errors.

| Control | What it does |
|---|---|
| **Install**, **Update**, or **Reinstall** | Installs newer extension files when needed, turns the extension on, and installs its runtime. **Reinstall** repairs or verifies the runtime and keeps your history. If the installation fails, the extension's previous on/off state comes back. |
| **Check for updates** | Asks the installed extension for updates. |
| **Uninstall** | Removes only the downloaded runtime. The extension stays on, and its files, settings, chats, and compression history stay. Pi Pocket manages context as usual until you install the runtime again. If the extension is off, turn it on in **Menu → Extensions** first. |
| **Install and update automatically** | On by default. The app installs the extension the first time Pi Pocket runs here, and applies new versions when it checks. |

To turn the extension off or on, use Pi Pocket's **Menu → Extensions**. A copy that you installed by hand under another file name is left alone, and the card says so.

## A note for Pi Pocket's developers

Ideally, only agents, meaning long-running sessions, would use billion-context, and regular sessions would not. Pi Pocket does not separate agents from sessions (a session with a schedule or trigger is an agent), and that is a big feature to add, so this app turns the extension on for all sessions, which is how I use it.

I'd like to explore a Pi Pocket feature that adds "Agents". Agents would use this extension for their compaction, and regular sessions would not. Any agent, like PiP, could be used to orchestrate sessions. PiP, Pi Pocket's assistant, is a session that should get billion-context, for example, in my opinion.

## Technical details

### Automatic install

When Pi Pocket on this computer starts, the app installs and turns on the extension once for each data folder. The app records a successful install in its `billion-context/offered.json`. If you remove the extension files later, the app does not install them again automatically. Turn off **Install and update automatically** to prevent the first install and automatic updates.

### Updates

- The app downloads the newest commit of the extension's `main` branch on GitHub. It checks each file against the git hash in that commit, then puts `billion-context-pi-pocket.ts` and the `billion-context-pi-pocket/` helper folder in Pi Pocket's `extensions` folder.
- The app checks for updates at startup and when Desktop Settings opens, through the installed extension's update route. Every 10 seconds it reads the extension's local state, without a request to GitHub. Older extensions without the update route, and bundled helpers without routes, use the app's own GitHub check.
- Automatic updates keep the extension's on/off state. They install the runtime only when the extension is on, and do not reinstall a runtime that you uninstalled.
- The extension page's **Update** request asks the app to replace the files, also when automatic updates are off. This update also turns the extension on and installs or repairs its runtime.
- A failed update restores the previous files, settings, and on/off state. An interrupted update keeps a recovery record and backups, and the next start of the local server or the next extension action restores them first. Do not remove the `_billion-context-pi-pocket.update/` folder during recovery.

### Migration from the adapter

Installations of `billion-context-pi-pocket-adapter.ts` and its helper folder still work. **Update** migrates them to the new names:

- The old extension is turned off before the new one can load.
- The app copies the settings to `billion-context-pi-pocket.json` with all values. When there are no overrides, it keeps the old `extensionName` and `stateDir` defaults (`billion-context-pi`). The old settings file stays as a backup.
- Conversation and compression state never move.

The app refuses to migrate when both extension names exist, when a helper folder belongs to an extension with another name, or when the old and new settings conflict. Resolve those first: the app does not choose one or overwrite them. An invalid new settings file never falls back to the old settings.

On another server, follow the extension repository's migration instructions first. Keep its stored extension name and state folder, and never turn on both extensions.

### Custom state folder

A custom `stateDir` must be outside both helper folders and the installer's transaction folder. The app stops a file update or the removal of a bundled helper rather than remove state that is kept there. Move that state safely before you continue: changing only the setting would hide the existing state.

### Older bundled helpers

Older bundled helpers have no runtime routes. For them, **Uninstall** turns off the extension and removes only its extension and helper files, and keeps the settings and saved state. **Reinstall** uses the new settings when they exist, and otherwise migrates the old settings.
