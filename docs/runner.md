# The runner

A runner lets your Pi Pocket server use this computer's files and commands. The agent, models, API keys, and history
stay on the server. This computer connects out to the server, so no SSH or open port is needed.

The app has the same runner as `pi-pocket runner` built in, and links the same way: the server cannot tell them apart.
Its card is **Runner** in the Desktop Settings sidebar, or the Runner tile on Home. Pi Pocket's own guide to runners,
for the server side and for computers without this app, is
[docs/runners.md](https://github.com/vitalNohj/pi-pocket/blob/live-0.28/docs/runners.md).

> [!WARNING]
> A linked computer trusts its server fully. Sessions started on it run commands and change files as your user on that
> computer, with everything you can reach. Nothing runs in a sandbox. Link only to a server you trust. The **Runner**
> card says this next to **Link**.

## Link this computer

1. In Pi Pocket, open **Menu → Runners → Link a computer**, name this computer, and choose **Get a link code**. The
   code works once and expires after 10 minutes.
2. In the app's **Runner** card, enter the server's address (filled in with the server the app uses) and the code, then
   choose **Link**. The first link installs Node.js and Pi Pocket for the runner if needed (about 60 MB).
3. Under **Menu → Runners**, choose **New session** on this computer and pick a folder. The session title shows which
   computer it uses.

The runner works while the app is open, including in the tray. The card shows the connection state. **Enable runner**
turns it off and on (off, the server shows this computer as offline), **Reconnect** starts it again, and **Unlink**
removes the link with all its settings. The **Runner log** is at the bottom of the card.

**Link another computer:** the same code from **Menu → Runners → Link a computer**. Pi Pocket shows the commands for a
computer without this app.

## Approvals

By default the app asks before the server starts a new session, a copy of a session, or a move, in a folder that is not
yet allowed on this computer. The question shows the server, person, and folder; **Deny** is the default. A session can
read and change files and run commands as you, also outside that folder. If nobody answers within 2 minutes (5 minutes
with an authenticator), the session does not start.

Turn off **Ask before new sessions** in the card to start sessions without asking. The app saves the choice with
`runner settings confirm on|off --config FILE`; no runner restart is needed.

**Continue a Pi session:** the server can list the titles and folders of Pi's own sessions on this computer. Seeing a
session's last messages and model asks **Allow seeing a Pi session?**, with **Deny** as the default. Continuing it asks
the normal new-session question.

## Allowed folders

**Allow** saves the folder on this computer, so later sessions in it or its subfolders start without asking. A root,
your home folder, or an ancestor of your home offers **Allow this session only** and saves nothing. The card lists the
folders and lets you **Remove** one; existing sessions keep running. Moving a session to another folder follows the
same check. The list never goes to the server.

## Authenticator

With an authenticator app (Google Authenticator, 1Password, Authy, and others), you can approve sessions and folders,
and change the runner's settings, from Pi Pocket with a 6-digit code, without going to this computer. It is off by
default, and each computer has its own.

Set it up in **Desktop Settings → Runner → Authenticator → Set up**: scan the QR code (or type the key) in your
authenticator app, then enter the code it shows and choose **Confirm**. The runner saves the key only when that code is
right. **Turn off** needs a code too. In a terminal, `pi-pocket runner totp setup` does the same.

Without an authenticator, Pi Pocket cannot approve sessions and folders here with a code, and runner settings change
only on this computer.

Lost your authenticator? **Unlink** (it needs no code, because it only removes access), then link again with a new
code. Unlinking deletes the authenticator's key, the allowed folders, and the approved sessions with it.

## Plain HTTP

The runner sends this computer's key and every command to the server, so it uses HTTPS. It uses plain HTTP only to this
computer or to a device on your tailnet, which it checks with Tailscale itself. To link a server on another plain HTTP
address, turn on **Allow plain HTTP** in the card first, and only on a network you trust.

## When this computer is offline

When the runner is off, the app is closed, or the network drops, the server shows this computer as offline. Offline is
not a failure:

- **Sessions wait.** A message or tool call for this computer waits until it is back, then the session continues where
  it stopped. **Stop** in Pi Pocket ends the wait.
- **Commands keep running** on this computer while the runner process lives, for any length of connection drop. Their
  output arrives when the runner reconnects.
- **Background tasks belong to the runner.** A network drop or a server restart does not stop them. They stop only when
  the runner process ends: you quit the app, turn off **Enable runner**, unlink, or the computer restarts. Their logs
  and exit codes stay.
- **Questions stay open.** A drop does not approve or deny a question. It stays open here with its time limit, and an
  answer given while offline is sent after reconnecting.

A new session, a fork, or a move to another folder on an offline computer cannot start: the computer must answer
whether it allows the folder.

## Who can use it

Only you can start sessions on a computer you linked. These sessions are private by default. The server owner can turn
on **Share sessions on linked computers** under **Menu → Runners**. Anyone who can prompt a shared session can run
commands on this computer.

## Start at sign-in

The app's runner runs while the app runs. To have it start when you sign in, turn on **Launch at login** (with **Start
hidden**, the app waits in the tray). The separate `pi-pocket runner service` command, which installs a systemd user
service on Linux, a scheduled task on Windows, or a launch agent on macOS, belongs to the Pi Pocket command line, for a
computer without this app; the app does not install it.

## The server must support runners

Runners are not in a Pi Pocket release yet: they are proposed upstream in
[TannerMidd/pi-pocket#312](https://github.com/TannerMidd/pi-pocket/pull/312). Until it is merged, the server must run
[vitalNohj/pi-pocket](https://github.com/vitalNohj/pi-pocket/tree/live-0.28) `live-0.28`. This is the build the app
installs for **This computer**, so a Pi Pocket the app runs supports runners.
