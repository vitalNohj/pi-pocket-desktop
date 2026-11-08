# Pi Pocket Desktop guide

How the app works, section by section. For an overview, see the [README](../README.md).

- [Pi Pocket on this computer](#pi-pocket-on-this-computer)
- [Another server](#another-server)
- [Notifications, tray, and badge](#notifications-tray-and-badge)
- [The window](#the-window)
- [See-through background](#see-through-background)
- [Theme](#theme)
- [Spell check and the right-click menu](#spell-check-and-the-right-click-menu)
- [Links](#links)
- [Shortcuts](#shortcuts)
- [Saving server files](#saving-server-files)
- [Desktop Settings](#desktop-settings)
- [Updates](#updates)
- [Troubleshooting](#troubleshooting)

Other guides: [Runner](runner.md) · [Dictation](dictation.md) · [Billion context](billion-context.md)

## Pi Pocket on this computer

Choose **This computer** on the Home page of Desktop Settings, then choose **Install Pi Pocket**. The app downloads Pi Pocket and the Node.js it needs (about 60 MB download, 400 MB on disk), starts the server, and signs you in as its owner.

- **When it runs.** The server runs while the app runs, also when the window is closed to the tray. When you quit the app, the server stops. Running sessions continue at the next start. Turn on **Launch at login** and **Start hidden** to keep an always-on Pi Pocket for your phone.
- **Who can connect.** This computer only, devices on the local network, devices on your Tailscale network, or anyone through a Cloudflare link.
- **Settings.** **Folder for new sessions** sets the starting folder. **Advanced** has the server port, the data folder (`~/.pi-pocket` by default), and **Uninstall the server**. The server log is below **Advanced**.
- **Updates.** The app checks for a newer Pi Pocket and Node.js at startup and each time you open Desktop Settings. It installs them next to the versions in use. The new versions start when Pi Pocket restarts: choose **Restart** in Desktop Settings, choose **Restart Pi Pocket to update** in the tray, or restart the app. If a new version does not start, the previous version runs again. Pi Pocket's own **Settings → Updates** also works.
- **An existing server.** If Pi Pocket already runs on that port (for example, started in a terminal), the app finds it and offers to use it.
- **Your tools.** The server gets the same environment as your terminal, including your shell's `PATH`, so the agent finds `git`, `node`, and your other tools.

The runtimes and `server.log` are in the `server/` folder of the app's data folder (see [Settings file](#settings-file)). Technical details: [local-server.md](local-server.md).

## Another server

Choose **Another server** on the Home page, enter the server's address, choose **Check**, then choose **Connect**. Sign in inside Pi Pocket with your login link or an invite.

- Use the address that you open in a browser, not a model API address.
- A failed check keeps your saved address and any working connection.
- If a sign-in page (for example, Cloudflare Access) is in front of Pi Pocket, add its address to **Server → Another server → Other allowed addresses**, one address per line, without a path. Other links open in your browser.
- If a sign-in page hides Pi Pocket, choose **Open webpage anyway**. This works only for HTML pages. A **Desktop Settings** button stays visible until the app finds Pi Pocket.
- **Advanced** has the connection checks. The defaults: a check every 10 seconds, 3 failed checks before the app reconnects, a maximum retry delay of 30 seconds, and a check timeout of 4 seconds. The app keeps trying after a connection fails.

To set up a server, run `npm install -g pi-pocket && pi-pocket` on it (Node.js 22.19 or newer). See [Server compatibility](../README.md#server-compatibility) for which features each server version supports.

## Notifications, tray, and badge

These features need a server with the app bridge (Pi Pocket 0.28.0 or newer). With an older server, the app shows a message once and works without them.

- **Tray.** Your pinned sessions with their state: ◆ waiting for you, ◐ working, ✕ failed. Click a session to open it. The tray menu also has **Open Pi Pocket**, **New session**, **Dictate**, **Copy last dictation**, **Reload**, an update item when an app or server update is ready, **Desktop Settings…**, and **Quit**.
- **Tray menu on Windows.** The menu is drawn by the app, so it can follow the Windows look or your Pi Pocket theme (**Desktop Settings → Appearance → Tray menu style**). Use the arrow keys, Home, End, Enter, and Escape to move in it.
- **Badge.** The dock or taskbar icon shows how many sessions need you.
- **Notifications.** Native notifications, also when the window is hidden.
  - You can approve or deny a request from the notification. **Deny** is always available. **Approve from notifications** sets when **Allow** shows: only when the full command is visible (default), always, or never.
  - Sessions that finish at the same time share one notification, for example "3 sessions finished".
  - While you are away (the computer sleeps, is locked, or is idle), notifications wait and show once when you return.

## The window

The window has no title bar. Pi Pocket fills the window up to its top edge, and the window buttons sit on top of the page.

- **macOS.** The buttons sit over the sidebar, so the conversation and the panels on the right keep their full height.
- **Windows and Linux.** The buttons sit at the top right. The panel under them is notched around the buttons.
- **Moving the window.** Drag the bar next to the buttons.
- **Standard title bar.** To use the system title bar, set **Desktop Settings → Window → Title bar** to **System**, then restart the app.
- **Menu bar.** On Windows and Linux the menu bar is hidden. Press Alt to show it, or turn on **Desktop Settings → Window → Show menu bar**.
- **Size and position.** The app remembers the window's size and position, and whether it was maximized.
- **Close to tray.** With **Close to tray** on (the default), closing the window keeps the app running in the tray, so notifications, the local server, and the runner keep working. Use **Quit** in the tray menu to stop the app.
- **One app at a time.** If you open the app while it already runs, the open window comes to the front.

The app tells the page where the buttons are with the [Window Controls Overlay](https://developer.mozilla.org/en-US/docs/Web/API/Window_Controls_Overlay_API) web standard. An older Pi Pocket gets a plain band as tall as the buttons.

## See-through background

Turn on **Desktop Settings → Appearance → See-through background**, and set **Opacity** from 0% to 100%. Menus, sheets, and cards stay solid, so text stays easy to read.

| System | How it works |
|---|---|
| **macOS** | The system blur (vibrancy). **Blur** selects the material. |
| **Windows 11** (22H2 or newer) | Acrylic or Mica. Windows 10 does not support it. |
| **Linux** | Turning it on needs a restart (Desktop Settings offers one). Your compositor makes the blur: on Hyprland, `decoration:blur`; on KDE, the Blur effect. GNOME shows the background see-through, without blur. |

## Theme

When you change the theme in Pi Pocket, the app follows: Desktop Settings, the window background, the tray icon, and the right-click menu. On Windows, the window buttons also follow the theme's light or dark mode, so their hover color stays visible. The app remembers the colors, so the next start looks correct before the server answers.

## Spell check and the right-click menu

Text boxes in Pi Pocket are spell checked. Right-click a word that is marked as misspelled to see up to 5 suggestions. Choose one to replace the word, or choose **Add “word” to dictionary** so that the word is never marked again.

The right-click menu also has the edit commands that apply where you click: **Cut**, **Copy**, **Paste**, and **Select All** in a text box, and **Copy** for selected text. **Desktop Settings…** is at the bottom. The menu is styled like Pi Pocket's own menus and uses the colors of your theme.

## Links

- **Session links.** A click on a link to another session on the same server opens it in the same window. ⌘-click, Ctrl-click, Shift-click, Alt-click, or a middle click opens it in a new window.
- **Server pages.** Other pages of the server, such as artifacts, open in an app window. To open them in your browser instead, set **Desktop Settings → Window → Links to Pi Pocket pages** to **System browser**.
- **Other websites** always open in your browser.

## Shortcuts

| Action | Shortcut |
|---|---|
| New session | Ctrl+N (⌘N on macOS), the tray menu, the dock menu (macOS), or a `pi-pocket://new` link |
| Back and forward | Mouse Back and Forward buttons, Alt+Left and Alt+Right (⌘[ and ⌘] on macOS), or trackpad swipes (macOS). This also moves between Pi Pocket and Desktop Settings. |
| Show or hide the window | The global shortcut. Turn it on in **Desktop Settings → Window**. The default is Ctrl+Shift+P (⌘⇧P on macOS). |
| Desktop Settings | Ctrl+, (⌘, on macOS). This works also when the server page fails. |
| Dictation | The dictation key. See [Dictation](dictation.md). |

A new session opens the window with Pi Pocket's **New session** sheet. A server without this feature only shows the window.

## Saving server files

To save a file from a session on the server to this computer, choose **Download** in the file viewer, or Cmd+click (Ctrl+click) its path in a reply. The file goes straight to your Downloads folder, without a save dialog, and the app shows it in Finder, Explorer, or your Linux file manager. An existing file is never replaced: the new file gets the next free name. This needs a server with file downloads (see [Server compatibility](../README.md#server-compatibility)). Other downloads still ask where to save. Sessions on runners keep their usual file actions.

## Desktop Settings

Open **Desktop Settings** from the File menu, the tray menu, Pi Pocket's menu, a right-click on the page, or with Ctrl+, (⌘, on macOS).

The sidebar has two parts:

- **Home** shows where Pi Pocket runs: the server's status and address, with **Start**, **Connect**, or **Back to Pi Pocket**. Below are the two choices, **This computer** and **Another server**, and tiles for **Runner**, **Updates**, and **Dictation**. When a server fails or is missing, Home shows the reason.
- **Settings** is one page that scrolls. The sidebar shows the section you are reading and jumps to any section. Ports, timeouts, and limits are in closed **Advanced** sections.

| Section | What it controls |
|---|---|
| **Window** | Startup, tray, title bar, links, and the global shortcut. |
| **Appearance** | See-through background, opacity, blur, and the tray menu style. |
| **Notifications** | Notifications, sound, and approvals from notifications. |
| **Dictation** | Speech models, the dictation key, and Dictate anywhere. See [Dictation](dictation.md). |
| **Updates** | Updates of the desktop app. |
| **Runner** | Let a server use this computer's files and commands. See [Runner](runner.md). |
| **Server** | The settings of the choice on Home. **This computer**: session folder, who can connect, and server updates. **Another server**: connect at startup, other allowed addresses, and connection checks. **Extensions**: Billion context. |

Selecting **This computer** or **Another server** on Home only shows its settings. It does not connect, disconnect, start, or stop anything. The app changes servers only when you choose **Connect**, **Start**, or **Open**. If Pi Pocket on this computer stops unexpectedly, the app shows a notification.

Settings save automatically. **Back to Pi Pocket** (or Esc) returns to Pi Pocket.

### Settings file

The settings are also a JSON file that you can edit. An invalid value falls back to its default, and Desktop Settings lists it.

| System | Settings file |
|---|---|
| Linux | `~/.config/pi-pocket-gui/config.json` |
| macOS | `~/Library/Application Support/pi-pocket-gui/config.json` |
| Windows | `%APPDATA%\pi-pocket-gui\config.json` |

The folder keeps the name `pi-pocket-gui` from before the project became Pi Pocket Desktop, so existing settings, sign-ins, runner links, and launch-at-login entries keep working. The installed app is still named **Pi Pocket**.

## Updates

**Desktop Settings → Updates** updates the desktop app, not the server. The app checks at startup and each time you open Desktop Settings. Choose **Check now** to check again. Server updates are in **Server → This computer → Server updates**.

| Install type | How it updates |
|---|---|
| **Windows** and **AppImage** | The app downloads the update and asks to restart. On Windows, the installer runs without a window, keeps your earlier choices (only for you or for everyone, and the folder), and asks for administrator rights only for an install for everyone. Then the app opens again. |
| **macOS** | The app is not signed by Apple yet, so it cannot replace itself. It downloads the new disk image to Downloads, checks it against GitHub's checksum, then quits and opens it. Drag the app into Applications to replace the old one, then open it again. Your settings and sign-in stay. |
| **.deb** | The app opens the release page. Install the new .deb. |

Release files are named `pi-pocket-desktop-…`. The Windows installer keeps the name `pi-pocket-gui-win-x64.exe` until it is code-signed. Releases also include the old macOS disk image names, for 0.2.x apps that look for them.

## Troubleshooting

### The page does not respond

The app checks the server and its page every 10 seconds, also for **This computer**.

- If Pi Pocket's starting screen shows for more than 3 seconds, a **Reload** button appears on it.
- If the page stays on Pi Pocket's "starting" screen for 15 seconds after the server answers again, the app reloads it once. If that does not help, the app starts the page again in a new process.
- If the page does not respond for 10 seconds, the app asks whether to reload it.
- **Reload** is always in the tray menu while the window is open, and in **View → Reload**.

### Diagnostics log

The app writes a diagnostics log. It records page hangs and crashes, failed page loads, server restarts, and times when the app itself stops responding for more than 3 seconds (for example, when the tray does not open). For each of those, the log names the last task that the app started. The log stays under 1 MiB.

Open it with **Help → Open diagnostics log**, and attach it to a bug report.

| System | Diagnostics log |
|---|---|
| Linux | `~/.config/pi-pocket-gui/diagnostics.log` |
| macOS | `~/Library/Application Support/pi-pocket-gui/diagnostics.log` |
| Windows | `%APPDATA%\pi-pocket-gui\diagnostics.log` |

### Upgrading from 0.1.0 on macOS

Version 0.1.0 was installed as `pi-pocket-gui.app`. After you install a newer version, move the old app to the Trash.
