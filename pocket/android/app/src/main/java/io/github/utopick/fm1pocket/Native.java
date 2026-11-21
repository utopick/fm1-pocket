package io.github.utopick.fm1pocket;

/** The Rust emulator (pocket/android/native, libfm1_android.so). Every call takes one lock inside, so any thread may call. */
final class Native {
    static { System.loadLibrary("fm1_android"); }

    /** A message the page sends the worklet, as JSON (everything but "boot"). */
    static native void post(String json);
    /** "boot": json holds the non-binary fields; the binaries are null for none. */
    static native void boot(String json, byte[] pkg, byte[] sectors, byte[] syx);
    /** Fills interleaved stereo floats; returns the frames written (0 or less: nothing to play). */
    static native int render(float[] interleavedStereo);
    /** The queue of messages for the page, in the format of pocket/android/README.md. */
    static native byte[] poll();
    /** The native screen: fills leds (41) always and lcd (240 x 240 RGB565) when it changed; -1 while off, 1 when lcd was filled, else 0. */
    static native int face(short[] lcd, float[] leds);
    static native String version();
    /** Keeps the calling thread on the faster cores; returns how many it may use (0: unchanged). */
    static native int fastCores();
    /** Emulation time over sound time in percent (100 = just real time), -1 while nothing plays. */
    static native int load();
    /** Whether the native JIT can get executable memory (else the emulator interprets, much slower). */
    static native boolean jitMemory();

    private Native() {}
}
