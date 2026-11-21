package io.github.utopick.fm1pocket;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.SparseArray;
import android.view.Choreographer;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import java.nio.ShortBuffer;

/**
 * The FM-1's play screen drawn natively: the LCD, the knobs, the buttons and the keys, with their LEDs.
 * Touches go straight to the core (Native.post) and the screen reads the core (Native.face), so a slow
 * phone's WebView is out of the way while the FM-1 is played. The ids and messages are the page's
 * (pocket/src/app.html: ENCS, BTNS, WHITES, BLACKS, setKey, turn, setPot).
 */
final class FaceView extends View implements Choreographer.FrameCallback {
    private static final String[] KNOBS = {"MASTER", "SELECT", "PRESETS", "ALGORITHM", "KNOB1", "KNOB2", "KNOB3", "KNOB4"};
    private static final int[] ENC = {-1, 0, 6, 1, 2, 3, 4, 5}; // matrix encoder of each knob; MASTER is the pot
    private static final String[] BTNS = {"OCT-", "OCT+", "FX", "SEL", "ENV", "LFO", "EDIT", "GLO", "HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC"};
    private static final int[] WHITES = {0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26}; // semitones above F3
    private static final int[][] BLACKS = {{1, 0}, {3, 1}, {5, 2}, {8, 4}, {10, 5}, {13, 7}, {15, 8}, {17, 9}, {20, 11}, {22, 12}, {25, 14}}; // [semitone, after white]
    private static final int MENU = -2;

