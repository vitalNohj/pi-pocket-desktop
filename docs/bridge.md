# How the app talks to Pi Pocket

Pi Pocket's page runs in the app as it does in a browser, with one addition: Pi Pocket's **app bridge**
(`window.pocketHost`), a small, versioned interface through which the page tells the app about pins, the badge, and
notifications, and the app tells the page when its window is hidden, what to open, and how a notification's approval
was answered. Pi Pocket documents it in [docs/embedders.md](https://github.com/TannerMidd/pi-pocket/blob/main/docs/embedders.md).

## Which Pi Pocket has it

- **Pi Pocket 0.28.0 and later** (npm `pi-pocket`) ship the app bridge, marked experimental: the tray's pinned
  sessions, the badge, notifications, approve from a notification, and opening what a notification or the tray points
  to. They also make room for the window's buttons (the notch around them on Windows and Linux).
- **New session from anywhere** (⌘N / Ctrl+N, the dock and tray menus, `pi-pocket://new`) uses the bridge's
  `newSession` event, which is not in a release yet: it is on the `live-0.28` branch of
  [vitalNohj/pi-pocket](https://github.com/vitalNohj/pi-pocket/tree/live-0.28), which the app installs for **This
  computer**. A Pi Pocket whose page does not handle it (it does not name `newSession` as it subscribes) gets the window
  shown, without the New session sheet.
- **An older Pi Pocket**, from before the app bridge, still works in the app, without the tray pins, the badge, and
  notifications, and the app says so once. It gets a plain band as tall as the window's buttons.

## Finding Pi Pocket

`GET /api/pocket/info` answers without a sign-in, with `{ "name": "pi-pocket", "bridge": 1 }`. The app uses it to tell
Pi Pocket from other pages, such as a sign-in page in front of it.

## Files

A file of a session on the server can be saved to this computer from the file viewer's **Download** button, or with
Cmd+click (Ctrl+click) on its path in a reply. Its plain download link goes straight to **Downloads**: see
[window.md](window.md#links-spelling-and-files). This needs no bridge capability.
