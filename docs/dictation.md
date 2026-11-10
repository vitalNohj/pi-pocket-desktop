# Dictation

Pi Pocket's mic button (and Alt+V) works in the app, and your speech is recognised on your computer: the audio never
leaves it. Everything is in **Desktop Settings → Dictation**.

## Speech models

Nothing comes with the app. Pick a speech model and press **Download**; the speech engine
([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), about 12 MB) comes with the first model. **Remove** deletes a
model, and removing the last one deletes the engine too. Every file is checked against its SHA-256 before it is used.
**Model folder → Show folder** opens where they are kept.

| Model                                               | Languages                            | Download         |
| --------------------------------------------------- | ------------------------------------ | ---------------- |
| Parakeet TDT 0.6B v2 (recommended)                  | English                              | 661 MB           |
| Parakeet TDT 0.6B v3 (recommended)                  | 25 European languages                | 670 MB           |
| Whisper large-v3 turbo, large-v3, small, base, tiny | 99 languages                         | 1.0 GB to 104 MB |
| Distil-Whisper large-v3.5                           | English                              | 984 MB           |
| Moonshine base                                      | English                              | 287 MB           |
| SenseVoice small                                    | Chinese, Cantonese, Japanese, Korean | 237 MB           |

Words show while you speak and are corrected when you pause (**Words as you speak**; turn it off to save CPU). A model
loads at the first dictation and leaves memory after 10 idle minutes. The mic needs Pi Pocket on
`127.0.0.1`/`localhost` or `https`: browsers, and so the app, keep the microphone from plain-http pages on other
addresses.

**Custom words** (one per line) are names and terms the model should spell your way, such as `Pi Pocket` or
`Kubernetes`. Write them with the capitals you want. Only the Parakeet models take them (they switch to beam search,
which costs little); Whisper, Moonshine, and SenseVoice in sherpa-onnx have no prompt to pass words to.

## Recent dictations

**Recent dictations**, at the bottom of the Dictation section, keeps the words of your last 5 dictations, each with a
**Copy** button: for when a paste went nowhere, the message box lost them, or the speech model stopped halfway. Each
shows when it ended, where it came from (Pi Pocket or Dictate anywhere), and whether it was dropped with Esc or stopped
by an error. The tray menu's **Copy last dictation** copies the newest from any app. They are kept only in memory:
quitting the app forgets them, and **Clear** forgets them now.

## Dictation key

One key turns dictation on: Right Option on macOS and Right Ctrl elsewhere by default. To pick another, click the key's
button, press a key or a combination (Ctrl+Shift+D, Ctrl + Right Alt, F13), and let go: it is saved. Escape cancels,
and **None** turns the key off. A key that types (a letter, a digit, Space) needs Ctrl, Alt, or ⌘/Windows/Super with
it. A modifier key on its own counts only when pressed alone: with another key (Right Ctrl + C, Right Alt + E for €) it
does what it always does.

- **In Pi Pocket's window** it turns on the mic of the session in front (PiP's while PiP is open), so the button shows
  it listening and the words go into the message box. It needs no permission there. Pi Pocket's own Alt+V still works.
- **Hold or tap:** hold the key while you talk and let go, or tap it once to start and again to stop. Both work by
  default; a press under 0.3 seconds is a tap. **How the key works** can limit it to one of them.

## Dictate anywhere

The dictation key in every app, not only Pi Pocket: turn on **Dictate anywhere**, then press the key wherever you type.
A small pill shows that it listens, with the words so far (its dot grows with your voice). It sits at the bottom of the
screen, or at the top when your pointer is in the lower half, so it does not cover where you type. The tray's π turns
red, and the words are pasted where your cursor is when you stop. The clipboard gets back what it held a moment later.
**Sound** plays a short tone when recording starts and stops.

- **Where it goes:** with Pi Pocket's window in front, the key still turns on the session's mic; in any other app, it
  pastes. In Pi Pocket with no message box showing (a sheet open), it pastes too. A recording ends where it started,
  even if you switch apps meanwhile. In Desktop Settings it dictates anywhere too, so the words go into the box you are
  typing in.
- **Esc** drops a recording. **Words go** where the cursor is, or only to the clipboard. The tray menu's **Dictate**
  starts and stops it too.
- **macOS** asks for Accessibility (to see the key and press ⌘V) and the microphone. macOS gives Accessibility to one
  version of the app: when an update installs, Pi Pocket removes its own entry first
  (`tccutil reset Accessibility io.github.vitalnohj.pipocketgui`), so the new version is asked again instead of being
  refused silently. Each time the app starts without Accessibility while Dictate anywhere is on, it removes its old
  entry the same way and asks, once the window is open (so the question is not hidden behind it). If Dictate anywhere
  still says macOS does not let it see keys while System Settings shows it on, use **Ask again**.
- **Windows** keeps apps run as administrator apart: to dictate into those, run Pi Pocket as administrator too. On many
  keyboards Right Alt is AltGr; pick another key if you type with it.
- **Linux** works on X11. Wayland lets no app hear other apps' keys or type into them: there use the tray's
  **Dictate**, and the words are copied for you to paste.

The key is watched with [uiohook-napi](https://github.com/SnosMe/uiohook-napi) (MIT), built on
[libuiohook](https://github.com/kwhat/libuiohook) (LGPL-3.0, linked as a separate library).
