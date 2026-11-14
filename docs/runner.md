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
removes the link. The **Runner log** is at the bottom of the card.

**Link again.** A link made by an older Pi Pocket no longer works: the card says **Link ended** and shows the link form.
In Pi Pocket, open **Menu → Runners**, choose **Link again** on this computer, and enter the new code. The computer
keeps its name and its sessions.

**Link another computer:** the same code from **Menu → Runners → Link a computer**. Pi Pocket shows the commands for a
computer without this app.

## People, folders, and approvals

These are set on the server, not in the app. After the link, the runner trusts its server, and the app asks nothing on
this computer. In Pi Pocket, open **Menu → Runners** and find this computer's card:

- **People.** Whoever linked the computer is in charge of it, and chooses the people who may use it with **Choose
  people**. Nobody else sees its sessions, browses it, or starts anything on it.
- **Folders.** Whoever is in charge gives each chosen person their folders, under **Folders** on the card. A given
  folder covers the folders inside it. Any other folder is refused.
- **Approvals.** A person who is not in charge approves a new session with a code from their own authenticator, which
  they link to their account in Pi Pocket (**Menu → their name**), or waits for **Allow** from whoever is in charge.
  Whoever is in charge is never asked on their own computer.

The app has no authenticator of its own, no list of allowed folders, and no question before a session starts. Pi
Pocket's guide has every rule: [Who may use a computer](https://github.com/vitalNohj/pi-pocket/blob/live-0.28/docs/runners.md#who-may-use-a-computer).

## Plain HTTP

The link encrypts every command, and the runner still uses HTTPS. It uses plain HTTP only to this computer or to a
device on your tailnet, which it checks with Tailscale itself. To link a server on another plain HTTP address, turn on
**Allow plain HTTP** in the link form before you choose **Link**, and only on a network you trust. The choice is saved
with the link: to change it, link again.

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
A new session, a fork, or a move to another folder on an offline computer cannot start.

## Who can use it

Only the people chosen for this computer in **Menu → Runners**, each in the folders given to them. A session here is
private to the person who started it. That person, or whoever is in charge of the computer, shares it with one person
at a time. Anyone who can prompt a shared session can run commands on this computer.

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
