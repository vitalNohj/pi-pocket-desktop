# Dictation

Talk to Pi instead of typing. Speech is recognized on your computer, and the audio never leaves it.

## Set up

Nothing for dictation is included in the app download. Open **Desktop Settings → Dictation**, choose a speech model, and choose **Download**. The speech engine, [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (about 12 MB), downloads with the first model. The app checks every file against its SHA-256 before it uses it.

**Remove** deletes a model. When you remove the last model, the app deletes the engine too.

| Model | Languages | Download |
|---|---|---|
| Parakeet TDT 0.6B v2 (recommended) | English | 661 MB |
| Parakeet TDT 0.6B v3 (recommended) | 25 European languages | 670 MB |
| Whisper large-v3 turbo, large-v3, small, base, tiny | 99 languages | 1.0 GB to 104 MB |
| Distil-Whisper large-v3.5 | English | 984 MB |
| Moonshine base | English | 287 MB |
| SenseVoice small | Chinese, Cantonese, Japanese, Korean | 237 MB |

## Use it in Pi Pocket

Use Pi Pocket's mic button, Alt+V, or the dictation key. Your words go into the message box of the session in front (or into PiP, when PiP is open). The dictation key also types into the text field that has the cursor, such as a search box or an answer field.

- **Words as you speak.** Words show while you talk and are corrected when you pause. Turn this off to use less CPU.
- **Memory.** A model loads at the first dictation and unloads after 10 idle minutes.
- **Microphone access.** The microphone works only when Pi Pocket's address is `127.0.0.1`, `localhost`, or `https`. Browsers, and so the app, block the microphone on plain HTTP pages at other addresses.

## Dictation key

One key starts dictation. The default is Right Option on macOS and Right Ctrl on Windows and Linux.

- **Hold or tap.** Hold the key while you talk, then release it. Or tap it once to start and again to stop. Both work by default. A press shorter than 0.3 seconds counts as a tap.
- **Change the key.** In **Desktop Settings → Dictation**, click the key's button, then press a key or a combination, for example Ctrl+Shift+D, Ctrl + Right Alt, or F13. Escape cancels, and **None** turns the key off.
- **Rules.** A key that types (a letter, a digit, Space) needs Ctrl, Alt, or ⌘/Windows/Super with it. A modifier key alone counts only when you press it alone. With another key, it works as usual (for example, Right Ctrl + C, or Right Alt + E for €).

## Dictate anywhere

Turn on **Dictate anywhere** in **Desktop Settings → Dictation** to use the dictation key in every app.

1. Press the dictation key in any app.
2. A small pill shows that the app listens, with your words so far. The tray icon turns red.
3. Press the key again (or release it). The app pastes your words where your cursor is, then restores your clipboard.

- **Esc** cancels a recording.
- **Words go** sets where the words go: where the cursor is, or only to the clipboard.
- The tray menu's **Dictate** also starts and stops a recording.
- When Pi Pocket is in front, the key uses the session's mic as usual. A recording always finishes in the app where it started.

### Permissions and limits

- **macOS** asks for Accessibility (to detect the key and paste) and for the microphone. macOS gives Accessibility to one version of the app, so the app asks again after an update. If Desktop Settings says that macOS does not let the app see keys, but System Settings shows it as allowed, choose **Ask again** in **Desktop Settings → Dictation**.
- **Windows** keeps apps that run as administrator separate. To dictate into those apps, run Pi Pocket as administrator too. On many keyboards, Right Alt is AltGr: if you type with it, choose another key.
- **Linux** supports Dictate anywhere on X11. Wayland does not let apps detect other apps' keys or type into them. On Wayland, use the tray's **Dictate**, and paste the words from the clipboard.

## Recent dictations

**Recent dictations**, at the bottom of **Desktop Settings → Dictation**, keeps your last 5 dictations, each with a **Copy** button. Use it when a paste went to the wrong place, the message box lost your words, or a dictation stopped early. Each entry shows when it ended, where it came from, and whether it was cancelled or stopped by an error.

The tray menu's **Copy last dictation** copies the newest one from any app. Recent dictations are kept only in memory: quitting the app clears them, and **Clear** clears them now.

## Custom words

**Custom words** (one per line) are names and terms that the model should spell your way, for example `Pi Pocket` or `Kubernetes`. Write them with the capitals you want. Only the Parakeet models use custom words.

## Credits

The key is detected with [uiohook-napi](https://github.com/SnosMe/uiohook-napi) (MIT), built on [libuiohook](https://github.com/kwhat/libuiohook) (LGPL-3.0, linked as a separate library).
