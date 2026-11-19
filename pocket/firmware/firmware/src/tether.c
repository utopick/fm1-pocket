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
#define LCD_BAUD 2u                             /* the panel at 20 MHz, not Dinghy's 12 (60 MHz / (BAUD + 1)): a full repaint ~46 ms, not 77. Clean on the owner's FM-1 (0.8) */
static void tether_sysex(const uint8_t *p, uint32_t n);
#define APP_SYSEX tether_sysex                  /* platform.c (ota.c): our SysEx, from platform_poll */
#define APP_NAME "TETHER"
#ifndef TETHER_UAC_OUT
#define TETHER_UAC_OUT 1                        /* the USB speaker (usb.c); 0: the USB audio input only, as protocol 1 */
#endif
#include "platform.c"
#include "ctl_info.h"

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
static volatile uint32_t pk_l, pk_r;            /* the loudest sample since the screen last looked: the meter */
static void app_audio(int32_t *out, uint32_t n)  /* what the page plays into the USB speaker */
{
    uint32_t i, l = pk_l, r = pk_r, a;
    uo_play(out, n);
    for (i = 0; i < n; i++) {
        a = (uint32_t)(out[2u * i] < 0 ? -out[2u * i] : out[2u * i]); if (a > l) l = a;
        a = (uint32_t)(out[2u * i + 1u] < 0 ? -out[2u * i + 1u] : out[2u * i + 1u]); if (a > r) r = a;
    }
    pk_l = l;
    pk_r = r;
}
#else
static volatile uint32_t pk_l, pk_r;
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

/* ---- the panel -> MIDI (main loop, and while the screen's DMA runs)
 * Two modes. LINKED: a page (FM1.Pocket) spoke within LINK_MS (any valid SysEx, PING each second): the panel goes out as
 * PROTOCOL.md section 1 says. Otherwise the unit is a plain MIDI CONTROLLER: keys on channel 1 shifted by OCT- / OCT+,
 * the other buttons as pads (notes 36.., channel 10), knobs as absolute CCs (70..76, channel 1, 2 steps a detent),
 * MASTER as CC 7; the screen shows the last control touched (or an app's NAME), the clock, the chord or scale, a meter. Notes from
 * the computer light the pads and keys (host_light). */
#define LINK_MS 3000u
#define PAD0 36u
#if BOARD_SMK37
#define BTN_OCTD 4u
#define BTN_OCTU 5u
static const uint8_t CCN[NENC] = {74, 75, 76, 70, 71, 72, 73};
#else
#define BTN_OCTD 0u
#define BTN_OCTU 1u
static const uint8_t CCN[NENC] = {74, 75, 70, 71, 72, 73, 76};   /* SELECT, ALGORITHM, K1..K4, PRESETS */
#endif
static uint32_t lost, frame_open, lost_f;   /* (the screen's state, below) */
#define NPAD (NBTN - 2u)
#define UI_KEYS 1u
#define UI_LAST 2u
#define UI_CLOCK 4u
#define UI_HARM 8u
#define UI_ALL 0xFFu
static uint32_t idle_ok, keys_sent, master_v = 255, linked, link_ms, btn_on, btn_pad, ui_dirty = UI_ALL;
static int32_t master_sent = -1000, oct;
static uint8_t knote[27], cc_v[NENC] = {64, 64, 64, 64, 64, 64, 64};
/* the screen's top: the control last touched, by its name on the unit (or the app's, NAME), and its value (0..127, a bar) */
static char ctl_name[24] = "-", ctl_val[16];
static int32_t ctl_v = -1;
static uint32_t ctl_ms;
static tp_t tp;
#if BOARD_SMK37
static const char *const ENC_NAME[NENC] = {"SELECT", "ALGORITHM", "PRESETS", "K1", "K2", "K3", "K4"};
#else
static const char *const ENC_NAME[NENC] = {"SELECT", "ALGORITHM", "K1", "K2", "K3", "K4", "PRESETS"};
static const char *const BTN_NAME[NBTN] = {"OCT-", "OCT+", "FX", "SEL", "ENV", "LFO", "EDIT", "GLO", "HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC"};
#endif

