/* SPDX-License-Identifier: GPL-3.0-only */
/* Tether: the FM-1 as the front panel of an FM-1 emulator running in a web page (FM1.Pocket), so a firmware can be
 * tried on real keys, knobs, buttons, LEDs and screen without flashing it. Dinghy's app (dinghy.c, zvenson) replaced;
 * its platform, USB audio, update path and rescue (OCT- at power-on) are kept. PROTOCOL.md is the spec:
 *
 *   panel -> USB MIDI   keys: notes on channel 1 (F3 = 53 .. G5 = 79); buttons: notes 0..13 on channel 16;
 *                       encoders: relative CC 20..26 (64 +- detents), MASTER: CC 27 (0..127), channel 16
 *   SysEx in            F0 7D "FPT" 01 ...: HELLO? (answered with HELLO), LEDS, SCREEN (tiles of the emulator's frame,
 *                       drawn into a copy of the screen, put on the panel at PRESENT; ACK, or NEED KEY when lost)
 *
 *   USB audio out       with TETHER_UAC_OUT (the default) the unit is also a USB speaker (usb.c): the page may play its
 *                       sound into it, and the unit plays it (MASTER, its output). HELLO says so (CA bit 0, protocol 2)
 *
 * The page makes the sound. Integers only, no float, no 64-bit division (docs/RULES.md). */
#include <stdint.h>
static void panel(void);
#define LCD_IDLE panel                          /* while the screen's DMA runs: the panel still goes out */
static void tether_sysex(const uint8_t *p, uint32_t n);
#define APP_SYSEX tether_sysex                  /* platform.c (ota.c): our SysEx, from platform_poll */
#define APP_NAME "TETHER"
#ifndef TETHER_UAC_OUT
#define TETHER_UAC_OUT 1                        /* the USB speaker (usb.c); 0: the USB audio input only, as protocol 1 */
#endif
#include "platform.c"

#if BOARD_SMK37
#define BOARD_ID 1u
#define NBTN 18u
#else
#define BOARD_ID 0u
#define NBTN 14u
#endif
#define NENC 7u                                 /* from ENC_SELECT (FM-1 0..6; SMK-37 1..7, 0 is MASTER) */
#define KEY0 53u                                /* key 0 = F3 */
#define PROTO 1u                                /* VV, every message's framing: unchanged */
#define PV 2u                                   /* HELLO's protocol version: 2 adds CA */
#define CAPS (TETHER_UAC_OUT ? 1u : 0u)         /* CA bit 0: the unit is a USB speaker (usb.c may turn it off: no UAC) */

#if TETHER_UAC_OUT && !defined(DINGHY_HOST)
static void app_audio(int32_t *out, uint32_t n) { uo_play(out, n); }   /* what the page plays into the USB speaker */
#else
static void app_audio(int32_t *out, uint32_t n) { (void)out; (void)n; }   /* silent: the page's sound stays on the computer */
#endif

/* ---- SysEx out: F0 7D 46 50 54 01 cmd data sum F7 */
static void reply(uint32_t cmd, const uint8_t *d, uint32_t n)
{
    uint8_t m[48];
    uint32_t i, sum = PROTO + cmd;
    static const uint8_t HEAD[6] = {0xF0, 0x7D, 0x46, 0x50, 0x54, PROTO};
    for (i = 0; i < 6u; i++) m[i] = HEAD[i];
    m[6] = (uint8_t)cmd;
    for (i = 0; i < n && i < 38u; i++) { m[7u + i] = d[i]; sum += d[i]; }
    m[7u + i] = (uint8_t)(sum & 0x7Fu);
    m[8u + i] = 0xF7;
    ota_wire_send(m, 9u + i);
}

