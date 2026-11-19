/* SPDX-License-Identifier: GPL-3.0-only */
/* Tether's controller screen, the parts with no hardware in them (tests/ctl_info_test.c runs them on the host):
 *   harmony_name   the chord or scale of a set of notes ("Cmaj7", "E/G#", "D dorian"), or their names
 *   tp_*           the transport from the incoming MIDI clock: BPM, bar.beat, running (4/4)
 * Integers only (docs/RULES.md). */
#ifndef CTL_INFO_H
#define CTL_INFO_H
#include <stdint.h>

static const char *const PC_NAME[12] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
static char *ci_app(char *p, const char *s) { while (*s) *p++ = *s++; return p; }

/* intervals from the root, bit n = n semitones; chords first, then scales (the first match wins) */
#define B_(a) (1u << (a))
static const struct { uint16_t m; char chord; const char *n; } HARMONY[] = {
    {B_(0) | B_(4) | B_(7), 1, ""},           {B_(0) | B_(3) | B_(7), 1, "m"},
    {B_(0) | B_(3) | B_(6), 1, "dim"},        {B_(0) | B_(4) | B_(8), 1, "aug"},
    {B_(0) | B_(2) | B_(7), 1, "sus2"},       {B_(0) | B_(5) | B_(7), 1, "sus4"},
    {B_(0) | B_(7), 1, "5"},
    {B_(0) | B_(4) | B_(7) | B_(10), 1, "7"}, {B_(0) | B_(4) | B_(7) | B_(11), 1, "maj7"},
    {B_(0) | B_(3) | B_(7) | B_(10), 1, "m7"}, {B_(0) | B_(3) | B_(6) | B_(10), 1, "m7b5"},
    {B_(0) | B_(3) | B_(6) | B_(9), 1, "dim7"}, {B_(0) | B_(4) | B_(7) | B_(9), 1, "6"},
    {B_(0) | B_(3) | B_(7) | B_(9), 1, "m6"},  {B_(0) | B_(2) | B_(4) | B_(7), 1, "add9"},
    {B_(0) | B_(3) | B_(7) | B_(11), 1, "mMaj7"}, {B_(0) | B_(5) | B_(7) | B_(10), 1, "7sus4"},
    {B_(0) | B_(2) | B_(4) | B_(7) | B_(10), 1, "9"}, {B_(0) | B_(2) | B_(4) | B_(7) | B_(11), 1, "maj9"},
    {B_(0) | B_(2) | B_(3) | B_(7) | B_(10), 1, "m9"},
    {0xAB5u, 0, " major"},                    /* 0 2 4 5 7 9 11 */
    {0x5ADu, 0, " minor"},                    /* 0 2 3 5 7 8 10 */
    {0x6ADu, 0, " dorian"},                   /* 0 2 3 5 7 9 10 */
    {0x6B5u, 0, " mixolydian"},               /* 0 2 4 5 7 9 10 */
    {0xAD5u, 0, " lydian"},                   /* 0 2 4 6 7 9 11 */
    {0x5ABu, 0, " phrygian"},                 /* 0 1 3 5 7 8 10 */
    {0x56Bu, 0, " locrian"},                  /* 0 1 3 5 6 8 10 */
    {0x9ADu, 0, " harm minor"},               /* 0 2 3 5 7 8 11 */
    {0xAADu, 0, " mel minor"},                /* 0 2 3 5 7 9 11 */
    {0x295u, 0, " pentatonic"},               /* 0 2 4 7 9 */
    {0x4A9u, 0, " minor pent"},               /* 0 3 5 7 10 */
    {0x4E9u, 0, " blues"},                    /* 0 3 5 6 7 10 */
    {0x555u, 0, " whole tone"},               /* 0 2 4 6 8 10 */
    {0xFFFu, 0, " chromatic"},
};
#undef B_

static uint32_t rot12(uint32_t m, uint32_t r) { return ((m >> r) | (m << (12u - r))) & 0xFFFu; }   /* root r -> bit 0 */

/* pcs: the pitch classes (bit 0 = C), bass: the lowest one, prefer: a root to try first (an app lights the root bright,
 * the rest dim), 12 = none. Writes a name into out (24 bytes); 0: nothing to show. Tried in order: the preferred root, the
 * bass as a chord's root (C6, not Am7/C), then the table's order over every root (C major before A minor and D dorian) */
