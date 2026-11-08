# Runner

A runner lets a Pi Pocket server use this computer's files and commands. The agent, models, API keys, and session history stay on the server. Sessions read and write files, run commands, and use git on this computer.

The runner connects out to the server over a WebSocket, so this computer needs no open port and no SSH. The app has the same runner as the `pi-pocket runner` command built in, and the server cannot tell them apart.

> [!WARNING]
> A linked computer trusts its server fully. Sessions run commands and change files as your user on this computer, with access to everything you can reach. Nothing runs in a sandbox. Link only to a server you trust.

## Requirements

The server must support runners. For now, use [vitalNohj/pi-pocket](https://github.com/vitalNohj/pi-pocket/tree/live-0.28) `live-0.28`. The app installs this build for **This computer**, so a server that the app runs on another of your computers supports runners too.

## Link this computer

1. In Pi Pocket, open **Menu → Runners → Link a computer**. Enter a name for this computer, then choose **Get a link code**. The code works once and expires after 10 minutes.
2. In the app, open **Desktop Settings → Runner**. Enter the server address (the app fills in the server it uses) and the code, then choose **Link**. The first link installs Node.js and Pi Pocket for the runner, if needed.
3. In Pi Pocket, open **Menu → Runners**, choose **New session** next to this computer, and choose a folder. The session title shows which computer the session uses.

The runner works while the app is open, also when the window is closed to the tray. The **Runner** page shows the connection state.

| Control | What it does |
|---|---|
| **Enable runner** | Turns the runner on or off. When it is off, the server shows this computer as offline. |
| **Reconnect** | Restarts the connection. |
| **Unlink** | Deletes the link and the runner settings on this computer. Also remove the computer in Pi Pocket's **Runners** to cancel its key. |

## Link other computers

Use the same **Link a computer** screen in Pi Pocket. It shows the install command for a computer without the desktop app, with the Pi Pocket build that your server needs. On that computer, install Node.js 22.19 or newer, run that install command, then run:

```sh
pi-pocket runner
```

Choose **Link this computer**, enter the server address and the code, then choose **Start**. The runner works while its terminal is open.

To keep a runner always on, run `pi-pocket runner service`. On Linux it installs a systemd user service. On Windows and macOS it starts the runner each time you sign in. A service needs an authenticator app first (`pi-pocket runner totp setup`), because nobody is at the computer to approve sessions: you approve them in Pi Pocket with a code from the authenticator.

All runner commands are in Pi Pocket's [runner documentation](https://github.com/vitalNohj/pi-pocket/blob/live-0.28/docs/runners.md).

## Approve sessions

The computer decides which sessions can use it. The server cannot decide for it.

When a session wants to start in a folder that you have not allowed, the app asks you. The question shows the server, the person, and the folder. **Deny** is the default answer. If nobody answers within 2 minutes, the session does not start.

- **Allow** saves the folder on this computer. Later sessions in this folder and its subfolders start without a question.
- For a broad folder (a drive root, your home folder, or a folder that contains your home folder), the app offers **Allow this session only** and saves nothing.
- To start sessions without a question, turn off **Ask before new sessions** on the **Runner** page. No restart is needed.

Moving a session to another folder needs the same approval.

### Allowed folders

The **Runner** page lists the allowed folders. Choose **Remove** to remove a folder. Sessions that already run continue. The list stays on this computer and is never sent to the server.

### What a session can reach

The runner refuses a request unless its session is approved, and checks that each path is in the session's folder. This is not a sandbox: a command still runs as your user, and it can read and change files outside its folder.

## Access

- Only the person who linked a computer can start sessions on it.
- Sessions on a linked computer are private to that person by default.
- The server owner can turn on **Let others use these sessions** in **Menu → Runners**. Then anyone who can prompt a shared session can run commands on that computer.

## Plain HTTP

The runner sends this computer's key and every command to the server, so it uses HTTPS. It uses plain HTTP only to this computer or to a device on your tailnet, which it checks with Tailscale.

To link a server at another plain HTTP address, turn on **Allow plain HTTP** on the **Runner** page first. Do this only on a network you trust.

## When this computer is offline

When the runner is off or the app is closed, the server shows this computer as offline, and its sessions wait. Nothing is lost when the connection drops: commands keep running on this computer, and the session continues when the runner reconnects. Commands that were running when the runner stopped or the computer restarted come back as interrupted.