/* ---- the panel -> MIDI (main loop, and while the screen's DMA runs) */
static uint32_t idle_ok, keys_sent, master_v = 255;
static int32_t master_sent = -1000;
static void panel(void)
{
    uint32_t keys, ch, k, b, rel, v;
    int32_t d, m;
    if (!idle_ok) return;                       /* (not in the rescue, not before app_main) */
    keys = fm1_in.notes & 0x7FFFFFFu;
    ch = keys ^ keys_sent;
    keys_sent = keys;
    for (k = 0; k < 27u; k++)
        if (ch >> k & 1u) {
#if BOARD_SMK37
            uint32_t vel = fm1_in.key_vel[SMK_KEY_F3 + k] ? fm1_in.key_vel[SMK_KEY_F3 + k] : 1u;
#else
            uint32_t vel = 100u;                /* the FM-1's keys have no velocity */
#endif
            if (keys >> k & 1u) midi_send(0x90u, KEY0 + k, vel);
            else midi_send(0x80u, KEY0 + k, 0);
        }
    b = fm1_input_edges(&rel);
    for (k = 0; k < NBTN; k++) {
        if (b >> k & 1u) midi_send(0x9Fu, k, 127);
        if (rel >> k & 1u) midi_send(0x8Fu, k, 0);
    }
    for (k = 0; k < NENC; k++)
        for (d = fm1_enc_take(ENC_SELECT + k); d;) {
            int32_t s = d > 63 ? 63 : d < -63 ? -63 : d;
            midi_send(0xBFu, 20u + k, (uint32_t)(64 + s));
            d -= s;
        }
    m = (int32_t)master_k10;
    v = (uint32_t)m >> 3;
    if (v != master_v && (m - master_sent > 6 || master_sent - m > 6 || v == 0u || v == 127u)) {   /* the pot jitters */
        master_sent = m;
        master_v = v;
        midi_send(0xBFu, 27u, v);
    }
}

/* ---- the screen: 15 x 15 tiles of 16 x 16 drawn into scr, the changed 16-row bands sent to the panel at PRESENT */
static uint16_t scr[240u * 240u] __attribute__((section(".pool")));   /* in the panel's byte order */
static uint32_t band_dirty, lost = 1, frame_open, cur_f, next_seq, lost_f = 255u;
static uint8_t dec[560];                        /* one message's payload, unpacked (at most 550 bytes) */

static void lose(uint32_t f)                    /* lost track: wait for a keyframe; NEED KEY once per frame id */
{
    uint8_t b = (uint8_t)f;
    lost = 1;
    frame_open = 0;
    if (f != lost_f) { lost_f = f; reply(0x43u, &b, 1); }
}

static int records(const uint8_t *b, uint32_t n)   /* 1: all good */
{
    uint32_t i = 0, j, k, op, bpp;
    uint16_t pc[16], c, *o;
    lcd_sync();                                 /* the last PRESENT's DMA may still read scr */
#define PUT(j, c) (o[((j) >> 4) * 240u + ((j) & 15u)] = (c))
#define COL(p) ((uint16_t)((p)[0] | (p)[1] << 8))   /* high byte first, as the panel takes it */
    while (i < n) {
        if (n - i < 2u || b[i] >= 225u) return 0;
        o = &scr[b[i] / 15u * 16u * 240u + b[i] % 15u * 16u];
        band_dirty |= 1u << (b[i] / 15u);
        op = b[i + 1u];
        i += 2u;
        if (op == 0u) {                         /* SOLID */
            if (n - i < 2u) return 0;
            c = COL(b + i);
            for (j = 0; j < 256u; j++) PUT(j, c);
            i += 2u;
        } else if (op == 1u) {                  /* RLE */
            for (j = 0; j < 256u;) {
                if (n - i < 3u) return 0;
                k = b[i] + 1u;
                c = COL(b + i + 1u);
                i += 3u;
                if (j + k > 256u) return 0;
                while (k--) { PUT(j, c); j++; }
            }
        } else if (op == 2u) {                  /* PALETTE */
            if (n - i < 1u) return 0;
            k = b[i++];
            bpp = k == 2u ? 1u : k <= 4u ? 2u : 4u;
            if (k < 2u || k > 16u || n - i < 2u * k + 32u * bpp) return 0;
            for (j = 0; j < k; j++) pc[j] = COL(b + i + 2u * j);
            i += 2u * k;
            for (j = 0; j < 256u; j++) {
                uint32_t at = j * bpp, x = (uint32_t)b[i + (at >> 3)] >> (8u - bpp - (at & 7u)) & ((1u << bpp) - 1u);
                if (x >= k) return 0;
                PUT(j, pc[x]);
            }
            i += 32u * bpp;
        } else if (op == 3u) {                  /* RAW */
            if (n - i < 512u) return 0;
            for (j = 0; j < 256u; j++) PUT(j, COL(b + i + 2u * j));
            i += 512u;
        } else
            return 0;
    }
    return 1;
#undef PUT
#undef COL
}

