package io.github.utopick.fm1pocket;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Process;
import java.util.Arrays;
import java.util.concurrent.ConcurrentLinkedQueue;

/** Pulls sound from Native.render and writes it to an AudioTrack; the blocking write is what paces the emulator. */
final class AudioThread extends Thread {
    private static final int RATE = 44100, CHUNK = 128; // 128 frames, as the worklet's quantum
    private volatile boolean stop, paused;
    /** The sound buffer now, in frames: the delay it adds to every key (read by the native screen). */
    static volatile int bufferFrames;

    private final AudioManager am;
    private volatile AudioTrack track;
    /** The native screen's keys and knobs, handed to the core between two slices of sound: the UI thread never waits for the emulator. */
    private static final ConcurrentLinkedQueue<String> inbox = new ConcurrentLinkedQueue<>();
    static void send(String json) { inbox.add(json); }

    AudioThread(Context c) {
        super("fm1-audio");
        am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        // a USB speaker plugged in or out (the real FM-1 with Tether has one): the sound follows
        am.registerAudioDeviceCallback(new AudioDeviceCallback() {
            @Override public void onAudioDevicesAdded(AudioDeviceInfo[] d) { route(); }
            @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] d) { route(); }
        }, null);
    }

    /** The sound to a USB output when there is one (Android keeps a game's sound on the phone otherwise), else the default. */
    private void route() {
        AudioTrack t = track;
        if (t == null) return;
        AudioDeviceInfo usb = null;
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            int ty = d.getType();
            if (ty == AudioDeviceInfo.TYPE_USB_DEVICE || ty == AudioDeviceInfo.TYPE_USB_HEADSET) usb = d;
        }
        t.setPreferredDevice(usb);
    }

    void setPaused(boolean p) { paused = p; }
    void finish() { stop = true; }

    @Override public void run() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        Native.fastCores();
        AudioTrack.Builder b = new AudioTrack.Builder()
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setAudioFormat(new AudioFormat.Builder().setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).setEncoding(AudioFormat.ENCODING_PCM_FLOAT).build())
            .setBufferSizeInBytes(16384 * 2 * 4) // the most it may grow to (372 ms, for firmwares whose work comes in bursts), not what it starts with
            .setTransferMode(AudioTrack.MODE_STREAM);
        if (Build.VERSION.SDK_INT >= 26) b.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY);
        AudioTrack track = this.track = b.build();
        route();
        // Every frame in the buffer is a frame of delay between a key press and its sound, so start small
        // and double it each time the phone could not keep up (Android clamps it to what it allows). After 5 s
        // with no dropout it halves again: a heavy passage does not leave the keys slow for the rest of the session.
        int size = track.setBufferSizeInFrames(2 * CHUNK), underruns = 0;
        if (size <= 0) size = track.getBufferCapacityInFrames(); // refused: keep the whole buffer, as before
        bufferFrames = size;
        float[] buf = new float[CHUNK * 2];
        boolean playing = false;
        long calm = System.nanoTime(); // since when no dropout (or the last halving)
        try {
            while (!stop) {
                if (paused) {
                    if (playing) { track.pause(); playing = false; }
                    Thread.sleep(30);
                    continue;
                }
                if (!playing) { track.play(); playing = true; }
                for (String m; (m = inbox.poll()) != null; ) Native.post(m);
                int frames = Native.render(buf);
                if (frames <= 0) { Arrays.fill(buf, 0f); frames = CHUNK; } // off or between firmwares: silence keeps the pace
                track.write(buf, 0, Math.min(frames, CHUNK) * 2, AudioTrack.WRITE_BLOCKING);
                int u = track.getUnderrunCount();
                long now = System.nanoTime();
                if (u > underruns) {
                    underruns = u;
                    calm = now;
                    if (size < track.getBufferCapacityInFrames()) bufferFrames = size = Math.max(size, track.setBufferSizeInFrames(size * 2));
                } else if (size > 2 * CHUNK && now - calm > 5_000_000_000L) {
                    calm = now;
                    int s = track.setBufferSizeInFrames(size / 2);
                    if (s > 0) bufferFrames = size = s;
                }
            }
        } catch (InterruptedException ignored) {
        } finally {
            this.track = null;
            track.release();
        }
    }
}
