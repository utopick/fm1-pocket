# FM1.Pocket for Android

This is FM1.Pocket as an Android app, made so that an old phone can have a second life as an FM-1. The app is the same
page as the one on the web, shown in a WebView, but the emulator and the sound run as native code instead of
WebAssembly. The emulator core is the same Rust code, and on an arm64 phone it uses its native JIT, which on our
measurements runs a heavy firmware about one and a half times faster than the WebAssembly version.

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

Download the artifact from the Actions run, unzip it, and copy the `.apk` to the phone, or open the link on the phone itself.
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

## What is not there yet

Android MIDI keyboards are not connected to the app yet (the web page's MIDI needs a browser feature the WebView doesn't
have), and neither is using a real FM-1 over USB, so REAL FM-1 and Tether do nothing here. The options for choosing the
sound output and for installing the web app are hidden. There are no settings of its own, the app is not on Google Play
or F-Droid, and the only build is for arm64. The Java side compiles, but the app has not been run on a real device yet.