static uint32_t pad_of(uint32_t k) { return k - (k > BTN_OCTD) - (k > BTN_OCTU); }
static char *sapp(char *p, const char *s) { while (*s) *p++ = *s++; return p; }
static char *sint(char *p, int32_t v)
{
    char t[11];
    uint32_t n = 0, u = v < 0 ? (uint32_t)-v : (uint32_t)v;
    if (v < 0) *p++ = '-';
    do { t[n++] = (char)('0' + u % 10u); u /= 10u; } while (u);
    while (n) *p++ = t[--n];
    return p;
}
static char *note_name(char *p, uint32_t n)
{
    static const char *const N[12] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
    p = sapp(p, N[n % 12u]);
    return sint(p, (int32_t)(n / 12u) - 1);
}
static void last_set(const char *name, uint32_t note, int32_t v, const char *what)   /* "K1" 83 "CC 70"; "F#3" 100 "KEY" */
{
    char *p = name ? sapp(ctl_name, name) : note_name(ctl_name, note);
    *p = 0;
    p = sapp(ctl_val, what);
    *p = 0;
    ctl_v = v;
    ctl_ms = fm1_ms;
    ui_dirty |= UI_LAST;
}
static void last_cc(const char *name, uint32_t cc, uint32_t v)
{
    char w[8], *p = sapp(w, "CC ");
    *sint(p, (int32_t)cc) = 0;
    last_set(name, 0, (int32_t)v, w);
}

static void all_off(void)                       /* what is held is let go in the mapping it was pressed in */
{
    uint32_t k;
    for (k = 0; k < 27u; k++)
        if (keys_sent >> k & 1u) midi_send(0x80u, knote[k], 0);
    for (k = 0; k < NBTN; k++)
        if (btn_on >> k & 1u) {
            if (btn_pad >> k & 1u) midi_send(0x89u, PAD0 + pad_of(k), 0);
            else midi_send(0x8Fu, k, 0);
        }
    keys_sent = btn_on = btn_pad = 0;           /* (a key still held is pressed again in the new mode) */
}
static void leds_clear(void)
{
    uint32_t i;
    for (i = 0; i < 42u; i++) { fm1_led_key(i, 0); fm1_led_key_glow(i, 0); }
}
/* lights from the computer (controller mode, like a Launchkey's pads): a note-on to a pad (channel 10) or a key (channel 1)
 * lights it, velocity 64..127 bright, 1..63 dim, 0 or a note-off dark. Keys go by note, so they follow OCT- / OCT+.
 * What is held lights bright over them. */
static uint32_t pad_lit, pad_dim, note_lit[4], note_dim[4];
static void led_upd(uint32_t id)                /* FM-1 ids: 0..13 the buttons, 14..40 the keys */
{
#if !BOARD_SMK37
    uint32_t on, dim;
    if (id < NBTN) {
        uint32_t pd = id == BTN_OCTD || id == BTN_OCTU ? 32u : pad_of(id);
        on = (btn_on >> id & 1u) || (pd < 32u && pad_lit >> pd & 1u);
        dim = pd < 32u && pad_dim >> pd & 1u;
    } else {
        int32_t n = (int32_t)(KEY0 + id - 14u) + 12 * oct;
        uint32_t u = n < 0 || n > 127 ? 0u : (uint32_t)n;
        on = (keys_sent >> (id - 14u) & 1u) || ((n >= 0 && n <= 127) && note_lit[u >> 5] >> (u & 31u) & 1u);
        dim = n >= 0 && n <= 127 && note_dim[u >> 5] >> (u & 31u) & 1u;
    }
    fm1_led_key(id, (int)on);
    fm1_led_key_glow(id, (int)(dim && !on));
#else
    (void)id;
#endif
}
static void host_light(uint32_t ch, uint32_t note, uint32_t vel)
{
    uint32_t b, lit = vel >= 64u, dim = vel && vel < 64u, *L, *D, k;
    if (ch == 9u && note >= PAD0 && note < PAD0 + NPAD) { b = note - PAD0; L = &pad_lit; D = &pad_dim; }
    else if (ch == 0u) { b = note & 31u; L = &note_lit[note >> 5]; D = &note_dim[note >> 5]; }
    else return;
    *L = (*L & ~(1u << b)) | lit << b;
    *D = (*D & ~(1u << b)) | dim << b;
    for (k = 0; k < 41u; k++) led_upd(k);      /* (41 writes to a matrix in RAM: cheap) */
    ui_dirty |= UI_HARM;                        /* what is lit has a name too */
}
static void set_link(uint32_t on)
{
    all_off();
    leds_clear();
    pad_lit = pad_dim = note_lit[0] = note_lit[1] = note_lit[2] = note_lit[3] = 0;
    note_dim[0] = note_dim[1] = note_dim[2] = note_dim[3] = 0;
    linked = on;
    master_v = 255u;                            /* MASTER is sent where it is, in the new mode */
    master_sent = -1000;
    if (on) { lost = 1; frame_open = 0; lost_f = 255u; }
    else ui_dirty = UI_ALL;
}

