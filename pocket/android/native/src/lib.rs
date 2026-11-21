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

/// Whether the native JIT can get its memory here: the read-write-execute mapping fm1-core's code
/// cache asks for (jit.rs `CodeCache::new`); without it the emulator quietly interprets, several times slower.
pub fn jit_memory() -> bool {
    extern "C" {
        fn mmap(addr: *mut std::ffi::c_void, len: usize, prot: i32, flags: i32, fd: i32, off: i64) -> *mut std::ffi::c_void;
        fn munmap(addr: *mut std::ffi::c_void, len: usize) -> i32;
    }
    let p = unsafe { mmap(std::ptr::null_mut(), 4096, 7, 0x02 | 0x20, -1, 0) };
    if p as isize == -1 || p.is_null() { return false; }
    unsafe { munmap(p, 4096) };
    true
}

/// Keeps the calling thread off the slowest cores: those whose top clock is the lowest, when the
/// phone mixes kinds (big.LITTLE). Android places threads by load, and a thread that sleeps in each
/// audio write can stay on a little core that is several times slower. Returns the cores allowed.
pub fn fast_cores() -> u32 {
    #[cfg(any(target_os = "android", target_os = "linux"))]
    {
        extern "C" { fn sched_setaffinity(pid: i32, size: usize, mask: *const u64) -> i32; }
        let freq: Vec<(usize, u64)> = (0..64)
            .filter_map(|c| std::fs::read_to_string(format!("/sys/devices/system/cpu/cpu{c}/cpufreq/cpuinfo_max_freq")).ok()
                .and_then(|t| t.trim().parse().ok()).map(|f| (c, f)))
            .collect();
        let Some(low) = freq.iter().map(|f| f.1).min() else { return 0 };
        let mut mask = [0u64; 16]; // a cpu_set_t: 1024 bits
        let mut n = 0;
        for &(c, f) in &freq { if f > low { mask[c / 64] |= 1 << (c % 64); n += 1; } }
        if n == 0 || unsafe { sched_setaffinity(0, std::mem::size_of_val(&mask), mask.as_ptr()) } != 0 { return 0; }
        n
    }
    #[cfg(not(any(target_os = "android", target_os = "linux")))]
    0
}

#[no_mangle]
pub unsafe extern "system" fn Java_io_github_utopick_fm1pocket_Native_fastCores(_env: *mut JNIEnv, _c: jclass) -> jint {
    catch_unwind(fast_cores).unwrap_or(0) as jint
}

#[no_mangle]
pub unsafe extern "system" fn Java_io_github_utopick_fm1pocket_Native_load(_env: *mut JNIEnv, _c: jclass) -> jint {
    catch_unwind(|| with(|h| h.load())).unwrap_or(-1)
}

#[no_mangle]
pub unsafe extern "system" fn Java_io_github_utopick_fm1pocket_Native_peakLoad(_env: *mut JNIEnv, _c: jclass) -> jint {
    catch_unwind(|| with(|h| h.take_peak_load())).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "system" fn Java_io_github_utopick_fm1pocket_Native_jitMemory(_env: *mut JNIEnv, _c: jclass) -> jboolean {
    catch_unwind(jit_memory).unwrap_or(false) as jboolean
}

#[no_mangle]
pub unsafe extern "system" fn Java_io_github_utopick_fm1pocket_Native_version(env: *mut JNIEnv, _c: jclass) -> jstring {
    let s = CString::new(version()).unwrap();
    (**env).NewStringUTF.unwrap()(env, s.as_ptr() as *const c_char)
}
