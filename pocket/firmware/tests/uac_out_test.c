/* SPDX-License-Identifier: GPL-3.0-only */
/* Tether's USB speaker (usb.c, TETHER_UAC_OUT) on the host, no hardware: the configuration descriptor is well formed
 * (lengths, interface count, the AC header's collection, the speaker's terminals and its EP4 OUT), the ring plays the
 * host's frames bit for bit after priming, an underrun gives silence and primes again, a packet with no room is dropped
 * whole, and two clocks that differ (the host's 44.1 kHz, the unit's I2S) stay together for minutes with only small
 * corrections (one frame made up or merged per render). Built twice: -DTETHER_UAC_OUT=0 checks the descriptors are
 * Dinghy's (audio input only).
 *   cc -o build/host/uac_out_test tests/uac_out_test.c && build/host/uac_out_test */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define RING_PUBLISH() __asm__ volatile("" ::: "memory")
#define HALF_FRAMES 256u
#define FELUCCA_OTA 0
#define FELUCCA_UAC 1
#ifndef TETHER_UAC_OUT
#define TETHER_UAC_OUT 1
#endif
static void fm1_delay_ms(uint32_t ms) { (void)ms; }
#include "../firmware/src/usb.c"
#if TETHER_UAC_OUT
#define UO_MAXP_T UO_MAXP
#else
#define UO_MAXP_T 0u
#endif

static int fails;
static void ok(int c, const char *what) { printf("%-76s %s\n", what, c ? "ok" : "FAIL"); fails += !c; }

static void descriptors(void)
{
    const uint8_t *d = CFG_DESC;
    uint32_t n = sizeof CFG_DESC, i, ifs = 0, links = 1, ac_len = 0, ac_sum = 0, in_ac = 0, ep04 = 0, ep84 = 0, cur_if = 99;
    uint32_t it3 = 0, ot4 = 0, as3 = 0;
    for (i = 0; i < n && d[i] >= 2u; i += d[i]) {
        const uint8_t *x = d + i;
        if (x[1] == 4) {                                /* interface */
            in_ac = x[5] == 1 && x[6] == 1;
            cur_if = x[2];
            if (x[3] == 0) ifs++;
        } else if (x[1] == 0x24 && in_ac) {             /* AC class-specific */
            if (x[2] == 1) ac_len = x[5] | x[6] << 8;
            ac_sum += x[0];
            if (x[2] == 2 && x[3] == 3) it3 = x[4] == 0x01 && x[5] == 0x01 && x[7] == 2;   /* USB streaming in, 2 ch */
            if (x[2] == 3 && x[3] == 4) ot4 = x[4] == 0x01 && x[5] == 0x03 && x[7] == 6;   /* speaker, from feature unit 6 (from 3) */
        } else if (x[1] == 0x24 && cur_if == 3u && x[2] == 1) {
            as3 = x[3] == 3;                            /* AS general links terminal 3 */
        } else if (x[1] == 5) {
            if (x[2] == 0x04) ep04 = cur_if == 3u && x[3] == 0x09 && (x[4] | x[5] << 8) == UO_MAXP_T && x[6] == 1;
            if (x[2] == 0x84) ep84 = cur_if == 2u && x[3] == 0x05;
        }
        links++;
    }
    ok(i == n && n == CFG_LEN && (d[2] | d[3] << 8) == n, "the configuration: descriptors chain to wTotalLength");
    ok(ifs == d[4], "bNumInterfaces = the interfaces described");
    ok(ac_len == ac_sum, "the AC header's wTotalLength = its class-specific descriptors");
    ok(ep84, "the audio input is still EP4 IN, isochronous async, interface 2");
    (void)links;
#if TETHER_UAC_OUT
    {
        const uint8_t *h = d + 18;                      /* config 9, AC interface 9: the header */
        ok(h[1] == 0x24 && h[2] == 1 && h[7] == 3 && h[8] == 1 && h[9] == 2 && h[10] == 3, "AC header: MIDI, audio in, speaker (interfaces 1 2 3)");
    }
    ok(it3 && ot4 && as3, "speaker: input terminal 3 (USB streaming) -> output terminal 4 (speaker), linked by IF3");
    ok(ep04, "speaker: EP4 OUT isochronous adaptive, 192 bytes, 1 ms, interface 3");
    ok(DEV_DESC[12] == 0x61 && DEV_DESC[13] == 0x03, "bcdDevice 3.61 (hosts read the descriptors again)");
    ok(UO_MAXP * 1000u / 4u >= 45000u, "a packet holds 45 frames (44.1 kHz)");
#else
    (void)it3; (void)ot4; (void)as3;
    ok(!ep04 && n == 178u && d[4] == 3u && DEV_DESC[12] == 0x20, "TETHER_UAC_OUT=0: no speaker, Dinghy's descriptors (178 B, 3 interfaces, 3.20)");
#endif
}

#if TETHER_UAC_OUT
static uint32_t ctr;                                    /* the host's frames: a counter, L = c, R = ~c */
static void host_packet(uint32_t f)
{
    uint8_t b[UO_MAXP];
    uint32_t i;
    for (i = 0; i < f; i++, ctr++) {
        uint32_t v = (ctr & 0xFFFFu) | ((~ctr & 0xFFFFu) << 16);
        memcpy(b + 4u * i, &v, 4);
    }
    uo_put(b, 4u * f);
}
static int32_t blk[2u * HALF_FRAMES];
static void render(void) { memset(blk, 0, sizeof blk); uo_play(blk, HALF_FRAMES); }
static int silent(void) { uint32_t i; for (i = 0; i < 2u * HALF_FRAMES; i++) if (blk[i]) return 0; return 1; }