static void panel(void)
{
    uint32_t keys, ch, k, b, rel, v, i;
    int32_t d, m;
    if (!idle_ok) return;                       /* (not in the rescue, not before app_main) */
    if (linked && fm1_ms - link_ms > LINK_MS) set_link(0);   /* the page went quiet: a plain controller */
    keys = fm1_in.notes & 0x7FFFFFFu;
    ch = keys ^ keys_sent;
    keys_sent = keys;
    if (ch && !linked) ui_dirty |= UI_HARM;     /* the chord held */
    for (k = 0; k < 27u; k++)
        if (ch >> k & 1u) {
#if BOARD_SMK37
            uint32_t vel = fm1_in.key_vel[SMK_KEY_F3 + k] ? fm1_in.key_vel[SMK_KEY_F3 + k] : 1u;
#else
            uint32_t vel = 100u;                /* the FM-1's keys have no velocity */
#endif
            if (keys >> k & 1u) {
                int32_t n = (int32_t)(KEY0 + k) + (linked ? 0 : 12 * oct);
                knote[k] = (uint8_t)(n < 0 ? 0 : n > 127 ? 127 : n);
                midi_send(0x90u, knote[k], vel);
                if (!linked) { last_set(0, knote[k], (int32_t)vel, "KEY"); led_upd(14u + k); }
            } else {
                midi_send(0x80u, knote[k], 0);
                if (!linked) led_upd(14u + k);
            }
        }
    b = fm1_input_edges(&rel);
    for (k = 0; k < NBTN; k++) {
        if (b >> k & 1u) {
            if (linked) { midi_send(0x9Fu, k, 127); btn_on |= 1u << k; }
            else if (k == BTN_OCTD || k == BTN_OCTU) {
                oct += k == BTN_OCTU ? (oct < 3) : -(oct > -3);
                ui_dirty |= UI_KEYS;
                for (i = 14u; i < 41u; i++) led_upd(i);   /* the keys' lights go by note */
            } else {
                midi_send(0x99u, PAD0 + pad_of(k), 100);
                btn_on |= 1u << k;
                btn_pad |= 1u << k;
                {
                    char w[16], *q = sapp(w, "PAD ");
                    q = sint(q, (int32_t)pad_of(k) + 1);
                    q = sapp(q, "  ");
                    *note_name(q, PAD0 + pad_of(k)) = 0;
#if BOARD_SMK37
                    last_set("PAD", 0, -1, w);
#else
                    last_set(BTN_NAME[k], 0, -1, w);
#endif
                }
                led_upd(k);
            }
        }
        if (rel >> k & 1u && btn_on >> k & 1u) {
            uint32_t was_pad = btn_pad >> k & 1u;
            if (was_pad) midi_send(0x89u, PAD0 + pad_of(k), 0);
            else midi_send(0x8Fu, k, 0);
            btn_on &= ~(1u << k);
            btn_pad &= ~(1u << k);
            if (was_pad) led_upd(k);            /* back to the computer's light, if it set one */
        }
    }
    for (k = 0; k < NENC; k++)
        for (d = fm1_enc_take(ENC_SELECT + k); d;) {
            if (!linked) {                      /* an absolute CC, 2 steps a detent */
                int32_t a = (int32_t)cc_v[k] + 2 * d;
                a = a < 0 ? 0 : a > 127 ? 127 : a;
                if (a != cc_v[k]) { cc_v[k] = (uint8_t)a; midi_send(0xB0u, CCN[k], (uint32_t)a); last_cc(ENC_NAME[k], CCN[k], (uint32_t)a); }
                break;
            } else {
                int32_t s = d > 63 ? 63 : d < -63 ? -63 : d;
                midi_send(0xBFu, 20u + k, (uint32_t)(64 + s));
                d -= s;
            }
        }
    m = (int32_t)master_k10;
    v = (uint32_t)m >> 3;
    if (v != master_v && (m - master_sent > 6 || master_sent - m > 6 || v == 0u || v == 127u)) {   /* the pot jitters */
        master_sent = m;
        master_v = v;
        if (linked) midi_send(0xBFu, 27u, v);
        else { midi_send(0xB0u, 7u, v); last_cc("MASTER", 7u, v); }
    }
}

