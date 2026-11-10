# Desktop Settings, updates, and troubleshooting

## Desktop Settings

Open **Desktop Settings…** from the File menu, the tray menu, Pi Pocket's menu, or a right-click on the page. You can
also press Ctrl+, (⌘, on macOS). This shortcut works even if the server page fails.

Desktop Settings has a sidebar with two parts, **Home** and **Settings**. **Back to Pi Pocket** is at its top (or press
Esc) whenever there is a Pi Pocket to go back to. Opened from a menu, Desktop Settings starts on Home. When a server
fails or is missing, the app shows Home with the reason.

**Home** shows where Pi Pocket runs and the way into it: the server's status and address, with **Start**, **Connect**,
or **Back to Pi Pocket**. Below are the two choices, **This computer** and **Another server**, and tiles for
**Runner**, **Updates**, and **Dictation** that open their section.

**Settings** is one scrolling page. The sidebar marks the section you read and jumps to any of them. Each part has a
short description. Ports, timeouts, and limits are in closed **Advanced** sections. Settings save automatically.

| Section           | What it controls                                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Window**        | Close to tray, launch at login, start hidden, the title bar, the menu bar, where links to Pi Pocket pages open, and the global shortcut.                                                                                           |
| **Appearance**    | The see-through background, its opacity and blur, and on Windows the tray menu's style.                                                                                                                                            |
| **Notifications** | Desktop alerts, sound, and approve from notifications (when the full command is shown, always, or never), with the command length shown.                                                                                         |
| **Dictation**     | Speech models, the dictation key, words as you speak, custom words, recent dictations, and Dictate anywhere. See [dictation.md](dictation.md).                                                                                     |
| **Updates**       | Desktop app updates, checked at startup and each time Settings opens.                                                                                                                                                              |
| **Runner**        | Let your server use this computer's files and commands. See [runner.md](runner.md).                                                                                                                                                |
| **Server**        | Only the side chosen on Home. **This computer**: session folder, who can connect, and server updates. **Another server**: connect at startup, other allowed addresses, and check and retry limits. **Extensions**: Billion context, on both. |

The two choices on Home, **This computer** and **Another server**, only show that side, with a status for each. A click
on a choice does not connect, disconnect, start, or stop anything. The window changes servers only when you click
**Connect**, **Start**, or **Open**. A remote connection stays while you look at This computer. When Pi Pocket on this
computer stops on its own, the app shows a notification.

Use the server address you open in a browser, not a model API address. A failed check keeps your saved address and any
working connection. The status shows **Connected** when Pi Pocket is open. To change servers, enter and check the new
address before you connect.

If a sign-in page hides Pi Pocket, choose **Open webpage anyway**. This is available only for HTML pages. A **Desktop
Settings** button stays visible until Pi Pocket is detected. HTTP errors and other responses return to settings.

In **Server → Another server**, **Other allowed addresses** can include a sign-in page, such as Cloudflare Access. Enter
one address per line, without a path. By default, **Advanced** uses a 10-second server check interval, 3 failed checks
before reconnecting, a 30-second maximum retry delay, and a 4-second check timeout. The app keeps trying after a
connection fails.

## The settings file

The settings are also a JSON file you can edit by hand. A value that is not valid falls back to its default, and the
settings screen lists it. **Show file**, at the bottom of Desktop Settings, opens it.

|         |                                                         |
| ------- | ------------------------------------------------------- |
| Linux   | `~/.config/pi-pocket-gui/config.json`                   |
| macOS   | `~/Library/Application Support/pi-pocket-gui/config.json` |
| Windows | `%APPDATA%\pi-pocket-gui\config.json`                   |

These folder names keep the project's first name, `pi-pocket-gui`, on purpose, and the installed app stays **Pi
Pocket**: existing settings, sign-in, runner links, and launch-at-login entries do not move. The same folder holds
`server/` (Pi Pocket on this computer, see [local-server.md](local-server.md)) and the diagnostics log.

`PI_POCKET_GUI_USER_DATA=/tmp/gui-data` runs the app with a separate settings folder.

## Updates

**Desktop Settings → Updates** manages the desktop app, not the server. The app checks at startup and each time you
open Settings, so what Settings shows is current. There is no timed check. Choose **Check now** to check again. Server
updates are under **Settings → Server → This computer → Server updates**.

- **Windows and the AppImage** download it and install it when the app restarts. The app asks first. On Windows the
  installer runs without its window: it keeps your earlier choice (only for you, or for everyone) and folder, and asks
  for administrator rights only for an install for everyone. Then the app opens again.
- **macOS:** until the app is signed by Apple, macOS will not let it replace itself. It downloads the new disk image to
  Downloads, checked against GitHub's checksum, then quits and opens it (macOS cannot replace an app that is running):
  drag the app into Applications over the old one, then open it again. Your settings and sign-in stay.
- **The .deb** opens the release page: install the new .deb the same way.

New macOS and Linux release files are named `pi-pocket-desktop-…`. Releases also include the old macOS disk-image
names for installed 0.2.x apps; Windows and AppImage updates follow the file names in their update metadata. The
Windows installer keeps its name, `pi-pocket-gui-win-x64.exe`, until it is signed. Existing apps keep finding releases
through GitHub's redirect from the old repository name.

## When the page hangs

The app checks the server and its page every 10 seconds (**Server → Another server → Advanced**), also for **This
computer**. Sometimes the page stays on Pi Pocket's "starting" screen after the server answers again. If it stays there
for 15 seconds, the app reloads it once. If that does not help, the app starts the page again in a new renderer. When
the page does not answer for 10 seconds, the app asks if you want to reload it. While the window is up, the tray menu
always has **Reload**. Its label says when the page does not answer. **View → Reload** does the same.

## Diagnostics

The app writes a diagnostics log. It records page hangs and crashes, failed loads, server restarts, and main-process
stalls. A stall is a time of more than 3 seconds when the app cannot answer (for example, the tray does not open). The
log names the last task the app started before the stall. Open it from **Help → Open diagnostics log**, and attach it
to a bug report. It stays under 1 MiB.

|         |                                                             |
| ------- | ----------------------------------------------------------- |
| Linux   | `~/.config/pi-pocket-gui/diagnostics.log`                   |
| macOS   | `~/Library/Application Support/pi-pocket-gui/diagnostics.log` |
| Windows | `%APPDATA%\pi-pocket-gui\diagnostics.log`                   |
