# Tether: status (first slice, protocol 1)

**Nothing here has run on an FM-1 yet.** Everything below was checked on a computer: Dinghy's host mode (the same
`tether.c` compiled for macOS), node tests, and the real JieLi build with its checks.

## Verified on the host

- **The JieLi build and its checks pass** (JieLi clang via `tools/get_toolchain.sh`, in Docker on macOS): FM-1 and the
  three SMK-37 packages build; no calls into the chip ROM, no register access outside `hal/`, `.ram_text` without calls.
  FM-1: image 55,708 B, RAM .data+.bss 12,608 B of 98,304, pool 145,920 B of 344,064 (the 115,200-byte screen copy is
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

## Not verified (needs a unit)

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

Estimated, not measured: the unit reads one 64-byte USB packet (48 SysEx bytes) per 0.5 ms, so **at most 96,000
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