/* ---- the controller's screen (main loop only): the parts that changed are drawn again
 *   y 4    TETHER 0.9 · MIDI CONTROLLER
 *   y 26   the control last touched (its name on the unit, or the app's: NAME), y 62 what it sends and its value, a bar
 *   y 88   the transport from the MIDI clock: BPM, PLAY / STOP, bar.beat
 *   y 112  the chord held on the keys, or the chord / scale the computer lit (bright root, dim rest)
 *   y 150  the keys' octave and channels;  y 178 the meter of the sound the computer plays into the unit (USB speaker)
 *   y 214  how to link */
#define C_NAME RGB(255, 255, 255)
#define C_SUB RGB(140, 220, 200)
static void harm_text(char *out)
{
    uint32_t k, pcs = 0, bass = 128u, lit = 0, dim = 0, prefer = 12u;
    for (k = 0; k < 27u; k++)
        if (keys_sent >> k & 1u) { pcs |= 1u << knote[k] % 12u; if (knote[k] < bass) bass = knote[k]; }
    if (!pcs)                                   /* nothing held: what the computer lit */
        for (k = 0; k < 128u; k++) {
            uint32_t b = note_lit[k >> 5] >> (k & 31u) & 1u, d = note_dim[k >> 5] >> (k & 31u) & 1u;
            if (!b && !d) continue;
            if (b) lit |= 1u << k % 12u; else dim |= 1u << k % 12u;
            if (k < bass) bass = k;
        }
    if (!pcs) {
        pcs = lit | dim;
        for (k = 0; k < 12u; k++) if (lit == 1u << k && dim) prefer = k;   /* one bright pitch among dim ones: the root */
    }
    if (!harmony_name(pcs, bass, prefer, out)) *out = 0;
}
static uint32_t meter_w[2], meter_ms;
static uint32_t meter_of(uint32_t v)            /* a peak (Q15) -> 0..224 px, 1.5 dB a step, from -88 dB */
{
    uint32_t m = 0, i;
    if (v > 32767u) v = 32767u;
    if (v < 4u) return 0;
    while (v >> (m + 1u)) m++;                  /* the top bit */
    i = m * 4u + (v >> (m - 2u) & 3u);          /* + the next two bits */
    return i * 224u / 59u;
}
static void ctl_draw(void)
{
    char t[40], *p;
    uint32_t w;
    if (ui_dirty == UI_ALL) {
        lcd_fill(0, 0, 240, 240, C_BLACK);
        draw_text_box(0, 4, 240, &FONT_S, APP_NAME " " APP_VER " - MIDI CONTROLLER", RGB(180, 140, 255), 1);
        draw_text_box(0, 214, 240, &FONT_S, "open FM1.Pocket to link", RGB(110, 110, 110), 1);
        meter_w[0] = meter_w[1] = 999u;
    }
    if (ui_dirty & UI_LAST && fm1_ms - ctl_ms >= 30u) {   /* (30 ms: time for the app's NAME to come back first) */
        draw_text_box(0, 26, 240, text_w(&FONT_L, ctl_name) > 236 ? &FONT_S : &FONT_L, ctl_name, C_NAME, 1);
        cv_begin(240, 18, C_BLACK);
        cv_text(8, 1, &FONT_S, ctl_val, C_SUB);
        if (ctl_v >= 0) {
            p = sint(t, ctl_v);
            *p = 0;
            cv_text(232 - text_w(&FONT_S, t), 1, &FONT_S, t, C_NAME);
            w = text_w(&FONT_S, ctl_val) + 16u;
            cv_rect((int32_t)w, 6, 186 - (int32_t)w, 6, RGB(50, 60, 70));
            cv_rect((int32_t)w, 6, (int32_t)((186u - w) * (uint32_t)ctl_v / 127u), 6, C_SUB);
        }
        cv_blit(0, 62);
        lcd_sync();
        ui_dirty &= ~UI_LAST;
    }
    if (ui_dirty & UI_CLOCK) {
        *tp_text(&tp, t) = 0;
        draw_text_box(0, 88, 240, &FONT_S, t, RGB(230, 200, 120), 1);
    }
    if (ui_dirty & UI_HARM) {
        int32_t x;
        harm_text(t);                           /* the root big, the rest small (FONT_L has no lower case: "Am" is not "AM") */
        p = t + (t[0] ? 1 : 0) + (t[0] && t[1] == '#');
        w = (uint32_t)text_w(&FONT_S, p);
        {
            char root[3] = {t[0], p > t + 1 ? '#' : 0, 0};
            x = (240 - text_w(&FONT_L, root) - (int32_t)w) / 2;
            if (x < 0) x = 0;
            cv_begin(240, 32, C_BLACK);
            cv_text(x, 0, &FONT_L, root, RGB(255, 170, 120));
            cv_text(x + text_w(&FONT_L, root), 14, &FONT_S, p, RGB(255, 170, 120));
            cv_blit(0, 112);
            lcd_sync();
        }
    }
    if (ui_dirty & UI_KEYS) {
        p = sapp(t, "KEYS ch1 oct ");
        if (oct > 0) *p++ = '+';
        p = sint(p, oct);
        p = sapp(p, "   PADS ch10");
        *p = 0;
        draw_text_box(0, 150, 240, &FONT_S, t, RGB(200, 200, 200), 1);
    }
    ui_dirty &= UI_LAST;                        /* (a NAME still awaited stays) */
}
static void meter_poll(void)                    /* 25 times a second: the peaks since, falling 1.5 dB a step */
{
    uint32_t i, v[2], w;
    if (fm1_ms - meter_ms < 40u) return;
    meter_ms = fm1_ms;
    v[0] = pk_l; v[1] = pk_r;
    pk_l = pk_r = 0;
    for (i = 0; i < 2u; i++) {
        w = meter_of(v[i]);
        if (meter_w[i] != 999u && w + 4u < meter_w[i]) w = meter_w[i] - 4u;
        if (w == meter_w[i]) continue;
        meter_w[i] = w;
        cv_begin(240, 8, C_BLACK);
        cv_rect(8, 1, 224, 6, RGB(30, 36, 42));
        cv_rect(8, 1, (int32_t)w, 6, w > 200u ? RGB(255, 90, 80) : RGB(120, 220, 140));
        cv_blit(0, 178 + i * 10u);
        lcd_sync();
    }
}