static void ring(void)
{
    uint32_t i, good = 1;
    memset(&uo, 0, sizeof uo); uo_w = uo_r = 0; ctr = 0;
    render();
    ok(silent() && !uo.go, "nothing sent: silence");
    for (i = 0; i < 7u; i++) host_packet(44);           /* 308 frames: not yet UO_START */
    render();
    ok(silent() && uo_w - uo_r == 308u, "under UO_START: still silence, nothing taken");
    host_packet(45); host_packet(45);                   /* 398: plays from frame 46 (UO_START in hand), no correction */
    render();
    for (i = 0; i < HALF_FRAMES; i++)
        good &= blk[2u * i] == (int16_t)(i + 46u) && blk[2u * i + 1u] == (int16_t)~(i + 46u);
    ok(uo.go && good && uo.made + uo.merged == 0u && uo_w - uo_r == UO_START - 256u, "primed: the host's frames bit for bit, L and R, from UO_START back");
    render();                                           /* 96 left: ran dry */
    ok(silent() && !uo.go && uo.underruns == 1u && uo_w == uo_r, "underrun: silence, the stale tail dropped, priming again");
    for (i = 0; i < 9u; i++) host_packet(44);           /* 396 */
    render();
    ok(!silent() && uo.go && uo.starts == 2u, "plays again once primed");
    for (i = 0; i < 40u; i++) host_packet(UO_MAXF);     /* fills the ring: the packet that does not fit goes whole */
    ok(uo.overruns > 0u && uo_w - uo_r <= UO_N && (uo_w - uo_r - (UO_START - 256u)) % UO_MAXF == 0u, "no room: the packet is dropped whole, never part of it");
}

/* two clocks: the host's packets each 1 ms (44.1 pattern), taken at the next 0.5 ms poll (and a little jitter); the
 * unit renders 256 frames at fs_unit. Checks: no underrun or overrun once playing, the output is the host's counter
 * with steps of 1 (0 at a made-up frame, 2 at a merge), and the corrections are about what the clocks need */
static void drift(double fs_unit, const char *what)
{
    const double secs = 120.0, t_render = 256.0 / fs_unit;
    uint64_t lcg = 12345;
    uint32_t acc = 0, steps_bad = 0, z = 0, two = 0, skip = 0, fill_lo = 0xFFFFFFFFu, fill_hi = 0, started = 0;
    double t_pkt = 0.001, t_ren = 0.0003, need;
    int32_t prev = 0;
    int have = 0;
    char line[160];
    memset(&uo, 0, sizeof uo); uo_w = uo_r = 0; ctr = 0;
    while (t_ren < secs) {
        double jit = (double)((lcg = lcg * 6364136223846793005ull + 1442695040888963407ull) >> 40 & 1023u) / 1023.0 * 0.0004;
        double t_take = (double)(uint64_t)((t_pkt + jit) / 0.0005 + 1.0) * 0.0005;   /* the next poll after it lands */
        if (t_take <= t_ren) {
            uint32_t f = 44u;
            if ((acc += 100u) >= 1000u) acc -= 1000u, f++;
            host_packet(f);
            t_pkt += 0.001;
            continue;
        }
        {
            uint32_t fill = uo_w - uo_r, i, was = uo.go;
            render();
            if (was && uo.go) {
                if (fill < fill_lo) fill_lo = fill;
                if (fill > fill_hi) fill_hi = fill;
            }
            if (uo.go) {
                started = 1;
                for (i = 0; i < HALF_FRAMES; i++) {
                    int32_t v = blk[2u * i];
                    if (have && (v > 32760 || v < -32760 || prev > 32760 || prev < -32760))
                        skip++;                         /* (the counter wraps: a mean across it means nothing) */
                    else if (have) {
                        uint32_t s = (uint16_t)(v - prev);
                        if (s == 0u) z++;
                        else if (s == 2u) two++;
                        else if (s != 1u) steps_bad++;
                    }
                    prev = v;
                    have = 1;
                }
            }
        }
        t_ren += t_render;
    }
    need = (fs_unit - 44100.0) * secs;                  /* frames the unit takes beyond the host's (+: made up) */
    snprintf(line, sizeof line, "%s: %u made, %u merged (need ~%+.0f), fill %u..%u", what, uo.made, uo.merged, need, fill_lo, fill_hi);
    ok(started && uo.starts == 1u && uo.underruns == 0u && uo.overruns == 0u, line);
    ok(steps_bad == 0u && z <= uo.made && z + skip >= uo.made && two <= uo.merged && two + skip >= uo.merged, "  the output follows the host's frames: steps of 1, 0 where made up, 2 where merged");
    ok((double)uo.made - (double)uo.merged > need - 120.0 && (double)uo.made - (double)uo.merged < need + 120.0 &&
       (double)(uo.made + uo.merged) < (need < 0 ? -need : need) * 1.5 + 200.0, "  corrections match the clocks' difference (no hunting)");
    ok(fill_lo >= HALF_FRAMES && fill_hi < UO_N, "  the ring never ran under a render nor over");
}
#endif

int main(void)
{
    descriptors();
#if TETHER_UAC_OUT
    ring();
    drift(44117.6, "the FM-1's I2S (~44,117.6 Hz, usb.c) against 44.1");
    drift(44082.4, "a unit 0.04 % slow");
    drift(44100.0, "locked clocks");
    drift(44100.0 * 1.003, "0.3 % fast (a far-off host clock)");
    drift(44100.0 * 0.997, "0.3 % slow");
#endif
    printf(fails ? "uac out test FAILED\n" : "uac out test passed\n");
    return fails != 0;
}
