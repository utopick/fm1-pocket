//! The two-thread mode against the one-thread one: 386DX plays 15 s of emulated time both ways, and
//! the two-thread run must not fault, halt or fall silent, and sound like the reference (its level
//! and its spectrum in a few bands). Needs a package: FM1_FWSC=path/to/386dx.fwsc (skipped without).
//! FM1_SECONDS shortens it, FM1_OUT2=out.raw writes the two-thread audio.
use fm1_android::with;
use fm1_web as w;

/// Renders `secs` of emulated time (PLAY at 2 s) with `threads` threads; the audio as mono f32.
fn song(pkg: &[u8], threads: u32, secs: u32) -> Vec<f32> {
    with(|h| h.boot(&format!("{{\"seq\":1,\"mhz\":240,\"threads\":{threads}}}"), pkg, &[], &[]));
    assert_eq!(w::fm1_threaded(), threads, "the machine's thread mode");
    let script = b"2000:PLAY";
    let p = w::fm1_alloc(script.len() as u32);
    unsafe { std::ptr::copy_nonoverlapping(script.as_ptr(), p, script.len()) };
    assert_eq!(w::fm1_bench_script(p, script.len() as u32), 0);
    let (mut buf, mut out) = (vec![0f32; 256], vec![]);
    while w::fm1_ms() < secs * 1000 {
        with(|h| h.render(&mut buf));
        out.extend(buf.chunks(2).map(|f| (f[0] + f[1]) / 2.0));
    }
    assert_eq!(w::fm1_halted(), 0, "the machine halted ({threads} threads)");
    assert_eq!(w::fm1_cpu1_fault(), 0, "core 1 faulted ({threads} threads)");
    out
}

fn rms(x: &[f32]) -> f64 { (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64).sqrt() }

/// Energy of `x` (taken in 2048-sample windows) near `hz`, by Goertzel's filter.
fn band(x: &[f32], hz: f64) -> f64 {
    let (n, k) = (2048usize, (hz / 44100.0 * 2048.0).round());
    let c = 2.0 * (2.0 * std::f64::consts::PI * k / n as f64).cos();
    let mut e = 0.0;
    for win in x.chunks_exact(n) {
        let (mut s1, mut s2) = (0.0, 0.0);
        for v in win { let s = *v as f64 + c * s1 - s2; s2 = s1; s1 = s; }
        e += s1 * s1 + s2 * s2 - c * s1 * s2;
    }
    e
}

#[test]
fn two_threads_play_the_song_as_one_does() {
    let Ok(path) = std::env::var("FM1_FWSC") else { eprintln!("FM1_FWSC not set: skipped"); return };
    let secs = std::env::var("FM1_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(15);
    let pkg = std::fs::read(path).unwrap();
    let one = song(&pkg, 1, secs);
    let two = song(&pkg, 2, secs);
    if let Ok(o) = std::env::var("FM1_OUT2") {
        std::fs::write(o, two.iter().flat_map(|s| ((*s * 32768.0).round() as i16).to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    }
    let (r1, r2) = (rms(&one), rms(&two));
    println!("level (rms) one thread {r1:.4}, two threads {r2:.4}");
    assert!(r2 > 0.01, "silence with two threads");
    assert!((r2 / r1 - 1.0).abs() < 0.1, "the level differs: {r1} against {r2}");
    // the song's body: the same notes, so the same energy in each band within 2 dB
    for hz in [100.0, 200.0, 400.0, 800.0, 1600.0, 3200.0, 6400.0] {
        let (a, b) = (band(&one, hz), band(&two, hz));
        let db = 10.0 * (b / a).log10();
        println!("{hz:>6} Hz: {db:+.2} dB");
        assert!(db.abs() < 2.0, "{hz} Hz differs by {db} dB");
    }
}