/* the incoming MIDI: notes from the computer are lights, the clock and transport are the screen's (ctl_info.h) */
static void clock_poll(void)
{
    uint8_t st, d1, d2;
    int from;
    while ((from = midi_get(&st, &d1, &d2)) != 0) {
        if (linked) continue;                   /* (the page has no use for them: they are only drained) */
        if (from == 1 && (st & 0xE0u) == 0x80u) host_light(st & 15u, d1, (st & 0xF0u) == 0x90u ? d2 : 0u);   /* note on/off from USB: a light */
        else if (st >= 0xF2u && tp_msg(&tp, st, d1, d2, fm1_ms)) ui_dirty |= UI_CLOCK;
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
    if (p[4] == PROTO && p[5] == 0x05u) {       /* NAME (0.9): an app names the control just touched, "label" or "label|value"; no link */
        char *o = ctl_name, *end = ctl_name + 20;
        if (!sum || linked) return;
        for (i = 6; i + 1u < n; i++) {
            if (p[i] == '|' && end == ctl_name + 20) { *o = 0; o = ctl_val; end = ctl_val + 14; continue; }
            if (o < end) *o++ = p[i] >= 0x20u && p[i] < 0x7Fu ? (char)p[i] : '?';
        }
        *o = 0;
        ui_dirty |= UI_LAST;
        return;
    }
    if (sum) { link_ms = fm1_ms; if (!linked) set_link(1); }   /* any valid message from the page keeps the link */
    if (p[5] == 0x01u) { if (sum) hello(); return; }   /* HELLO? whatever its version */
    if (p[4] != PROTO) return;
    if (p[5] == 0x04u) return;                  /* PING: only the link above */
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
    idle_ok = 1;
    for (;;) {
        platform_poll();                        /* (our SysEx is handled in there) */
        panel();
        clock_poll();
        if (!linked && ui_dirty) ctl_draw();
        if (!linked) meter_poll();
    }
}
