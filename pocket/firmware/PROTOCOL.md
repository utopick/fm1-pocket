# Tether protocol, version 2

Version 2 adds one byte to HELLO, `CA` (capabilities): bit 0 says the unit is also a USB speaker (section 6). Nothing
else changed: every message still carries `VV` = `01`, so a version 2 page works with a version 1 unit (no `CA`, no
speaker) and a version 1 page with a version 2 unit (it reads `CA` as the first letter of the name).

How an FM-1 running the Tether firmware and a page (FM1.Pocket) talk over USB MIDI. Both sides are written from this
file: the firmware (`firmware/src/tether.c`, GPL-3.0) and the page (`pocket/vendor/tether.js`, MIT). Numbers are
hexadecimal where they start with `0x` or are written as bytes (`F0 7D ...`), decimal otherwise.

The unit is the panel; the page runs the emulator. The unit sends what is touched; the page sends lights and the
emulator's screen.

## 1. The panel: plain MIDI, unit to page

The unit never sends running status. Nothing here depends on the port name.

| Control | Message | Notes |
|---|---|---|
| 27 note keys | `90 nn vv` press, `80 nn 00` release (channel 1) | `nn` = 53 + key (key 0 = F3 = 53 ... key 26 = G5 = 79), always, whatever OCT- / OCT+ do. `vv` = 100 on the FM-1 (its keys have no velocity), the key's velocity 1..127 on the SMK-37 |
| buttons | `9F bb 7F` press, `8F bb 00` release (channel 16) | `bb` = the button's id in the board's order (below) |
| encoders | `BF cc vv` (channel 16) | `cc` = 20 + encoder index (below). Relative, offset binary: `vv` = 64 + detents turned since the last message, clockwise positive (65 = +1, 63 = -1). More than 63 detents go out as several messages |
| MASTER | `BF 1B vv` (channel 16, CC 27) | Absolute, 0..127 (the pot's 10-bit reading / 8). Sent when it moves by more than a few raw steps (the pot jitters), and once after each HELLO |

FM-1 buttons, `bb` 0..13: OCT-, OCT+, FX, SEL, ENV, LFO, EDIT, GLO, HOME, SAVE, ARP, SEQ, PLAY, REC.
FM-1 encoders, index 0..6 (CC 20..26): SELECT, ALGORITHM, KNOB1, KNOB2, KNOB3, KNOB4, PRESETS.

SMK-37 (board 1 in HELLO): buttons 0..17 in the order KNOB BANK, FADER BANK, LEFT, RIGHT, OCT-, OCT+, ARP, LFO, SEL,
ENV, GLO, SAVE, HOME, EDIT, FX, SEQ, PLAY, REC; encoders 0..6 (CC 20..26) = K2..K8 (SELECT, ALGORITHM, PRESETS,
KNOB1..4); K1 is MASTER. Its pads, faders, wheels and outer keys are not sent in version 1.

A tap shorter than one scan still sends the press, then the release. The unit sends the panel only; it ignores
channel messages from the page (the emulator makes the sound; a unit with `CA` bit 0 can play it, section 6).

## 2. SysEx: the frame every Tether message uses

```
F0 7D 46 50 54 VV CC <data ...> SS F7
```

- `7D`: the MIDI manufacturer ID for non-commercial / educational use. `46 50 54` is ASCII "FPT" (FM1.Pocket Tether), so
  another 7D user is not taken for us.
- `VV`: the framing's version, `01` (in version 2 too: the framing did not change).
- `CC`: the command (below).
- `SS`: checksum, `(VV + CC + every data byte) & 0x7F`.
- Every byte between `F0` and `F7` is 7-bit. **At most 640 bytes between `F0` and `F7`** (the unit's SysEx buffer,
  Dinghy's): so at most 633 data bytes.
- A message with another tag, a bad checksum or a wrong length is ignored (a SCREEN message so damaged counts as
  lost, see 5). A message with another `VV` is ignored, except HELLO, which is always answered.

This never collides with the FM-1's update protocol (M-UPGRADE / m-bootloader, used by `real-fm1.js` and the
installers): its frames are `F0 00 ...` (packed `00 59 ...`) and `F0 22 24 35 xx F7`. The unit keeps answering
those too, so the FM-1 can always be updated while Tether runs.

### 8-to-7 packing

Where a field says *packed*, 8-bit bytes are sent as a bit stream, least significant bit first, 7 bits per MIDI byte:
the first MIDI byte holds bits 0..6 of byte 0, the second bit 7 of byte 0 and bits 0..5 of byte 1, and so on; the
last MIDI byte holds what is left, padded with zero bits. `n` bytes take `ceil(8n / 7)` MIDI bytes; `m` MIDI bytes
unpack to `floor(7m / 8)` bytes, so the length is exact. (This is the M-UPGRADE packing.)

## 2b. Linked and standalone (firmware 0.6)

The unit is the page's panel (section 1) while it hears from the page: **any valid message from the page**, and a page sends a
PING (`04`) every second so the link holds even when nothing else is sent (a screen that does not change, the screen switched
off). After `3000 ms` of silence the unit is a **plain MIDI controller**, and back to the panel at the page's next message:

| Control | Standalone (no page) |
|---|---|
| keys | notes on channel 1, `53 + key + 12 x octave`; OCT- / OCT+ shift the octave (-3..+3) and send nothing |
| the other buttons (FM-1: 12, SMK-37: 16) | pads: notes `36 + pad`, channel 10, velocity 100 (FM-1: FX = 36 ... REC = 47) |
| encoders | absolute CC on channel 1, 2 steps a detent, from 64: K1..K4 = 70..73, SELECT 74, ALGORITHM 75, PRESETS 76 (SMK-37: SELECT 74, ALGORITHM 75, PRESETS 76, K1..K4 70..73) |
| MASTER | CC 7, channel 1 |

Held keys and pads are let go in the mapping they were pressed in when the mode changes. The LEDs follow the buttons and keys held.

The unit's screen (0.9), top to bottom: the control last touched, by its name on the unit (K1, SELECT, PLAY, a note) or the
name an app gave it (NAME, `05`), with what it sends and its value as a bar; the transport from the MIDI clock (BPM over 4
quarter notes, PLAY / STOP from FA FB FC, bar.beat in 4/4, F2 song position); the chord held on the keys, or else the chord
or scale the computer lit (a single bright pitch class among dim ones is taken as the root); the octave and channels; a meter
of the sound the computer plays into the unit (USB speaker).

Lights (0.9, FM-1 only), like a Launchkey's pads: a note-on from USB lights a pad (channel 10, its note `36 + pad`) or a key
(channel 1, by note: a lit note follows OCT- / OCT+, a note off the 27 keys shows nothing). Velocity 64..127 bright, 1..63
dim, 0 or a note-off dark. A held key or pad is bright over them. Notes from the TRS jack are not lights. All lights go dark
when a page links, and when it lets go.
A page older than 0.6 sends no PING: the unit then returns to standalone 3 s after its last message.

## 3. Commands

Page to unit:

| `CC` | Name | Data |
|---|---|---|
| `01` | HELLO? | none |
| `02` | LEDS | 6 bytes: lit mask, then optionally 6 bytes: dim mask |
| `03` | SCREEN | `FF SL SH FL` then a packed payload (section 4) |
| `04` | PING | none; no reply |
| `05` | NAME | ASCII `label` or `label|value` (up to 20 and 14 characters): the unit's screen names the control just touched with it (an app's function, e.g. `SWING|54%`). Standalone only, and it does **not** link (0.9) |

