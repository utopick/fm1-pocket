# Tether: status (protocol 2: the panel, and the unit as a USB speaker)

**The panel (keys, buttons, knobs, LEDs, the screen) works on the owner's FM-1. The USB speaker (protocol 2, section 6
of PROTOCOL.md) has not run on a unit yet**: it was checked on a computer only (host tests below, the JieLi build).
Everything else below was first checked the same way: Dinghy's host mode (the same `tether.c` compiled for macOS), node
tests, and the real JieLi build with its checks.

## Verified on the host

- **The JieLi build and its checks pass** (JieLi clang via `tools/get_toolchain.sh`, in Docker on macOS): FM-1 and the
  three SMK-37 packages build; no calls into the chip ROM, no register access outside `hal/`, `.ram_text` without calls.
  FM-1 (with the speaker): image 56,464 B, RAM .data+.bss 16,976 B of 98,304 (the speaker's ring is 4 KB), pool 145,920 B of 344,064 (the 115,200-byte screen copy is
  in the pool). Package identity `FM-1_960`.
- **`tests/run_tests.sh`: ALL TESTS PASSED** (Dinghy's suite with the Tether build: host app, MIDI and SMK-37 scripts,
  flash map, update entry, update loader and its screen, SMK packages, installer; plus Tether's two tests).
- `tests/tether_test.js` (host mode, frames encoded by the page's own `vendor/tether.js`):
  - the panel gives exact bytes: keys `90/80 53..79` (velocity 100), a button tap and a hold `9F/8F`, encoders
    `BF 20+i 64+d` (a 70-detent turn split into -63, -7), MASTER `BF 27` with its jitter not sent, sent again after HELLO;
  - HELLO? is answered with the exact HELLO bytes; LEDS sets lit and dim LEDs by id;
  - the screen equals the source frame, pixel for pixel, for a real UI (Felucca's screen), its next animation frame
    as a delta, text, a few tiles on black, full noise; a frame with one dropped message is never shown, NEED KEY goes
    out at the next message, and the keyframe after it mends the screen.
- `tests/sx_hold_test.c` (usb.c and ota.c on the host): two SysEx in one USB packet: the second is held (the endpoint
  NAKs) until the first is taken, then resumes without losing or repeating a note; `7D` frames reach the app, not in the
  rescue; an M-UPGRADE handshake still reaches the updater and is answered.
- `pocket/tests/tether.test.js` (the page side against a decoder written from PROTOCOL.md): round trips, loss, a damaged
  byte, a lost PRESENT, HELLO / LEDS / MIDI parsing, ImageData input.

- `tests/uac_out_test.c` (usb.c's speaker on the host): the configuration descriptor chains to its length, the
  interface count and the AC header's collection and length are right, the speaker is IT 3 (USB streaming) -> OT 4
  (speaker) on interface 3 with EP4 OUT isochronous adaptive (192 B), the audio input is unchanged; the ring plays the
  host's frames bit for bit after priming, an underrun gives silence and primes again, a packet with no room is dropped
  whole; two clocks for 2 simulated minutes (the FM-1's ~44,117.6 Hz, 0.04 % slow, locked, +-0.3 %), with the host's
  44 / 45 pattern and its packets taken at 0.5 ms polls with jitter: no underrun or overrun once playing, the output is the
  host's sequence with only the corrections, and their number is what the clocks need (FM-1: 2,086 frames made up in 120 s
  for ~2,112 needed, none merged; the ring at a render's start 302..369 frames). Built again with `TETHER_UAC_OUT=0`: the
  descriptors are Dinghy's (178 bytes, 3 interfaces, bcdDevice 3.20).
- `pocket/tests/real.py`: a fake protocol 2 unit with the speaker: the page asks, finds the output named Felucca (after
  asking for the microphone, as the names were empty), skips the "default" alias, calls `setSinkId` with it, and offers
  the default output back when Tether stops; with no FM-1-like name it lists the outputs; without `setSinkId` it says so;
  a failed `setSinkId` keeps the output it had. A protocol 1 unit is not asked about the sound.

## Not verified (needs a unit)

The USB speaker, all of it: that the JieLi USB block takes isochronous OUT on EP4 with the registers used (RXMAXP 0xFF,
RXCSR2 bit 6 = ISO, the count from RXCOUNT, the DMA address in `EP4_RADR`; JieLi's own SDKs put their speaker's ISO OUT on
the same endpoint number as their microphone's ISO IN, as this does, but their driver is a binary library); that one
OUT buffer read at the 2 kHz poll never loses a packet (a render that delays the poll > 1 ms would; the poll also runs
nested in the render, as the audio input's does); the real drift and the band's margins (the ring's low point is ~1.5 ms
above an underrun); whether the corrections are audible on pure tones; whether macOS, Windows, Linux, Android and
ChromeOS enumerate the new device (bcdDevice 3.60) and list the speaker, and what they name it (the page looks for
"Felucca" or "FM-1"; else it lists the outputs); whether hosts send `SET_CUR` sampling frequency to `0x04` (taken and
ignored: 44.1 kHz only) and hosts that only play 48 kHz (some Android phones: they would not use this output). The
page side: that Chrome's `setSinkId` to the unit and back keeps working across the tab's suspend / resume, and what
Chrome does when the unit is unplugged while it plays (the page then offers the default output back). The MASTER knob
acts twice on this sound: the emulator gets it as MIDI (its own volume) and the unit's output scales by it too.
If some host hides the whole device because of the speaker, build with `DINGHY_DEFS=-DTETHER_UAC_OUT=0`.

The panel, first slice (the owner has since seen it work on a unit; not measured):
USB itself: that real hosts (macOS, Windows, Linux, Android; Chrome's Web MIDI with SysEx) retry the NAKed packets as
USB says and nothing is lost; the real SysEx rate; the screen's DMA timing and tearing (there is no sync to the
panel's refresh); the LEDs' look (lit and dim); the MASTER jitter threshold (6 of 1023); fast encoder turns; the
SMK-37 build at all; that OCT- at power-on still reaches the rescue (its code is unchanged except the USB hold, which
the host test covers in rescue mode).

## Throughput

Measured (encoded sizes, `node --test pocket/tests/tether.test.js`; encoding takes 1-6 ms a frame in node on a Mac):

| Frame | Tiles | SysEx bytes | Messages |
|---|---|---|---|
| keyframe, a real UI (Felucca, antialiased text, a scope) | 225 | 14,534 | 26 |
| delta: its scope moves 3 px | 64 | 3,042 | 5 |
| keyframe, text in 4 colours | 225 | 15,111 | 25 |
| delta: a few tiles change on black | 7 | 207 | 1 |
| keyframe, black | 225 | 1,056 | 2 |
| keyframe, full noise (worst case) | 225 | 135,225 | 225 |

Since 0.8 the panel runs at 20 MHz (`LCD_BAUD 2u` in tether.c; ~46 ms for 15 bands), clean on the owner's FM-1. Since 0.7 the unit takes a packet on every 10 kHz tick while a burst arrives (up to ~480,000 SysEx bytes a second), so
frames that redraw most of the screen (the 386DX firmware: ~15 KB each) are bound by the panel's SPI (~77 ms for 15 bands), not
by USB. The figures below are 0.6's. Estimated, not measured: the unit read one 64-byte USB packet (48 SysEx bytes) per 0.5 ms, so **at most 96,000
SysEx bytes a second**; the low figures assume half (48,000) because computers do not always send full packets. The panel's SPI
at 12 MHz puts a 240 x 16 band on the screen in ~5.1 ms. A frame takes the longer of the two:

- typical UI deltas (a few KB, under ~9 bands): **~16 to 22 fps** (the scope delta: USB 32-63 ms, SPI 46 ms);
- small changes (a value, a cursor): **60+ fps**, limited by the page (it sends ~30 frames a second);
- a keyframe of a detailed UI: **150 to 300 ms** (after HELLO and after a loss); a black one: ~80 ms;
- full noise: ~1.4 to 2.8 s a frame (worst case, not a use case).

So 20 fps holds for mostly flat screens that change in places, not for full-screen animation. If the unit shows
it is SPI-bound, two cheap steps: send only the changed tiles of a band instead of the whole band (`present()`
in tether.c, marked `shortcut:`), and a faster SPI clock (`LCD_BAUD`, Dinghy runs 12 MHz; the ST7789 takes more, untested).

## Known risks

- While the unit draws, the USB endpoint is held: MIDI from the page waits too (the page sends none but SysEx).
- During a firmware update session, Tether frames would still be drawn: the page must stop streaming before it
  installs anything.
- `FM-1_96N` was picked as unused by the list in Dinghy's docs (900, 91N, 93N, 97N, 98N, 99N); check the Firmware Hub
  before a release.
- The page's frame pacing (wait for ACK, keyframe after 500 ms of silence) is in PROTOCOL.md and in the reference
  test, not yet in the page.
- Keyframes of antialiased UIs are big (14.5 KB); a palette-plus-runs op would help if keyframes turn out frequent.

## To build for a real FM-1 and try it

`firmware/autobuild.sh` does all of this and puts the package in the page (see README.md). By hand:

1. Linux x86-64, or macOS / Windows with Docker running. Python 3 with Pillow (`pip3 install Pillow mido python-rtmidi`).
2. `tools/get_toolchain.sh` (JieLi's clang, to `~/.jieli/toolchain`; another folder: give it as an argument and set
   `JIELI_TOOLCHAIN`).
3. The three JieLi AC79 SDK files (Apache-2.0), either the whole SDK
   `git clone --depth 1 --branch AC79NN_SDK_V1.2.1_2023-12-13 https://gitee.com/Jieli-Tech/fw-AC79_AIoT_SDK.git ~/fw-AC79_AIoT_SDK`
   or only `cpu/wl82/tools/uboot.boot`, `cfg_tool.bin`, `cfg/eq_cfg_hw.bin` from that tag in the same layout under a
   folder you point `AC79_SDK` at (`tools/build.py` checks their SHA-256).
4. `./build.sh`, then `tests/run_tests.sh` -> `build/tether.fwsc`.
5. Install: `python3 tools/fm1_install.py build/tether.fwsc` (asks before writing), or the Firmware Hub's installer.
   Back to another firmware: the Firmware Hub, or the USB rescue (hold OCT- while switching on). Installing firmware is
   at your own risk.
6. On the unit: the screen says "TETHER waiting for FM1.Pocket". With any MIDI monitor: keys, buttons, encoders and
   MASTER give the messages of PROTOCOL.md 1. Send `F0 7D 46 50 54 01 01 02 F7`: the HELLO answer comes back. Then,
   once the page is wired, stream frames and watch the rate and the ACKs.
7. The speaker: the computer should list a new audio output named Felucca. Play anything into it (or let the page do
   it): it comes out of the unit, at MASTER. Listen for clicks on a sine (the corrections), and leave it playing for
   minutes (the drift).
