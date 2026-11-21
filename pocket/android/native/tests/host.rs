//! Boots a firmware through the same code the audio thread runs, presses PLAY at 2 s, renders 15
//! emulated seconds and checks that frames arrive with a non-blank LCD and sound. Needs a
//! firmware package: FM1_FWSC=path/to/386dx.fwsc (skipped without it). FM1_OUT=out.raw writes the
//! audio as 16-bit stereo, as `web/bench.mjs` does, for comparing with the wasm build (README.md).
use fm1_android::with;
use fm1_web as w;

struct Msg { json: String, blobs: Vec<(String, Vec<u8>)> }

/// Decodes the poll body (the bridge in README.md).
fn decode(b: &[u8]) -> Vec<Msg> {
    let mut i = 0;
    let u = |i: &mut usize| { let v = u32::from_le_bytes(b[*i..*i + 4].try_into().unwrap()) as usize; *i += 4; v };
    let text = |i: &mut usize, n: usize| { let s = String::from_utf8(b[*i..*i + n].to_vec()).unwrap(); *i += n; s };
    let count = u(&mut i);
    (0..count).map(|_| {
        let n = u(&mut i);
        let json = text(&mut i, n);
        let blobs = (0..u(&mut i)).map(|_| {
            let n = u(&mut i);
            let name = text(&mut i, n);
            let n = u(&mut i);
            let _ty = text(&mut i, n);
            let n = u(&mut i);
            i += n;
            (name, b[i - n..i].to_vec())
        }).collect();
        Msg { json, blobs }
    }).collect()
}

fn cpu_time() -> std::time::Duration {
    // this process's CPU time (user + system), no dependency
    #[repr(C)] struct Tv { s: i64, us: i64 }
    #[repr(C)] struct Ru { u: Tv, s: Tv, rest: [i64; 14] }
    extern "C" { fn getrusage(who: i32, ru: *mut Ru) -> i32; }
    let mut r: Ru = unsafe { std::mem::zeroed() };
    unsafe { getrusage(0, &mut r) };
    std::time::Duration::new((r.u.s + r.s.s) as u64, 0) + std::time::Duration::from_micros((r.u.us + r.s.us) as u64)
}

#[test]
fn plays_a_song() {
    let Ok(path) = std::env::var("FM1_FWSC") else { eprintln!("FM1_FWSC not set: skipped"); return };
    let pkg = std::fs::read(path).unwrap();
    // (FM1_THREADS=2: core 1 on its own thread; its audio then differs from the reference run to run)
    let threads = std::env::var("FM1_THREADS").unwrap_or_else(|_| "1".into());
    with(|h| h.boot(&format!("{{\"seq\":1,\"mhz\":240,\"threads\":{threads}}}"), &pkg, &[], &[]));
    // PLAY at 2 s of emulated time, the script bench.mjs takes too (the page sends keys as messages)
    let script = b"2000:PLAY";
    let p = w::fm1_alloc(script.len() as u32);
    unsafe { std::ptr::copy_nonoverlapping(script.as_ptr(), p, script.len()) };
    assert_eq!(w::fm1_bench_script(p, script.len() as u32), 0);

    let (mut frames, mut frame_msgs, mut lcd_ok, mut booted, mut peak) = (0usize, 0, false, false, 0f32);
    let mut raw = Vec::new();
    let mut cpu = std::time::Duration::ZERO;
    let mut buf = vec![0f32; 256]; // one quantum of 128 frames, interleaved
    let (mut px, mut lv, mut face_ok) = (vec![0u16; 240 * 240], [0f32; 41], false);
    while w::fm1_ms() < 15_000 {
        let t = cpu_time();
        let n = with(|h| h.render(&mut buf));
        cpu += cpu_time() - t;
        assert_eq!(n, 128);
        for s in &buf { raw.extend_from_slice(&((*s * 32768.0).round() as i16).to_le_bytes()); }
        frames += n;
        if frames % (128 * 10) == 0 { // the native screen, about 34 times a second
            if with(|h| h.face(&mut px, &mut lv)) == 1 {
                face_ok |= px.iter().any(|p| *p != px[0]);
                assert_eq!(with(|h| h.face(&mut px, &mut lv)), 0, "an LCD that did not change came again");
            }
        }
        for m in decode(&with(|h| h.poll())) {
            if m.json.contains("\"type\":\"booted\"") { booted = true; }
            if m.json.contains("\"type\":\"frame\"") {
                frame_msgs += 1;
                if let Some((_, lcd)) = m.blobs.iter().find(|b| b.0 == "lcd") {
                    let px: Vec<u16> = lcd.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                    lcd_ok |= px.iter().any(|p| *p != px[0]);
                }
                let at = m.json.find("\"peak\":").unwrap() + 7;
                peak = peak.max(m.json[at..].split([',', '}']).next().unwrap().parse().unwrap());
            }
        }
    }
    println!("{frames} frames ({:.1} s of audio), {frame_msgs} frame messages, render CPU time {:.2} s, peak {peak}",
        frames as f64 / 44100.0, cpu.as_secs_f64());
    if let Ok(o) = std::env::var("FM1_OUT") { std::fs::write(o, &raw).unwrap(); }
    assert!(booted, "no booted message");
    assert!(frame_msgs > 0 && lcd_ok, "the LCD stayed blank");
    assert!(peak > 0.0, "silence");
    assert!(face_ok, "the native screen's LCD stayed blank");
    // the UI thread's reads give way while the lock is held (the audio thread in a slice)
    assert!(with(|_| fm1_android::try_with(|h| h.load()).is_none()), "a busy core was waited for");
    assert!(fm1_android::try_with(|h| h.load()).is_some());
    let load = with(|h| h.load());
    let peak = with(|h| h.take_peak_load());
    println!("load {load}%, highest 1/30 s {peak}% (render CPU time over sound time)");
    assert!(peak >= load && with(|h| h.take_peak_load()) == 0, "the peak was not kept, or not reset");
    assert!(load > 0 && load < 1000, "load {load}");
}
