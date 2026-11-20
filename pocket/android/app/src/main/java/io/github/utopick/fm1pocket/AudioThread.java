package io.github.utopick.fm1pocket;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Process;
import java.util.Arrays;

/** Pulls sound from Native.render and writes it to an AudioTrack; the blocking write is what paces the emulator. */
final class AudioThread extends Thread {
    private static final int RATE = 44100, CHUNK = 128; // 128 frames, as the worklet's quantum
    private volatile boolean stop, paused;

    AudioThread() { super("fm1-audio"); }

    void setPaused(boolean p) { paused = p; }
    void finish() { stop = true; }

    @Override public void run() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        AudioTrack track = new AudioTrack.Builder()
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setAudioFormat(new AudioFormat.Builder().setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).setEncoding(AudioFormat.ENCODING_PCM_FLOAT).build())
            .setBufferSizeInBytes(2048 * 2 * 4)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build();
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
            }
        } catch (InterruptedException ignored) {
        } finally {
            track.release();
        }
    }
}
