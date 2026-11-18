# Tether: the FM-1 as the panel of FM1.Pocket

A firmware for the M-VAVE FM-1 that makes the real unit the front panel of the FM-1 emulator in FM1.Pocket: its keys,
buttons, encoders and MASTER go to the page as MIDI, and the page sends back the LEDs and the emulator's screen. So
anyone's FM-1 firmware can be tried in the emulator with real keys, knobs, lights and screen, without flashing it.

- [PROTOCOL.md](PROTOCOL.md): the spec both sides implement (version 1).
- [STATUS.md](STATUS.md): what is tested, what is not (no hardware yet), the throughput, the risks, how to build.
- `firmware/src/tether.c`: the app. The rest is Dinghy's platform, with three small changes (below).

## Licence

**This folder is GPL-3.0-only** (`LICENSE`), as Dinghy, Felucca and SLOOP are. The rest of `pocket/` is MIT and does
not contain or link this code: the page (`pocket/vendor/tether.js`) is written from PROTOCOL.md and talks to the
firmware only over MIDI. Who made what, and the third-party parts: [LICENSING.md](LICENSING.md).

## Credits

Tether is built on **[Dinghy](https://github.com/zvenson/dinghy)** by zvenson (GPL-3.0-only), copied here at commit
`ea1b6bf5973b11f9b4b806d08155602aaa0b505e` (Dinghy 0.5). Dinghy is based on **[Felucca](https://github.com/hugelton/Felucca)**
by Leo Kuroshita (Hügelton Instruments) and on **[SLOOP](https://github.com/isod89/sloop-fm1)** by isod89, both
GPL-3.0; its SMK-37 layer is by M. Geisler (genkigenki), its loader screen after Skiff by illuminus5. Every copyright
and SPDX line of the copied files is kept as it was.

## What changed from Dinghy

- `firmware/src/dinghy.c` (the sine app) is replaced by `firmware/src/tether.c`.
- `platform.c`: the MASTER pot's smoothed reading is kept in `master_k10` (the app sends it).
- `ota.c`: SysEx frames that start `7D` go to the app's `APP_SYSEX` (never in the USB rescue); M-UPGRADE frames go to
  the updater as before, so installers and the Firmware Hub still reach the unit.
- `usb.c`: with `APP_SYSEX`, a SysEx that arrives while the last one waits is held in the USB endpoint (NAK) and
  resumed later, instead of being dropped. Without `APP_SYSEX` (the update loader) nothing changes.
- `tests/host.c` (host mode): `T master V`, `T leds`, `T sysex FILE`; SysEx out is printed.
- Names: the build makes `build/tether.fwsc`, package identity `FM-1_96N` (Dinghy is `99N`), loader screen "TETHER".
- New tests: `tests/tether_test.js` (needs node), `tests/sx_hold_test.c`; both run in `tests/run_tests.sh`, which now
  runs the host tests even without a JieLi build.

Not copied from Dinghy (fetch them from the commit above if you want them): its README and `docs/MAKE-IT-YOURS.md`,
`docs/SMK37.md`, `docs/screen.png`, the logo (`assets/logo.*`, designburg's, not under the GPL) and the release
workflow (`.github/workflows/release.yml`). `docs/API.md` and `docs/RULES.md` are Dinghy's, unchanged: they describe
the platform (where they say `dinghy.c`, read `tether.c`).

## Build and test

```sh
tests/run_host.sh                 # the app on this computer: build/host/tether-*.png, the MIDI it sends
node --test tests/tether_test.js  # Tether's host tests (run from this folder)
./build.sh                        # the FM-1 package, build/tether.fwsc (JieLi toolchain + 3 SDK files, see STATUS.md)
tests/run_tests.sh                # everything (the update-path part needs ./build.sh first)
```