    private final Runnable onMenu;
    private final float dp;
    private final Bitmap lcdBitmap = Bitmap.createBitmap(240, 240, Bitmap.Config.RGB_565); // the FM-1's LCD is RGB565 too
    private final short[] lcd = new short[240 * 240];
    private final float[] leds = new float[41], ledAvg = new float[41];
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG), text = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF lcdRect = new RectF(), menuRect = new RectF();
    private final RectF[] keyRect = new RectF[41], knobRect = new RectF[8];
    private final int[] holds = new int[41];
    private final int[] clicks = new int[8];
    private int pot = 512; // the page's starting MASTER
    private boolean on, running;
    private long lastRead;

    /** What a finger holds: a key or button id, a knob (100 + index), or the menu button. */
    private static final class Finger { int what; float lastY, acc; }
    private final SparseArray<Finger> fingers = new SparseArray<>();

    FaceView(Context c, Runnable onMenu) {
        super(c);
        this.onMenu = onMenu;
        dp = c.getResources().getDisplayMetrics().density;
        text.setColor(Color.rgb(200, 200, 200));
        text.setTextAlign(Paint.Align.CENTER);
        text.setFakeBoldText(true);
        for (int i = 0; i < 41; i++) keyRect[i] = new RectF();
        for (int i = 0; i < 8; i++) knobRect[i] = new RectF();
        setHapticFeedbackEnabled(true);
    }

    // ---------------------------------------------------------------- layout

    @Override protected void onSizeChanged(int w, int h, int ow, int oh) {
        float pad = 6 * dp, top = h * 0.56f, s = top - 2 * pad;
        lcdRect.set((w - s) / 2, pad, (w + s) / 2, pad + s);
        float cw = lcdRect.left - 2 * pad, kh = top * 0.42f;
        // each side: a row of four knobs over a tray (left: MENU, OCT-, OCT+; right: the twelve buttons in two rows)
        for (int i = 0; i < 4; i++) {
            knobRect[i].set(pad + cw * i / 4, pad, pad + cw * (i + 1) / 4, pad + kh);
            knobRect[4 + i].set(lcdRect.right + pad + cw * i / 4, pad, lcdRect.right + pad + cw * (i + 1) / 4, pad + kh);
        }
        float ty = pad + kh + pad, tb = top - pad;
        menuRect.set(pad, ty, pad + cw / 3 - pad / 2, tb);
        keyRect[0].set(pad + cw / 3 + pad / 2, ty, pad + cw * 2 / 3 - pad / 2, tb);
        keyRect[1].set(pad + cw * 2 / 3 + pad / 2, ty, pad + cw, tb);
        float rx = lcdRect.right + pad, rh = (tb - ty - pad) / 2;
        for (int i = 0; i < 12; i++) {
            int col = i % 6, row = i / 6;
            float y = ty + row * (rh + pad);
            keyRect[2 + i].set(rx + cw * col / 6 + pad / 4, y, rx + cw * (col + 1) / 6 - pad / 4, y + rh);
        }
        float kx = pad, kw = w - 2 * pad, ky = top + pad, kb = h - pad, ww = kw / WHITES.length;
        for (int i = 0; i < WHITES.length; i++) keyRect[14 + WHITES[i]].set(kx + i * ww + 1.5f * dp, ky, kx + (i + 1) * ww - 1.5f * dp, kb);
        for (int[] b : BLACKS) {
            float cx = kx + (b[1] + 1) * ww;
            keyRect[14 + b[0]].set(cx - ww * 0.32f, ky, cx + ww * 0.32f, ky + (kb - ky) * 0.6f);
        }
        text.setTextSize(Math.min(11 * dp, cw / 22));
    }

    private boolean isBlack(int id) { for (int[] b : BLACKS) if (14 + b[0] == id) return true; return false; }

    /** The control under a point: black keys over white ones. */
    private int hit(float x, float y) {
        if (menuRect.contains(x, y)) return MENU;
        for (int i = 0; i < 8; i++) if (knobRect[i].contains(x, y)) return 100 + i;
        for (int id = 0; id < 41; id++) if (isBlack(id) && keyRect[id].contains(x, y)) return id;
        for (int id = 0; id < 41; id++) if (!isBlack(id) && keyRect[id].contains(x, y)) return id;
        return -1;
    }

    // ---------------------------------------------------------------- input

    private void setKey(int id, boolean down) {
        Native.post("{\"type\":\"key\",\"id\":" + id + ",\"down\":" + down + "}");
        invalidate();
    }
    private void press(int id) { if (holds[id]++ == 0) { setKey(id, true); performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP); } }
    private void unpress(int id) { if (holds[id] > 0 && --holds[id] == 0) setKey(id, false); }

    @Override public boolean onTouchEvent(MotionEvent e) {
        int a = e.getActionMasked();
        if (a == MotionEvent.ACTION_DOWN || a == MotionEvent.ACTION_POINTER_DOWN) {
            int i = e.getActionIndex(), what = hit(e.getX(i), e.getY(i));
            if (what == -1) return true;
            Finger f = new Finger();
            f.what = what;
            f.lastY = e.getY(i);
            fingers.put(e.getPointerId(i), f);
            if (what >= 0 && what < 41) press(what);
        } else if (a == MotionEvent.ACTION_MOVE) {
            for (int i = 0; i < e.getPointerCount(); i++) {
                Finger f = fingers.get(e.getPointerId(i));
                if (f == null) continue;
                float y = e.getY(i), up = (f.lastY - y) / dp;
                f.lastY = y;
                if (f.what >= 14 && f.what < 41) { // slide over the note keys
                    int h = hit(e.getX(i), y);
                    if (h >= 14 && h < 41 && h != f.what) { unpress(f.what); press(f.what = h); }
                } else if (f.what == 100) {
                    int v = Math.max(0, Math.min(1023, Math.round(pot + up * 6)));
                    if (v != pot) { pot = v; Native.post("{\"type\":\"pot\",\"value\":" + v + "}"); invalidate(); }
                } else if (f.what > 100) {
                    int k = f.what - 100, n = 0;
                    for (f.acc += up; f.acc >= 9; f.acc -= 9) n++; // a click every 9 dp, as the page's 9 px
                    for (; f.acc <= -9; f.acc += 9) n--;
                    if (n != 0) {
                        clicks[k] += n;
                        Native.post("{\"type\":\"enc\",\"enc\":" + ENC[k] + ",\"clicks\":" + n + "}");
                        performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
                        invalidate();
                    }
                }
            }
        } else if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_POINTER_UP || a == MotionEvent.ACTION_CANCEL) {
            int i = e.getActionIndex();
            Finger f = fingers.get(e.getPointerId(i));
            fingers.remove(e.getPointerId(i));
            if (a == MotionEvent.ACTION_CANCEL) { allUp(); return true; }
            if (f != null && f.what >= 0 && f.what < 41) unpress(f.what);
            if (f != null && f.what == MENU && menuRect.contains(e.getX(i), e.getY(i))) onMenu.run();
        }
        return true;
    }

    /** Lets go of everything held (the view is leaving the screen, or Android took the touches). */
    void allUp() {
        for (int id = 0; id < 41; id++) if (holds[id] > 0) { holds[id] = 0; setKey(id, false); }
        fingers.clear();
    }

    // ---------------------------------------------------------------- the screen, about 30 times a second

    @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); start(); }
    @Override protected void onDetachedFromWindow() { running = false; super.onDetachedFromWindow(); }
    @Override protected void onVisibilityChanged(View v, int vis) {
        super.onVisibilityChanged(v, vis);
        if (vis == VISIBLE) start(); else { running = false; allUp(); }
    }
    private void start() { if (!running && isShown()) { running = true; Choreographer.getInstance().postFrameCallback(this); } }

    @Override public void doFrame(long nanos) {
        if (!running) return;
        Choreographer.getInstance().postFrameCallback(this);
        if (nanos - lastRead < 30_000_000L) return; // the core reports about 30 times a second
        lastRead = nanos;
        int got = Native.face(lcd, leds);
        boolean was = on;
        on = got >= 0;
        if (got == 1) lcdBitmap.copyPixelsFromBuffer(ShortBuffer.wrap(lcd));
        boolean ledsMoved = false;
        for (int i = 0; i < 41; i++) {
            // as the page's showFrame: a dim LED still looks lit to the eye, so a square root with the noise under it cut,
            // more gain on the keys, and smoothing so a level read 30 times a second does not shimmer
            float raw = on ? leds[i] / 0.08f : 0, t = raw < 0.06f ? 0 : Math.min(1, (float) Math.sqrt(raw) * (i >= 14 ? 1.8f : 1));
            float v = Math.abs(t - ledAvg[i]) < 0.02f ? t : ledAvg[i] + (t - ledAvg[i]) * 0.3f;
            if (Math.abs(v - ledAvg[i]) > 0.005f) ledsMoved = true;
            ledAvg[i] = v;
        }
        if (got == 1 || ledsMoved || was != on) invalidate();
    }

    // ---------------------------------------------------------------- drawing

    private static int mix(int a, int b, float t) {
        return Color.rgb((int) (Color.red(a) + (Color.red(b) - Color.red(a)) * t), (int) (Color.green(a) + (Color.green(b) - Color.green(a)) * t),
            (int) (Color.blue(a) + (Color.blue(b) - Color.blue(a)) * t));
    }

    private void label(Canvas c, String s, RectF r, float y) { c.drawText(s, r.centerX(), y, text); }

    @Override protected void onDraw(Canvas c) {
        c.drawColor(Color.rgb(24, 24, 26));
        int lit = Color.rgb(255, 176, 64);
        float rr = 6 * dp;
        // LCD
        paint.setColor(Color.BLACK);
        c.drawRect(lcdRect, paint);
        if (on) c.drawBitmap(lcdBitmap, null, lcdRect, null); // no filter: the pixels stay square
        // knobs: an encoder turns 18 degrees a click, the pot sweeps 270
        for (int i = 0; i < 8; i++) {
            RectF r = knobRect[i];
            float th = text.getTextSize(), rad = Math.min(r.width(), r.height() - th - 4 * dp) * 0.4f, cx = r.centerX(), cy = r.top + rad + 2 * dp;
            paint.setColor(Color.rgb(58, 58, 62));
            c.drawCircle(cx, cy, rad, paint);
            double ang = Math.toRadians((i == 0 ? -135 + 270 * pot / 1023f : clicks[i] * 18) - 90);
            paint.setColor(Color.rgb(230, 230, 230));
            paint.setStrokeWidth(3 * dp);
            c.drawLine(cx + (float) Math.cos(ang) * rad * 0.35f, cy + (float) Math.sin(ang) * rad * 0.35f, cx + (float) Math.cos(ang) * rad * 0.9f, cy + (float) Math.sin(ang) * rad * 0.9f, paint);
            label(c, KNOBS[i], r, cy + rad + th + 2 * dp);
        }
        // menu and buttons
        paint.setColor(Color.rgb(70, 70, 90));
        c.drawRoundRect(menuRect, rr, rr, paint);
        label(c, "MENU", menuRect, menuRect.centerY() + text.getTextSize() / 3);
        for (int id = 0; id < 14; id++) {
            RectF r = keyRect[id];
            int base = holds[id] > 0 ? Color.rgb(90, 90, 96) : Color.rgb(50, 50, 54);
            paint.setColor(mix(base, id == 12 ? Color.rgb(80, 220, 120) : lit, ledAvg[id]));
            c.drawRoundRect(r, rr, rr, paint);
            label(c, BTNS[id], r, r.centerY() + text.getTextSize() / 3);
        }
        // keys: the white ones, then the black ones over them
        for (int pass = 0; pass < 2; pass++) {
            for (int id = 14; id < 41; id++) {
                if (isBlack(id) != (pass == 1)) continue;
                int base = pass == 1 ? Color.rgb(30, 30, 32) : Color.rgb(232, 232, 228);
                if (holds[id] > 0) base = pass == 1 ? Color.rgb(70, 70, 74) : Color.rgb(190, 190, 186);
                paint.setColor(mix(base, lit, ledAvg[id]));
                c.drawRoundRect(keyRect[id], rr / 2, rr / 2, paint);
            }
        }
    }
}
