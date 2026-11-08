# Third-party assets

- `icon.svg`, `icon-192.png`, `icon-512.png`: Pi Pocket's icon, from [TannerMidd/pi-pocket](https://github.com/TannerMidd/pi-pocket) (`web/`), MIT, Copyright (c) 2026 Tanner Middleton. Changed here: the corners outside the frame are cut away (transparent).
- `fonts/Geist.woff2`, `fonts/GeistMono.woff2`: Geist and Geist Mono by Vercel, SIL Open Font License 1.1 (`fonts/Geist-OFL.txt`).
- `tray-pi-36.png`, `tray-pi-44.png`: the π of Pi Pocket's rail, drawn in Gelasio as a white mask; the app tints it with the theme's brand color.
- `fonts/Gelasio.woff2`: Gelasio (a Georgia-compatible serif) by Eben Sorkin, SIL Open Font License 1.1 (`fonts/Gelasio-OFL.txt`). Kept to draw the tray's π again.

# Third-party libraries

- `uiohook-napi` (Dictate anywhere's keyboard hook): MIT, Copyright (c) 2020 Alexander Drozdov. Its native module includes [libuiohook](https://github.com/kwhat/libuiohook), Copyright (C) 2006-2023 Alexander Barker, under the GNU Lesser General Public License 3.0 or later. It ships unmodified, as its own file in `node_modules/uiohook-napi/prebuilds/`, so it can be replaced with another build; its source is on npm (`uiohook-napi@1.5.5`) and GitHub.