static int harmony_name(uint32_t pcs, uint32_t bass, uint32_t prefer, char *out)
{
    uint32_t i, k, r, n = 0, pass;
    char *p = out;
    pcs &= 0xFFFu;
    bass %= 12u;
    *p = 0;
    for (k = 0; k < 12u; k++) n += pcs >> k & 1u;
    if (!n) return 0;
    if (n == 1u) { ci_app(p, PC_NAME[bass])[0] = 0; return 1; }
    for (pass = 0; pass < 3u; pass++)
        for (i = 0; i < sizeof HARMONY / sizeof HARMONY[0]; i++)
            for (k = 0; k < 12u; k++) {
                r = pass == 0u ? prefer : pass == 1u ? bass : k;
                if (r > 11u || (pass == 1u && !HARMONY[i].chord) || rot12(pcs, r) != HARMONY[i].m) { if (pass < 2u) break; continue; }
                p = ci_app(p, PC_NAME[r]);
                p = ci_app(p, HARMONY[i].n);
                if (HARMONY[i].chord && r != bass) { *p++ = '/'; p = ci_app(p, PC_NAME[bass]); }   /* an inversion: C/E */
                *p = 0;
                return 1;
            }
    for (k = 0; k < 12u && p - out < 18; k++)  /* no name: the notes, from the bass up */
        if (pcs >> ((bass + k) % 12u) & 1u) { if (p != out) *p++ = ' '; p = ci_app(p, PC_NAME[(bass + k) % 12u]); }
    *p = 0;
    return 1;
}

/* the transport: F8 clocks (24 a quarter note), FA start, FB continue, FC stop, F2 song position (16ths) */
typedef struct { uint32_t pos, run, bpm, seen, t_mark, n_mark; } tp_t;
#define TP_BPM 1u                               /* what changed, for the screen */
#define TP_POS 2u
#define TP_RUN 4u
static uint32_t tp_msg(tp_t *t, uint32_t st, uint32_t d1, uint32_t d2, uint32_t ms)
{
    uint32_t ch = 0, beat0 = t->pos / 24u;
    if (st == 0xF8u) {
        if (!t->seen) { t->seen = 1; t->t_mark = ms; t->n_mark = 0; ch |= TP_BPM; }
        else if (++t->n_mark == 96u) {          /* 4 quarters: BPM = 4 x 60000 / their ms, rounded */
            uint32_t dt = ms - t->t_mark, b = dt ? (240000u + dt / 2u) / dt : 0u;
            if (b != t->bpm) { t->bpm = b; ch |= TP_BPM; }
            t->t_mark = ms;
            t->n_mark = 0;
        }
        if (t->run) { t->pos++; if (t->pos / 24u != beat0) ch |= TP_POS; }
    } else if (st == 0xFAu) { t->pos = 0; t->run = 1; ch |= TP_RUN | TP_POS; }
    else if (st == 0xFBu) { t->run = 1; ch |= TP_RUN; }
    else if (st == 0xFCu) { t->run = 0; ch |= TP_RUN; }
    else if (st == 0xF2u) { t->pos = ((d1 & 0x7Fu) | (d2 & 0x7Fu) << 7) * 6u; ch |= TP_POS; }
    return ch;
}
static char *tp_text(const tp_t *t, char *p)   /* "120 BPM  > 3.2" / "120 BPM  STOP 3.2" / "no clock" */
{
    char d[11];
    uint32_t n, v, q = t->pos / 24u;
    if (!t->seen) return ci_app(p, "no clock");
    if (t->bpm) {
        for (n = 0, v = t->bpm; d[n++] = (char)('0' + v % 10u), v /= 10u;) {}
        while (n) *p++ = d[--n];
        p = ci_app(p, " BPM  ");
    }
    p = ci_app(p, t->run ? "PLAY " : "STOP ");
    for (n = 0, v = q / 4u + 1u; d[n++] = (char)('0' + v % 10u), v /= 10u;) {}
    while (n) *p++ = d[--n];
    *p++ = '.';
    *p++ = (char)('1' + q % 4u);
    return p;
}
#endif
