/* SPDX-License-Identifier: GPL-3.0-only */
/* The device-only SysEx path Tether adds (no hardware: usb.c's packet parsing and ota.c's dispatch on the host):
 * a SysEx that arrives while the last one waits stays in the USB packet (ep1_take returns 0: NAK) and resumes where
 * it stopped, so nothing is dropped and nothing is taken twice; our 7D frames go to APP_SYSEX, M-UPGRADE's to ota.c,
 * none to the app in the rescue.  cc -o build/host/sx_hold_test tests/sx_hold_test.c && build/host/sx_hold_test */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define RING_PUBLISH() __asm__ volatile("" ::: "memory")
#define FELUCCA_OTA 1
static uint8_t recovery_active;
static uint32_t got_n, got_len[8];
static uint8_t got[8][640];
static void fm1_delay_ms(uint32_t ms) { (void)ms; }
static void app_sysex(const uint8_t *p, uint32_t n) { if (got_n < 8u) { memcpy(got[got_n], p, n); got_len[got_n++] = n; } }
#define APP_SYSEX app_sysex
#include "../firmware/src/usb.c"
static uint32_t ota_now_ms(void) { return 0; }
static void ota_idle(void) {}
static int ota_erase(uint32_t off) { (void)off; return -8; }
static int ota_prog(uint32_t off, const void *p, uint32_t n) { (void)off; (void)p; (void)n; return -8; }
static int ota_fread(uint32_t off, void *p, uint32_t n) { (void)off; (void)p; (void)n; return -8; }
static void ota_show(uint32_t step, int32_t code) { (void)step; (void)code; }
static void ota_commit(const uint8_t *parm) { (void)parm; }
#define FELUCCA_ID "FM-1_9250"
#include "../firmware/src/ota.c"

static int fails;
static void ok(int c, const char *what) { printf("%-72s %s\n", what, c ? "ok" : "FAIL"); fails += !c; }

/* bytes -> USB-MIDI SysEx event packets (CIN 4 continue, 5/6/7 end), appended to b at *n */
static void sx_events(uint8_t *b, uint32_t *n, const uint8_t *m, uint32_t len)
{
    uint32_t i = 0;
    while (i < len) {
        uint32_t k = len - i >= 3u ? 3u : len - i, end = i + k == len;
        b[(*n)++] = (uint8_t)(end ? 4u + k : 4u);
        b[(*n)++] = m[i];
        b[(*n)++] = k > 1u ? m[i + 1] : 0;
        b[(*n)++] = k > 2u ? m[i + 2] : 0;
        i += k;
    }
}

int main(void)
{
    static const uint8_t A[] = {0xF0, 0x7D, 0x46, 0x50, 0x54, 0x01, 0x01, 0x02, 0xF7};   /* HELLO? */
    static const uint8_t B[] = {0xF0, 0x7D, 0x46, 0x50, 0x54, 0x01, 0x02, 1, 0, 0, 0, 0, 0, 0x04, 0xF7};   /* LEDS */
    uint8_t pk[64];
    uint32_t n = 0, i;
    pk[n++] = 0x09; pk[n++] = 0x90; pk[n++] = 60; pk[n++] = 100;   /* a note before the SysEx */
    sx_events(pk, &n, A, sizeof A);                                /* 3 events */
    sx_events(pk, &n, B, sizeof B);                                /* 5 events */
    pk[n++] = 0x08; pk[n++] = 0x80; pk[n++] = 60; pk[n++] = 0;     /* and a note after: 40 bytes, one packet */

    ok(ep1_take(pk, n) == 0 && sx_ready && mi_w == 1u, "two SysEx in one packet: the first waits, the packet is held (NAK)");
    ok(ep1_take(pk, n) == 0 && mi_w == 1u, "still held while the first is not taken; the note is not taken twice");
    ota_service();
    ok(got_n == 1u && got_len[0] == sizeof A - 2u && !memcmp(got[0], A + 1, sizeof A - 2u) && !sx_ready,
       "ota_service hands the 7D frame to APP_SYSEX, between F0 and F7");
    ok(ep1_take(pk, n) == 1 && sx_ready && mi_w == 2u, "then the packet resumes where it stopped: the second SysEx, the note");
    ota_service();
    ok(got_n == 2u && got_len[1] == sizeof B - 2u && !memcmp(got[1], B + 1, sizeof B - 2u), "the second arrives whole");
    for (i = 0, n = 0; i < 2u; i++) sx_events(pk, &n, B, sizeof B);
    ok(ep1_take(pk, n) == 0 && ep1_take(pk, n) == 0, "held until taken");
    recovery_active = 1;
    ota_service();
    ok(got_n == 2u && !sx_ready, "in the rescue the frame is taken but never reaches the app");
    ok(ep1_take(pk, n) == 1, "and USB goes on");
    ota_service();
    recovery_active = 0;
    {
        static const uint8_t HS[7] = {0, 0x59, 0x11, 0, 0, 0, 0xFF};   /* M-UPGRADE handshake: 00 59 cmd len24 chk */
        uint8_t m[16];
        uint32_t k = ota_pack7(HS, 7, m + 1);
        m[0] = 0xF0; m[k + 1] = 0xF7;
        n = 0;
        sx_events(pk, &n, m, k + 2u);
        so_r = so_w;
        usb.config = 1;
        ep1_take(pk, n);
        ota_service();
        ok(got_n == 2u && so_w != so_r, "an M-UPGRADE handshake still goes to the updater (it answers), not to the app");
    }
    printf(fails ? "sx hold test FAILED\n" : "sx hold test passed\n");
    return fails != 0;
}
