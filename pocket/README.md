# FM1.Pocket

FM1.Pocket lets you play the M-VAVE FM-1 synthesizer on your phone or computer. It's free, needs no account, and
keeps working without internet once you've installed it.

**Open it: https://utopick.github.io/fm1-pocket/pocket/**

![The whole FM-1 in FM1.Pocket, running Tether](docs/tether-screen.png)

## What it is

The FM-1 is a small synth, and a community of people write their own programs for it, called firmwares. FM1.Pocket
runs a copy of the FM-1 in your browser, so you can try all of those firmwares without owning one. It is built on the
FM-1 emulator by Joakim Eriksson ([fm1-emu](https://github.com/joakimeriksson/fm1-emu)).

## What you can do

Hold your phone sideways and play it like the real thing: tap the keys and buttons, and drag a knob up or down to
turn it. You can use several fingers at once. One button switches between the whole FM-1, bigger keys, or just the
top part with the knobs and screen.

<img src="docs/piano-keys.png" width="420" alt="The bigger keys, as a piano"> <img src="docs/top-white-blue.png" width="420" alt="Only the top part, in the white and blue colours">

In LOOK you can swap the FM-1's keys for piano keys, pick any of the colours the FM-1 is sold in (or a few of ours),
and choose how the screen looks.

<img src="docs/colours.png" width="420" alt="LOOK: a card for each colour">

FIRMWARE lists the community's firmwares. Once you download one, it works offline, and each one comes with its
author's manual. You can also open a firmware file you already have, or load a bank of DX7 sounds.

<img src="docs/firmware-list.png" width="420" alt="FIRMWARE: the list, with DOWNLOAD, MANUAL and ERASE on each one">

If you have a MIDI keyboard, plug it in and its keys will play the FM-1, while its knobs and pads work the FM-1's
knobs and buttons. In OPTIONS, DEVICE shows a drawing of your keyboard, and MAP helps you set it up step by step.

On the right edge of the FM-1 there are two tabs, PEDALS and LIVE FX, that are not part of the real FM-1: they are an expansion
this app adds. Tap one, or swipe left from the edge, to slide in a screen where the sound of any firmware can go through
PLAY.Pocket's pedals, amps and cabs, or through twenty-four live effects such as octave up and down, choir, lo-fi, tape, echo and stutter. The pedals are drawn as they are in PLAY.Pocket, and a BOARD button opens the pedal board, where you drag the units to change the order of the chain. With nothing switched on
the sound goes out exactly as the FM-1 makes it. They work in the browser and are hidden in the Android app.

MANUAL explains both this app and the FM-1 itself. The button at the top left of the menu switches the whole app
between English and Spanish. You can also install FM1.Pocket as an app from OPTIONS, so it gets its own icon and
opens full screen.

<img src="docs/menu-language.png" width="420" alt="The menu, with the language button at the top left">

If your phone can't keep up and the sound stutters, the app will offer to run the firmware a little slower.

## On Android

FM1.Pocket is also an Android app. It is the same app, but the emulator runs as native code instead of in the browser,
so it is much faster: on a Galaxy S23 it plays even 386DX, the heaviest firmware we know, at the real FM-1's 240 MHz, with no breaks in the
sound and no delay on the keys. It also runs the FM-1's second core on a second core of the phone, which the heaviest
firmwares, such as 386DX, need. MIDI keyboards and a real FM-1 over USB work as they do in Chrome, and with Tether the
app plays through the FM-1's own output.

Download the APK from the [FM1.Pocket for Android release](https://github.com/utopick/fm1-pocket/releases/tag/android-v1.0),
open it on the phone, and allow your browser or file manager to install apps when Android asks. It needs a 64-bit phone
with Android 7.0 or newer. How it is built and how it works are in [`android/README.md`](android/README.md).

## Using a real FM-1

If you own an FM-1, you can connect it with a USB cable and put a firmware on it from OPTIONS, under REAL FM-1. This
needs Chrome or Edge on a computer, or an Android phone; it doesn't work on iPhone or iPad. There are four steps, shown along the top of the screen:

<img src="docs/real-fm1-steps.png" width="420" alt="OPTIONS, REAL FM-1: the four steps, CONNECT, BACKUP, PROTECTOR and INSTALL">

1. **CONNECT** the FM-1.
2. **BACKUP** saves a copy of everything on your FM-1 to a file, without changing anything. Keep that file somewhere safe.
3. **PROTECTOR** installs [m-bootloader](https://github.com/jvitkauskas/m-bootloader) by jvitkauskas, a safety net that
   means a firmware that goes wrong can always be replaced. It asks you before it writes anything.
4. **INSTALL** puts the firmware you choose on the FM-1, with the **INSTALL ON MY FM-1** button on its card. It stays
   locked until you've done steps 2 and 3, and it only works with the FM-1 in the protector's MIDI mode, explained below.

### The protector's MIDI mode

An FM-1 can't safely rewrite the firmware it is running, in the same way you can't rebuild a chair while sitting on
it. The protector you add in step 3 solves this. It is a small program that starts before the firmware, and if you
ask it to, it stays in charge instead of starting the firmware. In that state, called its MIDI mode, the FM-1 shows up
on USB as a MIDI device that only receives new firmware. The protector checks the whole package before it erases
anything, and then writes it while nothing else is running.

So, once the protector is in, every firmware install goes like this:

1. Switch the FM-1 off.
2. Hold **PLAY** while you switch it on. The protector's menu appears on the FM-1's screen.
3. Choose **MIDI mode** on that screen.
4. Press **CONNECT** in the app, then **INSTALL ON MY FM-1** on the firmware you want.

When the install finishes, the FM-1 starts the new firmware on its own. If the app asks for the MIDI mode at any point,
it means the FM-1 is running its normal firmware, and you only need to repeat steps 1 to 4.

The same menu is also your way out of trouble: if a firmware ever doesn't start, holding PLAY at power-on still opens
the protector, because it runs before the firmware. WARNINGS (under MORE) explains what to do from there.

## Tether, our own firmware

Tether is a firmware we wrote for the real FM-1. It's free and open source, and it does two jobs.

![Tether as a MIDI controller: turning knobs, the clock running with a pad lit on each beat, and a chord named on the screen](docs/tether.gif)

The first is to connect your real FM-1 to FM1.Pocket. With the app open, the FM-1's keys, knobs and buttons play the
app, and the app sends its screen and lights back to the FM-1. That means you can try any firmware from the list on
real keys and a real screen without installing it on the unit, and the sound can come out of the FM-1's own output
too.

The second job starts when the app isn't open. Then the FM-1 becomes an ordinary USB MIDI keyboard that you can use
with any music app or program, on a computer or an Android phone. This is what it sends:

| On the FM-1 | What it sends |
|---|---|
| The 27 keys | Notes on channel 1. OCT- and OCT+ move them up or down an octave. |
| The other 12 buttons (FX to REC) | Pads: notes 36 to 47 on channel 10. |
| MASTER | CC 7 on channel 1. |
| SELECT, ALGORITHM, PRESETS and KNOB1 to KNOB4 | CC 74, 75 and 76, then 70 to 73, on channel 1. |

While you play, the FM-1's screen shows the control you just touched and its value, the tempo and bar when a program
sends MIDI clock, the chord you're holding, and a level meter for the sound coming in over USB. A program can also
light the FM-1's keys and pads the way it would light a Launchkey's pads, by sending notes back to it: a high velocity
gives a bright light and a low one a dim light.

The other Pocket apps know the FM-1 when it runs Tether. Their MIDI drawing shows its layout, its knobs and pads get
useful jobs straight away (in TRACK.Pocket the MASTER knob is the master volume, for example), and, if you allow it,
the FM-1's screen shows what each knob and pad does in that app.

<img src="docs/midi-device.png" width="420" alt="The DEVICE drawing of an FM-1 running Tether: 8 knobs, 12 pads and 27 keys">

The [Tether manual](firmware/MANUAL.md), in English and Spanish, explains all of this step by step.

To install Tether, put the FM-1 in the protector's MIDI mode (switch it off, hold PLAY while switching it on, and
choose MIDI mode), then open OPTIONS, go to REAL FM-1, press CONNECT, and press **PLAY WITH THE REAL FM-1**, which now
says INSTALL TETHER ON THIS FM-1. It takes the same safe steps as any other firmware, with a backup and the protector
first. If you want M-VAVE's original firmware back, download
FM-1.fwsc from M-VAVE, open it with OPEN FIRMWARE FILE and install it the same way.

Tether works on Mac and Android, both as a controller and as a sound output. The screen and lights described above
are new in version 0.9. It is built on [Dinghy](https://github.com/zvenson/dinghy) by zvenson, which comes from
[Felucca](https://github.com/hugelton/Felucca) by Leo Kuroshita and [SLOOP](https://github.com/isod89/sloop-fm1) by
isod89, and like them it is GPL-3.0. Its code and the full list of who made what are in [`firmware/`](firmware/README.md),
and the messages it understands are described in [`firmware/PROTOCOL.md`](firmware/PROTOCOL.md).

## Credits and licences

- The emulator: fm1-emu, © Joakim Eriksson, MIT (`LICENSE` at the root, a copy in `vendor/LICENSE-fm1-emu`).
  Everything outside this `pocket/` folder is his project, unchanged.
- This app: MIT, by utopick.
- m-bootloader and M-Flasher: jvitkauskas, MIT (`vendor/mboot/LICENSE-m-bootloader`).
- Tether (`firmware/`): GPL-3.0, built on [Dinghy](https://github.com/zvenson/dinghy).
- Every other firmware belongs to its author, under its own licence. None is in this repository.
  They come from [the FM-1 Firmware Hub](https://thefirmwarehub.com/).
- The FM-1 colours are matched by eye.
- Quixotic7: [MvaveFM1Unbricker](https://github.com/Quixotic7/MvaveFM1Unbricker) and
  [FM1Backups](https://github.com/Quixotic7/FM1Backups), which the app points to for bringing a unit back, and
  [RemoteFM1](https://github.com/Quixotic7/RemoteFM1), another way to play the FM-1's firmwares on a computer or phone,
  whose notes on pacing the emulator's sound we learned from.
- Menu icons: [Open Game Icons](https://open-game-icons.net/), CC BY 3.0, by Lorc and Delapouite.
- Not affiliated with M-VAVE.

## For developers

```sh
python3 pocket/build.py                              # builds pocket/index.html from src/app.html and vendor/
python pocket/tests/smoke.py path/to/firmware.fwsc   # needs selenium and Chrome
python pocket/tests/real.py                          # the REAL FM-1 pane, against a fake unit
python pocket/tests/manual.py                        # the manual, and the app in Spanish
python pocket/tests/fx.py                            # the FX and PEDALS screens and the sound's wiring (no firmware needed)
node --test pocket/tests/real-fm1.test.js pocket/tests/tether.test.js
```

- Edit `src/app.html`, never `index.html`.
- `vendor/midi-device.js` is shared with the other Pocket apps: keep it identical.
- `python3 pocket/update-firmwares.py` refreshes the built-in firmware list (used when offline).
- `firmware/autobuild.sh` builds Tether into `vendor/tether.fwsc` (needs Docker on a Mac). Its protocol is in `firmware/PROTOCOL.md`.

### Two threads in the browser

The page can run the FM-1's second core on its own thread. It needs a threaded build of the emulator, made with `web/build-threads.sh` (a nightly Rust and its `rust-src`), whose output `fm1_web_mt.wasm` goes into `pocket/vendor/`. It is not committed yet, and the page works without it.

GitHub Pages cannot send the headers that shared memory needs, so `sw.js` adds them to the page itself (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`). The service worker only takes over the page after it has installed, so on the first visit the page waits for it, and if no firmware is on yet it reloads itself once (a flag in `sessionStorage` stops it from ever doing so twice), and from then on it runs on two threads. A browser that ignores `credentialless`, such as Safari, is left alone on one thread. Where the page is not isolated, the threaded file is missing, or anything in starting it fails, the one-thread core plays as before. `?threads=0` forces that. In the console, `FM1Threads` says which mode is running and counts the instructions core 1 has run in its Worker (`insns`).

`python pocket/tests/threads.py path/to/firmware.fwsc` checks all of it in Chrome (set `FM1_MT_WASM` to the build's output). Safari has no `credentialless`, so it stays on one thread; Chrome and Edge, on a computer or Android, can use two.