static void present(void)
{
    uint32_t r;
    for (r = 0; r < 15u; r++)                   /* shortcut: whole 240 x 16 bands (one DMA each, contiguous in scr); per-tile windows would send less over SPI */
        if (band_dirty >> r & 1u)
            lcd_blit(0, r * 16u, 240, 16, &scr[r * 16u * 240u]);
    band_dirty = 0;
}

static void hello(void)
{
    static const uint8_t H[] = {PV, BOARD_ID, 27, NBTN, NENC, CAPS, 'T', 'E', 'T', 'H', 'E', 'R', ' '};
    static const char V[] = APP_VER;
    uint8_t d[sizeof H + 16u];
    uint32_t i, n = sizeof H;
    for (i = 0; i < sizeof H; i++) d[i] = H[i];
    for (i = 0; V[i] && i < 16u; i++) d[n++] = (uint8_t)V[i] & 0x7Fu;
    reply(0x41u, d, n);
    lost = 1;                                   /* the page sends a keyframe next */
    frame_open = 0;
    lost_f = 255u;
    master_v = 255u;                            /* and gets MASTER where it is */
    master_sent = -1000;
}

static void tether_sysex(const uint8_t *p, uint32_t n)   /* the bytes between F0 and F7 (7-bit) */
{
    uint32_t i, sum = 0, f, seq, fl, acc = 0, bits = 0, d = 0;
    if (n < 7u || p[0] != 0x7Du || p[1] != 0x46u || p[2] != 0x50u || p[3] != 0x54u)
        return;                                 /* not "FPT" */
    for (i = 4; i + 1u < n; i++) sum += p[i];
    sum = (sum & 0x7Fu) == p[n - 1u];
    if (p[5] == 0x01u) { if (sum) hello(); return; }   /* HELLO? whatever its version */
    if (p[4] != PROTO) return;
    if (p[5] == 0x02u) {                        /* LEDS: lit mask [, dim mask], 7 ids a byte */
        if (sum && (n == 13u || n == 19u))
            for (i = 0; i < 42u; i++) {
                uint32_t on = p[6u + i / 7u] >> (i % 7u) & 1u, dim = n == 19u ? p[12u + i / 7u] >> (i % 7u) & 1u : 0u;
                fm1_led_key(i, (int)on);
                fm1_led_key_glow(i, (int)(dim && !on));
            }
        return;
    }
    if (p[5] != 0x03u || n < 11u) return;       /* SCREEN: FF SL SH FL, packed payload */
    f = p[6];
    seq = p[7] | (uint32_t)p[8] << 7;
    fl = p[9];
    if (!sum) { lose(f); return; }
    if (seq == 0u) {
        if (!(fl & 2u) && (lost || frame_open)) { lose(f); return; }   /* a delta needs the frame before it, whole */
        lost = 0;
        frame_open = 1;
        cur_f = f;
        next_seq = 0;
        lost_f = 255u;
    } else if (lost) {
        lose(f);
        return;
    }
    if (f != cur_f || seq != next_seq) { lose(f); return; }
    next_seq++;
    for (i = 10; i + 1u < n; i++) {             /* 7 -> 8 bits, least significant first */
        acc |= (uint32_t)p[i] << bits;
        bits += 7u;
        if (bits >= 8u) {
            if (d == sizeof dec) { lose(f); return; }
            dec[d++] = (uint8_t)acc;
            acc >>= 8;
            bits -= 8u;
        }
    }
    if (!records(dec, d)) { lose(f); return; }
    if (fl & 1u) {                              /* PRESENT */
        uint8_t b = (uint8_t)f;
        present();
        frame_open = 0;
        reply(0x42u, &b, 1);
    }
}

static void app_main(void)
{
    lcd_fill(0, 0, 240, 240, C_BLACK);
    draw_text_box(0, 84, 240, &FONT_L, APP_NAME, RGB(180, 140, 255), 1);
    draw_text_box(0, 128, 240, &FONT_S, "waiting for FM1.Pocket", RGB(210, 210, 210), 1);
    draw_text_box(0, 212, 240, &FONT_S, "v" APP_VER, RGB(90, 90, 90), 1);
    idle_ok = 1;
    for (;;) {
        platform_poll();                        /* (our SysEx is handled in there) */
        panel();
    }
}
