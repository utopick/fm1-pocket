# FM1.Pocket

An M-VAVE FM-1 for the phone: a simpler front for [fm1-emu](https://github.com/joakimeriksson/fm1-emu) by
**Joakim Eriksson** (MIT), made to be installed as an app and played offline.

**Open it: https://utopick.github.io/fm1-pocket/pocket/**

| | |
|---|---|
| ![The whole FM-1, running GR!MM](docs/whole.png) | ![The upper part, in the white and blue skin](docs/upper.png) |
| ![Only the keys, as a piano](docs/keys.png) | ![The LOOK tab: a card for each skin](docs/look.png) |

The firmware on the screen in these pictures is GR!MM, by its own author.

This repository is a fork of fm1-emu. Everything outside this `pocket/` folder is Joakim's project, untouched.
The emulated FM-1 inside the page (CPU, flash, screen, keys, knobs, audio) is his core and his audio worklet,
unchanged. What this folder adds is one page around them: a phone-first front, a mapper for MIDI controllers and
installation as an app.

## What it does

- **Sideways on a phone, always.** One button goes round three views: the whole FM-1, only the keys,
  only the upper part (knobs, screen, buttons), each full screen. A phone held upright shows the same view turned.
  A narrow window on a computer gets an upright layout (screen, knobs, buttons, keys in two rows).
- **Keys** as the FM-1's own or as a piano. **Skins**: the nine colours the FM-1 is sold in (black follows a photo of the
  real one), then four of ours. **Screen filter**: LCD, CRT or clean.
- **Firmwares** from fm1-emu's list (the page reads `firmwares.json` from Joakim's site when online, so new
  ones appear by themselves). Each package is downloaded once from its author and kept on the device, marked ●,
  and then runs with no connection. OPEN FILE takes your own `.fwsc`. LOAD BANK puts a DX7 bank of 32 voices
  (`.syx`) into the running firmware.
- **Saves.** What a firmware writes to its flash is kept per exact firmware version.
- **Slow devices.** When the device cannot keep up and the sound breaks up, the app offers to restart the firmware
  at a lower clock (80 or 60 MHz).
- **MIDI**: keys play the FM-1 through its MIDI IN. Knobs and pads work the FM-1's own knobs and buttons, with a
  starting assignment for known controllers (Akai MPK mini, Launchkey) and a drawing of the controller to assign
  and learn each control (the Pocket apps' device panel).
- A manual in English and Spanish in its own tab (this app, and how the FM-1 works with its stock firmware, after M-VAVE's user manual), the licences, computer keys, multi-touch.
- **Installable (PWA)**: its own window, full screen, and it works offline. The menu wears the chosen skin.

## A real FM-1 on USB (OPTIONS, REAL FM-1) — written, not yet tried on a unit

Chrome or Edge (computer, or Android with a cable; no iOS), Web MIDI with SysEx. The protocol is in `vendor/real-fm1.js`, written from the
specification of [m-bootloader](https://github.com/jvitkauskas/m-bootloader) (MIT, by jvitkauskas), whose v2.4 packages
(`vendor/mboot/`, checked by SHA-256 before use, licence in `LICENSE-m-bootloader`) are what the page sends.

1. **CONNECT** finds the unit's ports (`FM-1 MIDI 1` while its firmware runs, `FM-1 Update` in m-bootloader's MIDI mode).
2. **SYNC**: what you play goes to the real unit too; its notes, bend, clock and start/stop come to the emulator. (The emulator has no MIDI out.)
3. **BACKUP** (step 1): sends m-bootloader's RAM helper through the firmware's own update route, then reads the whole flash (512-byte reads, each checked, then the chip's CRC-32) and saves a `.bin`. Only reads are ever sent to the helper. The copy is also wrapped as a one-file package, kept as the first entry of the firmware list (MY FM-1) and started in the emulator at once: if its screen draws, the copy is a good one. DELETE of the downloads leaves it.
4. **PROTECTOR** (step 2, only after a backup): sends the bootloader package. It writes the boot area.
5. **INSTALL FIRMWARE** (step 3, only in the protector's MIDI mode): serves the chosen firmware's package; the unit checks it before it erases. **No protector, no custom firmware**: every BACKUP is checked for m-bootloader's identity in the boot area (`AC79BLID` at payload offset 0x40 of the container at 0xA0), and step 3 stays locked until a backup of the same unit shows it. PROTECTOR is not sent on the newer flash chip (JEDEC B36014): use M-Flasher there, then BACKUP again. A flash map (the directory records and which 4 KiB sectors hold data) is drawn after each backup and written in the INSPECT · COPY report. The protector check has only been tried on synthetic flashes.

Writes ask for a slide to confirm. Restoring a backup is not done here (use M-Flasher). Tests: `node --test pocket/tests/real-fm1.test.js` (a simulated unit and the real packages) and `python pocket/tests/real.py` (the page against a fake unit).

## Roadmap

- MIDI sync with the real unit's clock into the emulated firmware's tempo (the emulator has no clock input yet) and the emulator's own notes out.
- Restore a backup from the page.

## Build and test

```sh
python3 pocket/build.py                                   # writes pocket/index.html from pocket/src/app.html and pocket/vendor/
python pocket/tests/smoke.py path/to/firmware.fwsc        # needs selenium and Chrome
```

Edit `pocket/src/app.html`. `pocket/vendor/midi-device.js` is the MIDI device panel
shared with the Pocket apps (copied from TUNE.Pocket's `<script id="midi-device">`, keep it identical).
`pocket/vendor/` also holds fm1-emu's built core (`fm1_web.wasm`), `worklet.js` and
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
