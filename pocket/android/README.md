# FM1.Pocket for Android

This is FM1.Pocket as an Android app, made so that a phone, old or new, can play the FM-1's firmwares as smoothly as the
real thing. The app is the same page as the one on the web, shown in a WebView, but the emulator and the sound run as
native code instead of WebAssembly. The emulator core is the same Rust code, and on an arm64 phone it uses its native
JIT. On a Galaxy S23 it plays even 386DX, the heaviest firmware we know, at the real FM-1's 240 MHz without a break in
the sound or a delay on the keys, so the app starts at 240 MHz (the web page starts at 100).

The FM-1's chip has two cores, and some firmwares (386DX, Bubba Machine) use the second one. The app runs that core on
a second thread of the phone, so a burst of work on it no longer holds up the sound. A firmware whose second core talks
to the chip all the time, as Bubba Machine's FreeRTOS does, goes back to one thread by itself, because there the threads
would spend more time waiting for each other than they save. How it works is described at the top of
[`crates/fm1-soc/src/mt.rs`](../../crates/fm1-soc/src/mt.rs).

MIDI keyboards work as on the web, and so does a real FM-1 over USB: REAL FM-1 can install firmwares, and with Tether
on the FM-1 the app sends its sound to the FM-1's speaker and headphone output.

It needs a 64-bit phone (arm64-v8a) with Android 7.0 or newer, and it plays in landscape.

## How it is built

You don't need an Android SDK on your own computer, because GitHub Actions builds it (`.github/workflows/android.yml`).
It runs when something changes under `pocket/` or `crates/` on the `pocket` branch or a branch whose name starts with
`android`, and you can also start it by hand from the Actions tab. It builds the Rust library in `native/`, builds the
page with `python3 pocket/build.py`, and then builds the APK with Gradle. The page is not kept inside the app folder:
Gradle copies `index.html`, the manifest and the icons from `pocket/` while it builds. The APK is attached to the run
as the artifact `fm1-pocket-apk`.

If the repository has the secrets `ANDROID_KEYSTORE_B64` (your keystore file, base64), `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`, the APK is a signed release. Without them you get the debug APK, which
is signed with a throwaway debug key and installs just as well.

To build on your own machine, put the library in `app/src/main/jniLibs/arm64-v8a/`, run `python3 pocket/build.py`, and run
`gradle assembleDebug` inside `pocket/android` (Gradle 8.7, JDK 17, Android SDK 34).

## Installing it on an old phone

Download the APK from the [FM1.Pocket for Android release](https://github.com/utopick/fm1-pocket/releases/tag/android-v1.0)
on the phone itself, or copy it over from a computer. A newer build can also come from an Actions run (unzip the artifact).
Open the file, and when Android asks, allow your file manager or browser to install apps from unknown sources. After
that, FM1.Pocket appears like any other app. Updating means installing a newer APK over it, and as long as it is signed
with the same key your saved firmwares stay. A debug APK from a different run is signed with a different debug key, so
Android will ask you to uninstall the old one first.

## How the page and the native core talk

Inside the app the page finds an object called `FM1Native` and uses it instead of an AudioWorklet. The messages are the
same ones the worklet gets. `FM1Native.boot` takes the "boot" message (its fields as JSON and the three binaries as
base64), and `FM1Native.post` takes every other message as JSON. In the other direction the page asks for
`/native/poll` about every 16 milliseconds, and the app answers with the messages the worklet would have posted.
The answer is in little-endian binary:

- a 32-bit count of messages;
- for each message, a 32-bit length and that many bytes of UTF-8 JSON (the message without its binary fields);
- then a 32-bit count of binary parts, and for each one a length and name, a length and type (such as `Uint16Array`),
  a 32-bit byte length, and the bytes.

The audio thread in the app asks the core for 128 frames at a time and writes them to an `AudioTrack`; because that write
waits for the sound card, the sound card sets the pace, as it does in the browser.

The page's PEDALS and LIVE FX screens are WebAudio, so while one of their effects is on the page calls `FM1Native.fx(true)`.
The audio thread then keeps writing to the `AudioTrack` at volume 0, which keeps the pace, and also keeps the sound for the
page, which fetches it from `/native/pcm` (interleaved little-endian stereo floats) at each poll and plays it through the
effects. That adds about 50 milliseconds, and only while an effect is on. `FM1Native.fx(false)` gives the sound back to
the app.

## What is not there yet

The app is not on Google Play or F-Droid, the only build is for arm64, and without the signing secrets above each build
has its own debug key. The options for choosing the sound output and for installing the web app are hidden, because the
app picks a USB output by itself and is already installed. It has its own play screen drawn natively (`FaceView.java`),
but it is switched off (`FACE = false` in `MainActivity.java`), because on a Galaxy S23 the page alone plays better.

To compare one thread with two, open the app's page in Chrome's remote debugging (`chrome://inspect`) and type
`FM1Native.threads(1)` or `FM1Native.threads(2)` in the console. The choice is kept, and it takes effect when the
firmware next starts.