Unit to page:

| `CC` | Name | Data |
|---|---|---|
| `41` | HELLO | `PV BD NK NB NE`, then `CA` if `PV` >= 2, then the firmware's name, ASCII (up to 24 bytes), e.g. "TETHER 0.1" |
| `42` | ACK | `FF`: this frame is on the screen |
| `43` | NEED KEY | `FF`: the frame being received when the unit lost track; the next frame must be a keyframe |

### HELLO

The page sends `F0 7D 46 50 54 01 01 02 F7` to every MIDI output it has, and takes the input that answers HELLO
within 500 ms as the unit: the port name plays no part. `PV` = protocol version (2; 1 for the first builds), `BD` = board
(0 FM-1, 1 SMK-37), `NK` = note keys (27), `NB` = buttons (14 or 18), `NE` = encoders (7), `CA` (only when `PV` >= 2) =
capabilities: bit 0 the USB speaker (section 6), the other bits 0. A page reads the name after `CA` when `PV` >= 2. After HELLO the unit waits for a keyframe
(it shows its own screen until then) and sends MASTER once.

### LEDS

The whole state at once. LED id `i` is bit `i % 7` of mask byte `i / 7`. FM-1 ids: 0..13 the buttons (the button
order above), 14..40 the keys (14 + key). SMK-37: 0..17 the buttons; its keys have no LEDs. Bits for ids the board
lacks are ignored. Lit wins over dim. A LEDS with only the lit mask turns every dim LED off. At power-on all are off.

## 4. The screen

The screen is 240 x 240 RGB565, cut into 15 x 15 tiles of 16 x 16 pixels. Tile `t` (0..224) is column `t % 15`, row
`t / 15`; its pixels go row by row, left to right.

