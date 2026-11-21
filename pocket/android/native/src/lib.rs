//! FM1.Pocket's native core for Android: `host` is the logic (worklet.js ported over fm1-web),
//! this file is the one global lock and the JNI layer for `io.github.utopick.fm1pocket.Native`.

pub mod host;
pub mod json;

use host::Host;
use jni_sys::*;
use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

/// fm1-web keeps its state in globals and is not thread-safe: every entry point, the audio
/// thread's render included, holds this for its whole call.
static HOST: Mutex<Option<Host>> = Mutex::new(None);

pub fn with<R>(f: impl FnOnce(&mut Host) -> R) -> R {
    let mut g = HOST.lock().unwrap_or_else(|e| e.into_inner()); // a panic elsewhere must not wedge the audio
    f(g.get_or_insert_with(Host::new))
}

pub fn version() -> String { format!("fm1-android {}", env!("CARGO_PKG_VERSION")) }

// ---------------------------------------------------------------- JNI

unsafe fn string(env: *mut JNIEnv, s: jstring) -> String {
    if s.is_null() { return String::new(); }
    let p = (**env).GetStringUTFChars.unwrap()(env, s, std::ptr::null_mut());
    let out = CStr::from_ptr(p).to_string_lossy().into_owned();
    (**env).ReleaseStringUTFChars.unwrap()(env, s, p);
    out
}

unsafe fn bytes(env: *mut JNIEnv, a: jbyteArray) -> Vec<u8> {
    if a.is_null() { return vec![]; }
    let n = (**env).GetArrayLength.unwrap()(env, a) as usize;
    let mut v = vec![0u8; n];
    (**env).GetByteArrayRegion.unwrap()(env, a, 0, n as jsize, v.as_mut_ptr() as *mut jbyte);
    v
}

#[no_mangle]
pub unsafe extern "system" fn Java_io_github_utopick_fm1pocket_Native_post(env: *mut JNIEnv, _c: jclass, json: jstring) {
    let text = string(env, json);
    let _ = catch_unwind(AssertUnwindSafe(|| with(|h| h.post(&text))));
}

#[no_mangle]
pub unsafe extern "system" fn Java_io_github_utopick_fm1pocket_Native_boot(
    env: *mut JNIEnv, _c: jclass, json: jstring, package: jbyteArray, sectors: jbyteArray, syx: jbyteArray) {
    let (j, p, s, x) = (string(env, json), bytes(env, package), bytes(env, sectors), bytes(env, syx));
    let _ = catch_unwind(AssertUnwindSafe(|| with(|h| h.boot(&j, &p, &s, &x))));
}

#[no_mangle]
pub unsafe extern "system" fn Java_io_github_utopick_fm1pocket_Native_render(env: *mut JNIEnv, _c: jclass, out: jfloatArray) -> jint {
    let n = (**env).GetArrayLength.unwrap()(env, out) as usize;
    let mut buf = vec![0f32; n];
    let frames = catch_unwind(AssertUnwindSafe(|| with(|h| h.render(&mut buf)))).unwrap_or(0);
    (**env).SetFloatArrayRegion.unwrap()(env, out, 0, n as jsize, buf.as_ptr());
    frames as jint
}

#[no_mangle]
pub unsafe extern "system" fn Java_io_github_utopick_fm1pocket_Native_poll(env: *mut JNIEnv, _c: jclass) -> jbyteArray {
    let body = catch_unwind(AssertUnwindSafe(|| with(|h| h.poll()))).unwrap_or_else(|_| vec![0; 4]);
    let a = (**env).NewByteArray.unwrap()(env, body.len() as jsize);
    (**env).SetByteArrayRegion.unwrap()(env, a, 0, body.len() as jsize, body.as_ptr() as *const jbyte);
    a
}

#[no_mangle]
pub unsafe extern "system" fn Java_io_github_utopick_fm1pocket_Native_face(env: *mut JNIEnv, _c: jclass, lcd: jshortArray, leds: jfloatArray) -> jint {
    let (mut px, mut lv) = ([0u16; 240 * 240], [0f32; 41]);
    let got = catch_unwind(AssertUnwindSafe(|| with(|h| h.face(&mut px, &mut lv)))).unwrap_or(-1);
    if got >= 0 { (**env).SetFloatArrayRegion.unwrap()(env, leds, 0, 41, lv.as_ptr()); }
    if got == 1 { (**env).SetShortArrayRegion.unwrap()(env, lcd, 0, (240 * 240) as jsize, px.as_ptr() as *const jshort); }
    got
}

#[no_mangle]
pub unsafe extern "system" fn Java_io_github_utopick_fm1pocket_Native_version(env: *mut JNIEnv, _c: jclass) -> jstring {
    let s = CString::new(version()).unwrap();
    (**env).NewStringUTF.unwrap()(env, s.as_ptr() as *const c_char)
}
