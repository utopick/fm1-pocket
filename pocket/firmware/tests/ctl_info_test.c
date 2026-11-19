/* SPDX-License-Identifier: GPL-3.0-only */
/* firmware/src/ctl_info.h on the host: chord and scale names, the transport from MIDI clock. cc tests/ctl_info_test.c && ./a.out */
#include <stdio.h>
#include <string.h>
#include "../firmware/src/ctl_info.h"
static int bad;
static uint32_t pcs(const int *n) { uint32_t m = 0; for (; *n >= 0; n++) m |= 1u << (*n % 12); return m; }
static void name(const char *want, uint32_t bass, uint32_t prefer, const int *notes)
{
    char out[24];
    harmony_name(pcs(notes), bass, prefer, out);
    if (strcmp(out, want)) { printf("FAIL harmony: want \"%s\", got \"%s\"\n", want, out); bad = 1; }
}
#define N(...) ((const int[]){__VA_ARGS__, -1})
int main(void)
{
    char out[24], *p;
    tp_t t = {0};
    uint32_t i;
    name("C", 0, 12, N(60));
    name("C", 0, 12, N(60, 64, 67));
    name("Am", 9, 12, N(57, 60, 64));
    name("C/E", 4, 12, N(64, 67, 72));          /* an inversion */
    name("Cmaj7", 0, 12, N(60, 64, 67, 71));
    name("C6", 0, 12, N(60, 64, 67, 69));       /* the bass is the root, not Am7/C */
    name("Am7/C", 0, 9, N(60, 64, 67, 69));     /* unless the app says the root is A */
    name("G7", 7, 12, N(55, 59, 62, 65));
    name("F#dim7", 6, 12, N(54, 57, 60, 63));
    name("C major", 5, 12, N(53, 55, 57, 59, 60, 62, 64));   /* the lowest lit key is F: still C major */
    name("A minor", 5, 9, N(53, 55, 57, 59, 60, 62, 64));    /* the root lit bright: A */
    name("D dorian", 0, 2, N(60, 62, 64, 65, 67, 69, 71));
    name("E blues", 4, 12, N(64, 67, 69, 70, 71, 74));
    name("C D", 0, 12, N(60, 62));              /* no name: the notes */
    if (harmony_name(0, 0, 12, out) != 0) { printf("FAIL: no notes should show nothing\n"); bad = 1; }
    /* the transport: 120 BPM = a clock every 20.83 ms */
    for (i = 0; i < 97u; i++) tp_msg(&t, 0xF8, 0, 0, i * 2500u / 120u);
    if (t.bpm != 120u || t.run) { printf("FAIL tp: bpm %u run %u\n", t.bpm, t.run); bad = 1; }
    tp_msg(&t, 0xFA, 0, 0, 2000);              /* (the clock runs on through START) */
    for (i = 97u; i < 97u + 24u * 5u + 1u; i++) tp_msg(&t, 0xF8, 0, 0, i * 2500u / 120u);
    p = tp_text(&t, out); *p = 0;
    if (strcmp(out, "120 BPM  PLAY 2.2")) { printf("FAIL tp_text: \"%s\"\n", out); bad = 1; }   /* 5 quarters and a tick: bar 2, beat 2 */
    tp_msg(&t, 0xFC, 0, 0, 5000);
    tp_msg(&t, 0xF2, 32, 0, 5000);              /* song position 32 sixteenths = bar 3 */
    p = tp_text(&t, out); *p = 0;
    if (strcmp(out, "120 BPM  STOP 3.1")) { printf("FAIL tp_text: \"%s\"\n", out); bad = 1; }
    tp_t z = {0};
    p = tp_text(&z, out); *p = 0;
    if (strcmp(out, "no clock")) { printf("FAIL tp_text: \"%s\"\n", out); bad = 1; }
    puts(bad ? "ctl_info: FAILED" : "ctl_info: ok");
    return bad;
}
