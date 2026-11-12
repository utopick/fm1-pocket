# FM1.Pocket

An M-VAVE FM-1 for the phone: a simpler front for [fm1-emu](https://github.com/joakimeriksson/fm1-emu) by
**Joakim Eriksson** (MIT), made to be installed as an app and played offline.

This repository is a fork of fm1-emu. Everything outside this `pocket/` folder is Joakim's project, untouched.
The emulated FM-1 inside the page (CPU, flash, screen, keys, knobs, audio) is his core and his audio worklet,
unchanged. What this folder adds is one page around them.

## What it does

- **Sideways on a phone, always.** **Complete**: the whole FM-1 full screen. **Switchable**: the upper part or
  the keys, full screen each, with one button to switch. A phone held upright shows the same view turned.
  A narrow window on a computer gets an upright layout (screen, knobs, buttons, keys in two rows).
- **Keys** as the FM-1's own or as a piano. **Skins**: five FM-1 colours (black follows a photo of the real one),
  then four of ours. **Screen filter**: LCD, CRT or clean.
- **Firmwares** from fm1-emu's list (the page reads `firmwares.json` from Joakim's site when online, so new
  ones appear by themselves). Each package is downloaded once from its author and kept on the device, marked ●,
  and then runs with no connection. OPEN FILE takes your own `.fwsc`.
- **Saves.** What a firmware writes to its flash is kept per exact firmware version.
- **MIDI** in, computer keys, multi-touch. Installable (PWA).

## Build and test

```sh
python3 pocket/build.py                                   # writes pocket/index.html from pocket/src/app.html and pocket/vendor/
python pocket/tests/smoke.py path/to/firmware.fwsc        # needs selenium and Chrome
```

Edit `pocket/src/app.html`. `pocket/vendor/` holds fm1-emu's built core (`fm1_web.wasm`), `worklet.js` and
`firmwares.json`, copied from its published page at commit 3e3fb27. To update them, build `web/` as the main
README says and copy the three files.

## Credits and licences

- fm1-emu: © Joakim Eriksson, MIT (`LICENSE` at the root, a copy in `pocket/vendor/LICENSE-fm1-emu`).
- The page in this folder: MIT, by utopick.
- Each firmware belongs to its author and keeps its own licence. None is in this repository. They come from
  [the FM-1 Firmware Hub](https://thefirmwarehub.com/).
- The skin colours named after the FM-1 are approximations by eye. Black follows a product photo, grey follows
  fm1-emu's drawing.
- Not affiliated with M-VAVE.