A **frame** is one or more SCREEN messages: `FF` = frame id (0..127, +1 per frame, wrapping), `SL SH` = the message's
number in the frame, `SL + 128 * SH` (0, 1, 2, ...), `FL` = flags: bit 0 PRESENT (the frame's last message: show it),
bit 1 KEY (set on message 0 of a keyframe). The payload, packed (2), is a list of tile records; a record never runs
over into the next message, and the payload ends exactly at a record's end.

A record is `TT OP` and the op's bytes. A colour is RGB565 in 2 bytes, **high byte first**.

| `OP` | Name | Bytes after `TT OP` |
|---|---|---|
| 0 | SOLID | colour: the whole tile |
| 1 | RLE | runs `LL colour`, each `LL + 1` pixels (1..256) of one colour, until the runs cover exactly 256 pixels |
| 2 | PALETTE | `K` (2..16), `K` colours, then 256 indices, `B` bits each (`B` = 1 for K = 2, 2 for K <= 4, else 4), packed most significant bit first: 32, 64 or 128 bytes |
| 3 | RAW | 256 colours |

A tile not in any record of a frame stays as it was. A **keyframe** sends all 225 tiles. The page picks the shortest
op for each tile; any choice is valid. The page may send the same tile twice in one frame (the last one counts).
A frame with no changed tile is simply not sent.

The unit draws into its own copy of the screen and puts the changed parts on the panel only at PRESENT: a frame
is shown whole or not at all. Then it sends ACK `FF`.

### Pacing

The page sends a frame, then waits for its ACK (or a NEED KEY) before sending the next; frames the emulator draws
meanwhile are skipped (the next one sent is the difference from the last one sent, so nothing is lost but time).
No ACK within 500 ms: the page sends a keyframe next. Inside a frame the page sends messages back to back. The unit
takes a new SysEx only once it has handled the last one, and USB-MIDI holds the rest back meanwhile (the endpoint
NAKs): over USB nothing is dropped for being fast.

### Lost or damaged messages

The unit keeps the frame id and the next message number it expects, and whether a frame is open (message 0 seen, no
PRESENT yet). It **loses track** when:

- a message has a bad checksum or a bad payload (an unknown op, a tile past 224, runs that do not make 256 pixels, a
  palette index past `K - 1`, a record cut short, more than 550 payload bytes);
- a message is not the one expected (another frame id, or a number that skips);
- message 0 of a new frame comes while the last frame is still open (its PRESENT never came).

Then it sends NEED KEY, keeps the panel as it is (the half-received frame is never shown) and ignores everything
until message 0 of a keyframe. While lost it sends NEED KEY again for every new frame id it ignores, so a lost NEED
KEY is repeated. HELLO also makes the unit wait for a keyframe.

The page answers NEED KEY by making its next frame a keyframe. It needs no periodic keyframe; it may send one.

## 5. Throughput (what to expect)

USB full speed bulk, 64-byte packets of 16 USB-MIDI events, 3 SysEx bytes each: 48 SysEx bytes a packet. The unit
reads its MIDI endpoint at most once per 0.5 ms (Dinghy's USB poll), so **at most ~96,000 SysEx bytes a second**,
and less if the computer sends packets that are not full. The panel's SPI runs at 12 MHz: a 16-pixel band of the
screen (240 x 16, 7,680 bytes) takes ~5 ms, the whole screen ~77 ms. `firmware/STATUS.md` has the figures measured on
the host and what they mean in frames a second.

## 6. The sound: the unit as a USB speaker (`CA` bit 0)

Not MIDI: a second USB function. A Tether build with `TETHER_UAC_OUT` (the default) presents, beside its USB-MIDI and its
USB audio input (the unit's output, for recording), a class-compliant USB Audio 1.0 speaker: interface 3, endpoint `0x04`
OUT, isochronous **adaptive**, 16-bit stereo PCM at **44,100 Hz** only, up to 48 frames (192 bytes) a 1 ms packet. The
host's operating system lists it as an audio output, named after the USB product string ("Felucca": `isRealFM1` in the
page matches it). What the host plays there goes out of the unit's headphone / line output, after its MASTER knob, as
the unit's own sound would; it is also what the unit's USB audio input sends back.

The page offers it when HELLO has `CA` bit 0: it finds the output whose name matches the unit (browsers give output
names only once the page may use a microphone, so it asks for one a moment if the names are empty, else lists the
outputs to pick from) and plays into it with `AudioContext.setSinkId`. When Tether stops it offers the default output back.

Clocks: the host sends by its clock, the unit plays by its I2S clock (not locked to USB, ~0.04 % apart). The unit keeps
a ring of ~8 ms and, once a render (256 frames, 5.8 ms), makes up one frame (the mean of its neighbours) when the ring
runs low or merges two when it runs high: up to 0.39 % of difference, ~18 small corrections a second in practice. No
feedback endpoint (the only isochronous IN, EP4, is the audio input's). The ring empty: silence, then it fills again
before playing. `TETHER_UAC_OUT=0` builds a unit without the speaker (HELLO `CA` = 0), for hosts that would not take it.
