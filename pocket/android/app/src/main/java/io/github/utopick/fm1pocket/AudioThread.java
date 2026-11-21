package io.github.utopick.fm1pocket;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Process;
import java.util.Arrays;

/** Pulls sound from Native.render and writes it to an AudioTrack; the blocking write is what paces the emulator. */
final class AudioThread extends Thread {
    private static final int RATE = 44100, CHUNK = 128; // 128 frames, as the worklet's quantum
    private volatile boolean stop, paused;
    /** The sound buffer now, in frames: the delay it adds to every key (read by the native screen). */
    static volatile int bufferFrames;

    AudioThread() { super("fm1-audio"); }

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
        AudioTrack track = b.build();
        // Every frame in the buffer is a frame of delay between a key press and its sound, so start small
        // and double it each time the phone could not keep up (Android clamps it to what it allows).
        int size = track.setBufferSizeInFrames(2 * CHUNK), underruns = 0;
        if (size <= 0) size = track.getBufferCapacityInFrames(); // refused: keep the whole buffer, as before
        bufferFrames = size;
        float[] buf = new float[CHUNK * 2];
        boolean playing = false;
        try {
            while (!stop) {
                if (paused) {
                    if (playing) { track.pause(); playing = false; }
                    Thread.sleep(30);
                    continue;
                }
                if (!playing) { track.play(); playing = true; }
                int frames = Native.render(buf);
                if (frames <= 0) { Arrays.fill(buf, 0f); frames = CHUNK; } // off or between firmwares: silence keeps the pace
                track.write(buf, 0, Math.min(frames, CHUNK) * 2, AudioTrack.WRITE_BLOCKING);
                int u = track.getUnderrunCount();
                if (u > underruns) {
                    underruns = u;
                    if (size < track.getBufferCapacityInFrames()) bufferFrames = size = Math.max(size, track.setBufferSizeInFrames(size * 2));
                }
            }
        } catch (InterruptedException ignored) {
        } finally {
            track.release();
        }
    }
}
