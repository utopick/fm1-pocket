//! The two-thread mode: core 1 on its own host thread (thread B) while the caller's thread
//! (thread A) runs core 0, the peripherals and time. See doc/fm1-pocket-multicore-design.md.
//!
//! What is shared. RAM is one block both threads read and write directly, through `RamView`'s
//! atomics, as both cores do on the chip (compiled code uses the same memory through raw
//! pointers). The XIP image is read by B straight from its buffer. Everything else in `Soc` is
//! A's: B reaches it only through `Core1Mt::io`, which waits for A to hand the `Soc` over (A does
//! at every slice boundary and while it spins on a lock: `Shared::yield_soc`), so the two never
//! touch it at once. Nothing else is shared but the atomics in `Shared`: the hardware lock's
//! owner, core 1's pending interrupt, the pause bit, the two clocks.
//!
//! Time. A publishes its clock at each slice; B may run until it is `window` cycles ahead of
//! that, and A waits when it is more than `window` ahead of B (`Shared::a_sync`). A B that is
//! asleep (`idle`), paused, or polling with nothing to do does not hold A back. The window is a
//! tuning knob: the cores drift apart by up to that much, which firmwares cannot tell, as they
//! meet through locks.
//!
//! Stopping. B runs from `Shared::start` to `Shared::quiesce`, which the runner calls (`machine::settle`) at
//! whatever reads or changes core 1 itself (the profile report, the JIT setting, a reset, a drop), so nothing outside sees core 1 in
//! the middle of a step. B parks in the thread's `park`, so a stopped core 1 costs nothing.
//!
//! The one-thread scheduler (`machine::run_dual_from`) is the default and the reference: this
//! mode runs only after `Soc::set_threads(2)`, and its output varies with the host's scheduler.
//!
//! wasm: `std::thread::spawn` panics on wasm32-unknown-unknown, so the build with atomics and
//! shared memory (web/build-threads.sh) asks the page for a Worker instead (`Mt::new`, `worker_main`),
//! and `sys` swaps what a thread sleeps, wakes and times with.

use crate::{Soc, RAM_BASE, VEC_BASE, XIP_BASE};
use fm1_core::{Bus, Cpu, JitMem};
use std::sync::atomic::{fence, AtomicBool, AtomicU32, AtomicU64, Ordering::*};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use sys::{Th, Tm};

/// What the two threads need of the host to sleep, wake and tell time. On a computer it is std's.
/// On wasm (the build with atomics) there is no thread to spawn, no clock and no sleep: the page's
/// Worker runs `worker_main`, a sleep is `memory.atomic.wait32` and may only be done by the Worker
/// (the audio thread must never block, so there it is a spin, and `backoff` gives up after a while
/// rather than hang the sound), and the clock is an import of the host.
#[cfg(not(target_arch = "wasm32"))]
mod sys {
    use std::time::Duration;
    pub use std::thread::{park, yield_now, Thread as Th};
    pub use std::time::Instant as Tm;
    pub fn current() -> Th { std::thread::current() }
    pub fn unpark(t: &Th) { t.unpark() }
    pub fn park_timeout(d: Duration) { std::thread::park_timeout(d) }
    pub fn can_block() -> bool { true }
}

#[cfg(target_arch = "wasm32")]
mod sys {
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU32, Ordering::*};
    use std::sync::Arc;
    use std::time::Duration;

    #[link(wasm_import_module = "env")]
    extern "C" {
        /// microseconds on the calling thread's clock (only differences are used)
        fn fm1_now_us() -> f64;
        /// asks the host to start core 1's Worker, which calls `fm1_core1_run(ptr)`
        pub fn fm1_core1_spawn(ptr: u32);
    }

    /// a thread's sleep word: 1 when it has been woken
    pub struct Parker(AtomicU32);
    pub type Th = Arc<Parker>;
    thread_local! {
        static ME: Th = Arc::new(Parker(AtomicU32::new(0)));
        static BLOCK: Cell<bool> = const { Cell::new(false) };
    }
    pub fn current() -> Th { ME.with(Clone::clone) }
    pub fn unpark(t: &Th) {
        t.0.store(1, SeqCst);
        unsafe { core::arch::wasm32::memory_atomic_notify(t.0.as_ptr() as *mut i32, 1) };
    }
    /// the Worker may sleep, the audio thread may not
    pub fn can_block() -> bool { BLOCK.with(Cell::get) }
    pub fn allow_blocking() { BLOCK.with(|b| b.set(true)) }
    /// sleeps until woken (true) or `d` has passed; the audio thread only spins
    fn wait(d: Duration) -> bool {
        if !can_block() { std::hint::spin_loop(); return false; }
        ME.with(|me| {
            if me.0.swap(0, SeqCst) == 1 { return true; }
            let r = unsafe { core::arch::wasm32::memory_atomic_wait32(me.0.as_ptr() as *mut i32, 0, d.as_nanos().min(i64::MAX as u128) as i64) };
            me.0.swap(0, SeqCst) == 1 || r == 0
        })
    }
    pub fn park_timeout(d: Duration) { wait(d); }
    pub fn park() { while !wait(Duration::from_secs(3600)) {} }
    pub fn yield_now() { std::hint::spin_loop() }
    #[derive(Clone, Copy)]
    pub struct Tm(f64);
    impl Tm {
        pub fn now() -> Tm { Tm(unsafe { fm1_now_us() }) }
        pub fn elapsed(&self) -> Duration { Duration::from_micros((Tm::now().0 - self.0).max(0.0) as u64) }
    }
}

/// How far (in cycles) the cores may drift apart: 256 slices, about 1.1 ms of FM-1 time. 386DX, 15 s
/// unpaced on an M4: wall 3.54 s at 64 slices, 3.41 at 256, 3.31 at 1024 (one thread: 4.0), and
/// core 0's waits fall from 3.6k to 0.8k to 0.1k; a longer drift lets a firmware's start-up
/// handshakes see it. FM1_MT_WINDOW (in slices) overrides it.
pub const WINDOW: u64 = 256 * crate::machine::SLICE as u64;

// who holds the `Soc`
const GATE_A: u32 = 0;
const GATE_FREE: u32 = 1;
const GATE_B: u32 = 2;
// thread B
const PARKED: u32 = 0;
const RUNNING: u32 = 1;

/// A core 1 that polls with nothing to do looks again after A has run this many cycles (a few
/// times as many once it has found nothing for a while).
const NAP: u64 = 2 * crate::machine::SLICE as u64;
const LONG_NAP: u64 = 32 * crate::machine::SLICE as u64;

/// A field on a cache line of its own: the two threads write and read these every slice or chunk,
/// and fields that share a line made each write cost the other thread a cache miss.
#[repr(align(64))]
struct L<T>(T);
impl<T> std::ops::Deref for L<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

/// The state both threads see. Everything here is atomic or behind a mutex.
pub struct Shared {
    gate: AtomicU32,
    /// B is waiting for the gate (A hands it over at its next chance)
    want: AtomicU32,
    /// the hardware lock: 0 free, else the owner's core + 1
    lock: AtomicU32,
    /// core 1's pending interrupt, as `pending_irq_for(1)` (0 none, else 1 | irq << 8 | prio << 16)
    irq1: L<AtomicU32>,
    paused1: AtomicBool,
    /// core 1 asleep on `idle`, until an interrupt of its bank is pending
    idle: AtomicBool,
    a_cycles: L<AtomicU64>,
    b_cycles: L<AtomicU64>,
    /// B is running (it holds A back when it falls more than the window behind)
    b_live: AtomicBool,
    /// B is in a sleep that A's `unpark` ends
    sleeping: AtomicBool,
    state: AtomicU32,
    stop: AtomicBool,
    quit: AtomicBool,
    window: AtomicU64,
    fault: Mutex<Option<String>>,
    fault_flag: AtomicBool,
    job: Mutex<Option<Job>>,
    thread: Mutex<Option<Th>>,
    /// wasm: the Worker has entered `worker_main`, and has left it
    pub up: AtomicBool,
    pub done: AtomicBool,
    /// times A waited for B's clock, B for A's, B for the gate (tuning: `Mt::stats`)
    pub a_waits: AtomicU64,
    pub b_waits: AtomicU64,
    pub b_gates: AtomicU64,
    /// instructions core 1 ran on thread B
    b_insns: L<AtomicU64>,
    /// microseconds spent in window waits by A and by B, in gate waits by B, and the sleeps of each
    pub a_wait_us: AtomicU64,
    pub b_wait_us: AtomicU64,
    pub b_gate_us: AtomicU64,
    pub a_sleeps: AtomicU64,
    /// consecutive failed `lockset`s of each core (the backoff's count)
    fails: [AtomicU32; 2],
    /// the clock at which A should wake B from a wait for it (u64::MAX: not waiting), and B's for A
    b_wake_at: AtomicU64,
    a_wake_at: AtomicU64,
    a_sleeping: AtomicBool,
    /// core 0 is retrying a `lockset` core 1 holds: B may run on past the window, to its unlock
    a_blocked: AtomicBool,
    a_thread: Mutex<Option<Th>>,
    /// the fallback's watch (`machine::run_dual_mt`): the clock and gate count at its last look, and the stretches over the limit in a row
    pub watch: Mutex<(u64, u64, u32)>,
}

/// What B runs: raw pointers into the machine, valid from `start` to `quiesce`.
#[derive(Clone, Copy)]
struct Job {
    cpu: *mut Cpu,
    soc: *mut Soc,
    ram: crate::ram::RamView,
    mem: JitMem,
    xip: *const u8,
    xip_len: usize,
}
// SAFETY: the pointers are used by thread B only between `start` and `quiesce`, in which A leaves
// the Cpu alone and the Soc as `Core1Mt::io` and the module docs say
unsafe impl Send for Job {}

/// The two-thread mode's state, owned by the `Soc`.
pub struct Mt {
    pub shared: Arc<Shared>,
    handle: Option<Handle>,
}

/// A short spin, a few yields, then sleeps that grow to 200 us: a partner that is not running (a
/// loaded phone) must not cost this thread's core as well (386DX at W=16, on a busy host: 27 s of CPU for 12 s of sound with yield loops).
const SPINS: u32 = 300;

/// How many backoffs a thread that cannot sleep waits for its partner (about a tenth of a second on wasm).
const PATIENCE: u32 = 1 << 25;

fn backoff(i: &mut u32) {
    if *i < SPINS {
        std::hint::spin_loop();
    } else if *i < SPINS + 4 {
        sys::yield_now();
    } else {
        if !sys::can_block() && *i > PATIENCE {
            // shortcut: a thread that cannot sleep and whose partner never answers (the Worker died) would hang the sound; a trap is reported instead
            panic!("two threads: core 1 does not answer");
        }
        sys::park_timeout(Duration::from_micros(20 + 10 * (*i - SPINS - 4).min(18) as u64));
    }
    *i = i.saturating_add(1);
}

/// `backoff` for a partner that has just been woken (a start, a stop): it should be with us within
/// a scheduler's latency, so yields come first, and only a late one costs a sleep.
fn backoff_woken(i: &mut u32) {
    if *i < SPINS + 400 {
        if *i < SPINS { std::hint::spin_loop() } else { sys::yield_now() }
        *i += 1;
    } else {
        backoff(i);
    }
}

impl Shared {
    fn new() -> Shared {
        Shared {
            up: AtomicBool::new(false),
            done: AtomicBool::new(false),
            gate: AtomicU32::new(GATE_A),
            want: AtomicU32::new(0),
            lock: AtomicU32::new(0),
            irq1: L(AtomicU32::new(0)),
            paused1: AtomicBool::new(false),
            idle: AtomicBool::new(false),
            a_cycles: L(AtomicU64::new(0)),
            b_cycles: L(AtomicU64::new(0)),
            b_live: AtomicBool::new(false),
            sleeping: AtomicBool::new(false),
            state: AtomicU32::new(PARKED),
            stop: AtomicBool::new(false),
            quit: AtomicBool::new(false),
            window: AtomicU64::new(WINDOW),
            fault: Mutex::new(None),
            fault_flag: AtomicBool::new(false),
            job: Mutex::new(None),
            thread: Mutex::new(None),
            a_waits: AtomicU64::new(0),
            b_waits: AtomicU64::new(0),
            b_gates: AtomicU64::new(0),
            b_insns: L(AtomicU64::new(0)),
            a_wait_us: AtomicU64::new(0),
            b_wait_us: AtomicU64::new(0),
            b_gate_us: AtomicU64::new(0),
            a_sleeps: AtomicU64::new(0),
            fails: Default::default(),
            b_wake_at: AtomicU64::new(u64::MAX),
            a_wake_at: AtomicU64::new(u64::MAX),
            a_sleeping: AtomicBool::new(false),
            a_blocked: AtomicBool::new(false),
            a_thread: Mutex::new(None),
            watch: Mutex::new((0, 0, 0)),
        }
    }

    /// The shared words, for a hang report.
    pub fn dump(&self) -> String {
        format!("gate {} want {} lock {} irq1 {:#x} paused1 {} idle {} a {} b {} b_live {} sleeping {} state {} stop {} b_insns {} a_blocked {} fails {:?} b_wake_at {} a_wake_at {} a_sleeping {} cycles_now {}",
            self.gate.load(Relaxed), self.want.load(Relaxed), self.lock.load(Relaxed), self.irq1.load(Relaxed), self.paused1.load(Relaxed),
            self.idle.load(Relaxed), self.a_cycles.load(Relaxed), self.b_cycles.load(Relaxed), self.b_live.load(Relaxed), self.sleeping.load(Relaxed),
            self.state.load(Relaxed), self.stop.load(Relaxed), self.b_insns.load(Relaxed),
            self.a_blocked.load(Relaxed), [self.fails[0].load(Relaxed), self.fails[1].load(Relaxed)], self.b_wake_at.load(Relaxed), self.a_wake_at.load(Relaxed), self.a_sleeping.load(Relaxed), 0)
    }

    pub fn set_window(&self, cycles: u64) {
        self.window.store(cycles.max(crate::machine::SLICE as u64), Relaxed);
    }

    fn wake(&self) {
        if self.sleeping.load(SeqCst) {
            if let Some(t) = self.thread.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                sys::unpark(t);
            }
        }
    }

    /// The hardware lock for `core`: `lockset` (`set`) takes it, or false when the other core has
    /// it after a short spin (the instruction then retries); `lockclr` releases it.
    pub fn hw_lock(&self, core: u32, set: bool) -> bool {
        let me = core + 1;
        if !set {
            let _ = self.lock.compare_exchange(me, 0, Release, Relaxed);
            return true;
        }
        let f = &self.fails[core as usize & 1];
        // Core 0 waits here, handing the Soc over between tries: the holder may be waiting for it
        // (an access of its own inside its critical section), and a round of sleeps between tries
        // let Bubba Machine's cores crawl at a try per sleep. Core 1 tries once and `Why::Blocked` waits.
        let rounds = if core == 0 { 100 } else { 1 };
        for _ in 0..rounds {
            // (long enough to span a critical section of the other core's: it is running, not waiting)
            for _ in 0..1000 {
                match self.lock.compare_exchange(0, me, Acquire, Relaxed) {
                    Ok(_) => {
                        f.store(0, Relaxed);
                        if core == 0 {
                            self.a_blocked.store(false, Relaxed);
                        }
                        return true;
                    }
                    Err(owner) if owner == me => return true,
                    Err(_) => std::hint::spin_loop(),
                }
            }
            if core == 0 {
                // its clock stands still meanwhile, so B may run on past the window to the unlock
                self.a_blocked.store(true, Relaxed);
                self.yield_soc();
            }
        }
        if core == 1 {
            return false;
        }
        let mut i = f.load(Relaxed);
        backoff(&mut i);
        f.store(i, Relaxed);
        false
    }

    /// Lets go of the lock core 1 held when it stopped (a fault).
    pub fn release_lock_of_1(&self) {
        let _ = self.lock.compare_exchange(2, 0, Release, Relaxed);
    }

    /// A hands the `Soc` to B if it is waiting for it, and waits for B to be done with it.
    pub fn yield_soc(&self) {
        if self.want.load(Acquire) == 0 {
            return;
        }
        self.gate.store(GATE_FREE, Release);
        let mut i = 0;
        while self.want.load(Acquire) > 0 {
            backoff(&mut i);
        }
        while self.gate.compare_exchange(GATE_FREE, GATE_A, Acquire, Relaxed).is_err() {
            backoff(&mut i);
        }
    }

    fn b_gate(&self) {
        self.want.fetch_add(1, SeqCst);
        self.b_gates.fetch_add(1, Relaxed);
        let t0 = Tm::now();
        let mut i = 0;
        while self.gate.compare_exchange(GATE_FREE, GATE_B, Acquire, Relaxed).is_err() {
            backoff(&mut i);
        }
        self.b_gate_us.fetch_add(t0.elapsed().as_micros() as u64, Relaxed);
    }

    fn b_ungate(&self) {
        self.gate.store(GATE_FREE, Release);
        self.want.fetch_sub(1, SeqCst);
    }

    fn encode(irq: Option<(u8, u8)>) -> u32 {
        irq.map_or(0, |(i, p)| 1 | (i as u32) << 8 | (p as u32) << 16)
    }

    fn decode(w: u32) -> Option<(u8, u8)> {
        (w != 0).then(|| ((w >> 8) as u8, (w >> 16) as u8))
    }

    /// Core 1's pending interrupt, from the `Soc` (the owner's call: A at a slice, B holding the gate).
    fn publish_irq(&self, soc: &Soc) {
        let w = Self::encode(if soc.periph.any_pending() { soc.pending_irq_for(1) } else { None });
        // (a read first: a write every slice would pull the line away from the other thread)
        let old = self.irq1.load(Relaxed);
        if old != w {
            self.irq1.store(w, Release);
            if w != 0 && old == 0 {
                self.wake();
            }
        }
    }

    /// A, before each slice: its clock and core 1's interrupt where B can see them, and a wait
    /// while B is more than the window behind.
    pub fn a_sync(&self, soc: &Soc) {
        self.publish_irq(soc);
        let a = soc.periph.cycles;
        self.a_cycles.store(a, Release);
        if a >= self.b_wake_at.load(Relaxed) {
            self.wake();
        }
        self.yield_soc();
        let w = self.window.load(Relaxed);
        let mut i = 0;
        let t0 = Tm::now();
        let behind = || self.b_live.load(Acquire) && self.state.load(Acquire) == RUNNING && a > self.b_cycles.load(Acquire) + w;
        while behind() {
            if i == 0 {
                self.a_waits.fetch_add(1, Relaxed);
            }
            self.yield_soc();
            if i < SPINS {
                backoff(&mut i);
            } else {
                // asleep until B has caught up by half a window (its `wake_a`), or a millisecond
                self.a_wake_at.store(a.saturating_sub(w / 2), SeqCst);
                self.a_sleeping.store(true, SeqCst);
                if !sys::can_block() {
                    // the audio thread does not wait for core 1: it runs on, and core 1 catches up (or the locks make them meet)
                    self.a_sleeping.store(false, SeqCst);
                    self.a_wake_at.store(u64::MAX, Relaxed);
                    self.a_sleeps.fetch_add(1, Relaxed);
                    break;
                }
                if behind() {
                    sys::park_timeout(Duration::from_millis(1));
                }
                self.a_sleeping.store(false, SeqCst);
                self.a_wake_at.store(u64::MAX, Relaxed);
                self.a_sleeps.fetch_add(1, Relaxed);
            }
        }
        if i > 0 {
            self.a_wait_us.fetch_add(t0.elapsed().as_micros() as u64, Relaxed);
        }
    }

    /// B wakes A from a wait for B's clock, once it has got there.
    fn wake_a(&self, b: u64) {
        if b >= self.a_wake_at.load(SeqCst) && self.a_sleeping.load(SeqCst) {
            if let Some(t) = self.a_thread.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                sys::unpark(t);
            }
        }
    }

    /// B's fault, once (a message for `run_dual`).
    pub fn take_fault(&self) -> Option<String> {
        if self.fault_flag.load(Acquire) {
            self.fault_flag.store(false, Relaxed);
            return self.fault.lock().unwrap_or_else(|e| e.into_inner()).take();
        }
        None
    }

    /// Starts (or resumes) B on `job`, from the clock `a`.
    fn start(self: &Arc<Self>, job: Job, soc: &Soc, handle: &mut Option<Handle>) {
        if self.state.load(Acquire) == RUNNING {
            // (the same machine, or the runner would have quiesced: a different one is a bug)
            return;
        }
        let a = soc.periph.cycles;
        *self.job.lock().unwrap_or_else(|e| e.into_inner()) = Some(job);
        *self.a_thread.lock().unwrap_or_else(|e| e.into_inner()) = Some(sys::current());
        self.a_cycles.store(a, Relaxed);
        self.b_cycles.store(a, Relaxed);
        self.b_live.store(false, Relaxed);
        self.paused1.store(soc.core_paused(1), Relaxed);
        self.publish_irq(soc);
        self.stop.store(false, Relaxed);
        self.gate.store(GATE_A, Release);
        self.state.store(RUNNING, Release);
        if handle.is_none() {
            let h = spawn(Arc::clone(self));
            if let Some(t) = h.thread() {
                *self.thread.lock().unwrap_or_else(|e| e.into_inner()) = Some(t);
            }
            *handle = Some(h);
        }
        // (a thread that has just been spawned sees the state itself; one that was parked, or the Worker, must be woken)
        if let Some(t) = self.thread.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            sys::unpark(t);
        }
        // Core 1 is on the chip at once: a firmware that waits for it to answer (386DX's start-up
        // handshake gives up after a few ms) must not see this thread's start-up as silence.
        let t0 = Tm::now();
        let mut i = 0;
        while !self.b_live.load(Acquire) && self.state.load(Acquire) == RUNNING && t0.elapsed() < Duration::from_millis(100) {
            if !self.sleeping.load(Relaxed) && self.paused1.load(Relaxed) {
                break; // (held: it will not go live)
            }
            backoff_woken(&mut i);
        }
    }

    /// Stops B and waits until it is parked, with the `Soc` and the `Cpu` as it left them.
    pub fn quiesce(&self) {
        if self.state.load(Acquire) == PARKED {
            return;
        }
        self.stop.store(true, Release);
        let mut i = 0;
        let t0 = Tm::now();
        while self.state.load(Acquire) != PARKED {
            if cfg!(target_arch = "wasm32") && !self.up.load(Acquire) && t0.elapsed() > Duration::from_millis(100) {
                // the Worker never started: nothing runs core 1, and nothing will take the job
                *self.job.lock().unwrap_or_else(|e| e.into_inner()) = None;
                self.state.store(PARKED, Release);
                break;
            }
            if let Some(t) = self.thread.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                sys::unpark(t);
            }
            self.yield_soc();
            backoff_woken(&mut i);
        }
        self.stop.store(false, Relaxed);
    }

    /// What the one-thread scheduler needs of the shared state when the mode ends: the hardware
    /// lock's owner and whether core 1 sleeps (B is stopped).
    pub fn hand_back(&self) -> (Option<u32>, bool) {
        (match self.lock.load(Acquire) { 0 => None, n => Some(n - 1) }, self.idle.load(Acquire))
    }

    pub fn gates(&self) -> u64 {
        self.b_gates.load(Relaxed)
    }

    /// A chip reset: the state B shared with core 1 starts over.
    pub fn reset(&self) {
        self.lock.store(0, Release);
        self.irq1.store(0, Release);
        self.paused1.store(false, Release);
        self.idle.store(false, Release);
        self.fault_flag.store(false, Relaxed);
        *self.fault.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn set_paused1(&self, on: bool) {
        self.paused1.store(on, Release);
        if !on {
            self.wake();
        }
    }
}

impl Mt {
    pub fn new() -> Mt {
        let sh = Shared::new();
        // (FM1_MT_WINDOW: the window in slices, for tuning)
        if let Some(n) = std::env::var("FM1_MT_WINDOW").ok().and_then(|v| v.parse::<u64>().ok()) {
            sh.set_window(n * crate::machine::SLICE as u64);
        }
        let shared = Arc::new(sh);
        #[cfg(target_arch = "wasm32")]
        unsafe { sys::fm1_core1_spawn(Arc::into_raw(Arc::clone(&shared)) as u32) };
        Mt { shared, handle: None }
    }

    /// Has core 1's thread been started (the firmware released the core)?
    pub fn started(&self) -> bool {
        self.handle.is_some()
    }

    /// (cores 1's time in the window waits, for tuning) A's waits for B, B's for A, B's for the `Soc`
    pub fn stats(&self) -> [u64; 8] {
        let s = &self.shared;
        [s.a_waits.load(Relaxed), s.b_waits.load(Relaxed), s.b_gates.load(Relaxed), s.b_insns.load(Relaxed), s.a_wait_us.load(Relaxed), s.b_wait_us.load(Relaxed), s.b_gate_us.load(Relaxed), s.a_sleeps.load(Relaxed)]
    }
}

impl Drop for Mt {
    fn drop(&mut self) {
        let s = &self.shared;
        s.quit.store(true, Release);
        s.stop.store(true, Release);
        // (the Soc is being dropped by A: whatever B was waiting for it for, it may have)
        s.gate.store(GATE_FREE, Release);
        *s.job.lock().unwrap_or_else(|e| e.into_inner()) = None;
        if let Some(h) = self.handle.take() {
            h.join(s);
        } else if cfg!(target_arch = "wasm32") {
            // (a Worker that was started but never given a job: it leaves when it sees `quit`)
            if let Some(t) = s.thread.lock().unwrap_or_else(|e| e.into_inner()).as_ref() { sys::unpark(t); }
        }
    }
}

/// Core 1's thread: std's on a computer.
#[cfg(not(target_arch = "wasm32"))]
struct Handle(std::thread::JoinHandle<()>);
#[cfg(not(target_arch = "wasm32"))]
impl Handle {
    fn thread(&self) -> Option<Th> { Some(self.0.thread().clone()) }
    fn join(self, s: &Shared) {
        while !self.0.is_finished() {
            s.gate.store(GATE_FREE, Release);
            self.0.thread().unpark();
            sys::yield_now();
        }
        let _ = self.0.join();
    }
}
#[cfg(not(target_arch = "wasm32"))]
fn spawn(sh: Arc<Shared>) -> Handle {
    Handle(std::thread::Builder::new().name("fm1-core1".into()).spawn(move || worker(sh)).expect("core 1's thread"))
}

/// On wasm the Worker is asked for when the machine is made (`Mt::new`) and runs `worker_main`
/// by itself: a start only wakes it.
#[cfg(target_arch = "wasm32")]
struct Handle;
#[cfg(target_arch = "wasm32")]
impl Handle {
    fn thread(&self) -> Option<Th> { None }
    /// leaves when the Worker has: a bounded wait, because the audio thread must not hang on a dead Worker
    fn join(self, s: &Shared) {
        let t0 = Tm::now();
        while s.up.load(Acquire) && !s.done.load(Acquire) && t0.elapsed() < Duration::from_millis(100) {
            s.gate.store(GATE_FREE, Release);
            if let Some(t) = s.thread.lock().unwrap_or_else(|e| e.into_inner()).as_ref() { sys::unpark(t); }
            sys::yield_now();
        }
    }
}
#[cfg(target_arch = "wasm32")]
fn spawn(_: Arc<Shared>) -> Handle { Handle }

/// The page's Worker, once the host has started it with the address `fm1_core1_spawn` gave: runs
/// core 1's thread until the machine is dropped. The caller has set up this thread's stack and
/// thread-local block in the shared memory.
///
/// SAFETY: `ptr` is what `Mt::new` passed to `fm1_core1_spawn`.
#[cfg(target_arch = "wasm32")]
pub unsafe fn worker_main(ptr: u32) {
    let sh = Arc::from_raw(ptr as *const Shared);
    sys::allow_blocking();
    *sh.thread.lock().unwrap_or_else(|e| e.into_inner()) = Some(sys::current());
    sh.up.store(true, Release);
    worker(Arc::clone(&sh));
    sh.done.store(true, Release);
}

/// Where the two-thread mode can run at all in this build.
pub const AVAILABLE: bool = cfg!(any(not(target_arch = "wasm32"), target_feature = "atomics"));

impl Soc {
    /// `threads` = 2 runs core 1 on its own thread once the firmware releases it (see `mt.rs`;
    /// `machine::settle` stops it); 1 runs both cores on the caller's thread as always. Returns
    /// false, and stays one thread, where it cannot: wasm, or with the flash cache model
    /// (FM1_STRICT), flaky core 1 or timed LCD, whose costs the threads do not model.
    pub fn set_threads(&mut self, threads: u32) -> bool {
        if threads < 2 {
            self.mt = None;
            return true;
        }
        if !AVAILABLE || self.xip_cache.is_some() || self.flaky_core1.is_some() {
            return false;
        }
        if self.mt.is_none() {
            self.mt = Some(Mt::new());
        }
        true
    }

    /// Is core 1 on its own thread (running or not)?
    pub fn threaded(&self) -> bool {
        self.mt.is_some()
    }

    /// Starts core 1's thread on `c1` (the machine's second core) if it is not running.
    pub(crate) fn mt_start(&mut self, c1: &mut Cpu) {
        let job = Job {
            cpu: c1,
            soc: self,
            ram: self.ram.view(),
            mem: Bus::jit_mem(self).expect("jit mem"),
            xip: self.xip.as_ptr(),
            xip_len: self.xip.len(),
        };
        let mut mt = self.mt.take().expect("mt");
        let sh = Arc::clone(&mt.shared);
        sh.start(job, self, &mut mt.handle);
        self.mt = Some(mt);
    }
}

// ---------------------------------------------------------------- thread B

fn worker(sh: Arc<Shared>) {
    loop {
        while sh.state.load(Acquire) != RUNNING {
            if sh.quit.load(Acquire) {
                return;
            }
            sys::park();
        }
        let job = sh.job.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(job) = job {
            // SAFETY: see `Job`
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { session(&sh, job) }));
            let err = match r {
                Ok(Ok(())) => None,
                Ok(Err(e)) => Some(e),
                Err(p) => Some(format!("cpu1: panic: {}", p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_default())),
            };
            if let Some(e) = err {
                // stopped for good until a reset: A takes the fault, and B waits to be told to stop
                *sh.fault.lock().unwrap_or_else(|e| e.into_inner()) = Some(e);
                sh.fault_flag.store(true, Release);
                sh.b_live.store(false, Release);
                sleep_until(&sh, || sh.stop.load(Acquire) || sh.quit.load(Acquire));
            }
        }
        sh.b_live.store(false, Release);
        sh.state.store(PARKED, Release);
    }
}

/// B asleep until `done`: woken by A's `wake` or by its own timeout.
fn sleep_until(sh: &Shared, done: impl Fn() -> bool) {
    while !done() {
        sh.sleeping.store(true, SeqCst);
        if done() {
            sh.sleeping.store(false, SeqCst);
            break;
        }
        sys::park_timeout(Duration::from_millis(1));
        sh.sleeping.store(false, SeqCst);
    }
}

enum Why {
    /// the budget ran out
    Budget,
    /// back where it started: nothing to do until something changes
    Poll,
    Idle,
    /// it wrote PR_PWR: the chip resets, and core 1 makes no more writes
    Reset,
    /// A wants it stopped or paused
    Held,
    /// `lockset` found the lock held by core 0
    Blocked,
}

/// Core 1's thread, from `start` to `quiesce`.
///
/// SAFETY: `job`'s pointers are valid for the whole session.
unsafe fn session(sh: &Shared, job: Job) -> Result<(), String> {
    let c1 = &mut *job.cpu;
    let mut live = false;
    let mut calm = 0u32;
    let mut i = 0u32;
    let mut wt: Option<Tm> = None;
    loop {
        if sh.stop.load(Acquire) {
            return Ok(());
        }
        if sh.idle.load(Acquire) && sh.irq1.load(Acquire) != 0 {
            sh.idle.store(false, Release);
        }
        if sh.paused1.load(Acquire) || sh.idle.load(Acquire) {
            sh.b_live.store(false, Release);
            sh.wake_a(u64::MAX);
            live = false;
            sleep_until(sh, || sh.stop.load(Acquire) || (!sh.paused1.load(Acquire) && (!sh.idle.load(Acquire) || sh.irq1.load(Acquire) != 0)));
            continue;
        }
        let a = sh.a_cycles.load(Acquire);
        if !live {
            // (it slept or just started: the time that passed was not its own to run)
            let b = sh.b_cycles.load(Relaxed).max(a);
            sh.b_cycles.store(b, Release);
            sh.b_live.store(true, Release);
            live = true;
        }
        let b = sh.b_cycles.load(Relaxed);
        let w = sh.window.load(Relaxed);
        if b >= a + w && !sh.a_blocked.load(Relaxed) {
            if i == 0 {
                sh.b_waits.fetch_add(1, Relaxed);
                wt = Some(Tm::now());
            }
            if i < SPINS {
                backoff(&mut i);
            } else {
                // asleep until A has come within half a window (`a_sync`), or a millisecond
                sh.b_wake_at.store(b.saturating_sub(w / 2), SeqCst);
                sleep_until(sh, || sh.stop.load(Acquire) || sh.a_cycles.load(Acquire) + w > b);
                sh.b_wake_at.store(u64::MAX, Relaxed);
            }
            continue;
        }
        if let Some(t) = wt.take() {
            sh.b_wait_us.fetch_add(t.elapsed().as_micros() as u64, Relaxed);
        }
        i = 0;
        let (k, why) = run_chunk(sh, c1, &job, a + w - b)?;
        let b = b + k;
        sh.b_cycles.store(b, Release);
        sh.wake_a(b);
        sh.b_insns.fetch_add(k, Relaxed);
        match why {
            Why::Budget | Why::Held => calm = 0,
            Why::Blocked => {
                // core 0 holds the lock: no clock of its own to hold A back meanwhile
                calm = 0;
                sh.b_live.store(false, Release);
                sh.wake_a(u64::MAX);
                live = false;
                let mut j = 0;
                while sh.lock.load(Acquire) == 1 && !sh.stop.load(Acquire) && !sh.paused1.load(Acquire) {
                    backoff(&mut j);
                }
            }
            Why::Idle => {
                calm = 0;
                sh.idle.store(true, Release);
            }
            Why::Reset => {
                sh.b_live.store(false, Release);
                sleep_until(sh, || sh.stop.load(Acquire));
            }
            Why::Poll => {
                // it found nothing to do: let A get ahead before it looks again (and do not hold it back meanwhile)
                calm = calm.saturating_add(1);
                let a = sh.a_cycles.load(Acquire);
                sh.b_live.store(false, Release);
                live = false;
                let target = a + if calm > 16 { LONG_NAP } else { NAP };
                let mut j = if calm > 16 { SPINS } else { 0 };
                sh.wake_a(u64::MAX); // (A may be waiting for it: it is not live now)
                let waiting = || sh.a_cycles.load(Acquire) < target && !sh.stop.load(Acquire) && sh.irq1.load(Acquire) == 0 && !sh.paused1.load(Acquire);
                while waiting() {
                    if j < SPINS {
                        backoff(&mut j);
                    } else {
                        sh.b_wake_at.store(target, SeqCst);
                        sleep_until(sh, || !waiting());
                        sh.b_wake_at.store(u64::MAX, Relaxed);
                    }
                }
            }
        }
    }
}

/// `machine::run_cpu1_in` for thread B: up to `cycles` instructions of core 1 (a stretch may run a
/// little past), stopping where it should look at what the other thread did.
unsafe fn run_chunk(sh: &Shared, c1: &mut Cpu, job: &Job, cycles: u64) -> Result<(u64, Why), String> {
    let probe = (c1.pc, c1.regs, c1.sp);
    c1.probe[..16].copy_from_slice(&c1.regs);
    c1.probe[16] = c1.sp;
    let budget = cycles.min(1 << 20);
    let mut left = budget;
    // (see run_cpu1_in: first a block at a time looking for the way back to where it started,
    // then in big stretches)
    let mut probing = 512u64;
    let mut why = Why::Budget;
    while left > 0 {
        let irq = Shared::decode(sh.irq1.load(Acquire));
        let mut bus = Core1Mt::new(sh, job);
        if let Some((irq, prio)) = irq {
            if c1.irq_ready(prio) {
                let handler = bus.read32(VEC_BASE + 4 * irq as u32);
                c1.interrupt(handler, prio);
            }
        }
        let stretch = probing > 0 && irq.is_none() && c1.jit_on && c1.stop_checks;
        let busy = if probing > 0 { 0 } else { left.min(256) };
        let span = if stretch { probing.min(left) + fm1_core::STRETCH_ROOM as u64 } else { busy };
        bus.budget = span.max(64) + 1;
        let chunk = if stretch || probing == 0 { span } else { c1.block_len_to(&mut bus, probe.0).max(1) as u64 };
        if stretch {
            c1.stop_pc = probe.0;
            c1.stop_io = 0;
        }
        let k = c1.run_fast(&mut bus, chunk as u32);
        c1.stop_pc = 0;
        let k = match k {
            Ok((0, _)) => {
                if let Err(e) = c1.step(&mut bus) {
                    return Err(format!("cpu1: {e:?} at pc {:#010x}", c1.pc));
                }
                1
            }
            Ok((k, _)) => k as u64,
            Err(e) => return Err(format!("cpu1: {e:?} at pc {:#010x}", c1.pc)),
        };
        left = left.saturating_sub(k);
        probing = probing.saturating_sub(k);
        if bus.reset {
            why = Why::Reset;
            break;
        }
        if bus.idle {
            why = Why::Idle;
            break;
        }
        if bus.blocked {
            why = Why::Blocked;
            break;
        }
        if c1.pc == probe.0 && c1.sp == probe.2 && c1.regs == probe.1 {
            why = Why::Poll;
            break;
        }
        if sh.stop.load(Relaxed) || sh.paused1.load(Relaxed) {
            why = Why::Held;
            break;
        }
    }
    Ok((budget - left, why))
}

/// Core 1's bus in the two-thread mode: RAM and XIP directly, the rest through the gate.
struct Core1Mt<'a> {
    sh: &'a Shared,
    soc: *mut Soc,
    ram: crate::ram::RamView,
    mem: JitMem,
    xip: *const u8,
    xip_len: usize,
    ram_len: usize,
    budget: u64,
    idle: bool,
    reset: bool,
    blocked: bool,
}

impl<'a> Core1Mt<'a> {
    fn new(sh: &'a Shared, job: &Job) -> Self {
        Core1Mt { sh, soc: job.soc, ram: job.ram, mem: job.mem, xip: job.xip, xip_len: job.xip_len, ram_len: job.ram.len(), budget: 0, idle: false, reset: false, blocked: false }
    }

    /// `f` on the `Soc`, when A has handed it over; then what B must know of what it did.
    #[cold]
    #[inline(never)]
    fn io<R>(&mut self, f: impl FnOnce(&mut Soc) -> R) -> R {
        self.sh.b_gate();
        // SAFETY: A is parked at a yield point, or in `yield_soc`, until `b_ungate`
        let soc = unsafe { &mut *self.soc };
        let r = f(soc);
        self.sh.publish_irq(soc);
        if soc.reset_due() {
            // (as `Core1Bus::stop_at_reset`: the chip resets now, A carries it out)
            self.reset = true;
            self.budget = self.budget.min(1);
        }
        self.sh.b_ungate();
        r
    }

    #[inline(always)]
    fn xip_at(&self, a: u32) -> Option<usize> {
        let x = a.wrapping_sub(XIP_BASE) as usize;
        (x < self.xip_len).then_some(x)
    }

    /// The word-aligned word at x, if it lies in XIP.
    #[inline(always)]
    fn xip_word(&self, x: usize) -> Option<[u8; 4]> {
        // SAFETY: x + 4 <= xip_len, the buffer outlives the session
        (x + 4 <= self.xip_len).then(|| unsafe { std::ptr::read_unaligned(self.xip.add(x) as *const [u8; 4]) })
    }
}

impl Bus for Core1Mt<'_> {
    #[inline]
    fn read8(&mut self, a: u32) -> u8 {
        let o = a.wrapping_sub(RAM_BASE) as usize;
        if o < self.ram_len {
            return self.ram.read8(o as u32);
        }
        if let Some(w) = self.xip_at(a & !3).and_then(|x| self.xip_word(x)) {
            return w[(a & 3) as usize];
        }
        self.io(|s| s.core1_read8(a))
    }
    #[inline]
    fn read16(&mut self, a: u32) -> u16 {
        let o = a.wrapping_sub(RAM_BASE) as usize;
        if a & 1 == 0 {
            if o + 2 <= self.ram_len {
                return self.ram.read16(o as u32);
            }
            if let Some(w) = self.xip_at(a & !3).and_then(|x| self.xip_word(x)) {
                let i = (a & 2) as usize;
                return u16::from_le_bytes([w[i], w[i + 1]]);
            }
        }
        self.io(|s| s.core1_read16(a))
    }
    #[inline]
    fn read32(&mut self, a: u32) -> u32 {
        if a & 3 == 0 {
            let o = a.wrapping_sub(RAM_BASE) as usize;
            if o + 4 <= self.ram_len {
                return self.ram.read32(o as u32);
            }
            if let Some(w) = self.xip_at(a).and_then(|x| self.xip_word(x)) {
                return u32::from_le_bytes(w);
            }
        }
        self.io(|s| s.core1_read32(a))
    }
    #[inline]
    fn fetch32(&mut self, a: u32) -> u32 {
        let o = a.wrapping_sub(RAM_BASE) as usize;
        if o + 4 <= self.ram_len {
            return self.ram.read32(o as u32);
        }
        if let Some(w) = self.xip_at(a).and_then(|x| self.xip_word(x)) {
            return u32::from_le_bytes(w);
        }
        self.io(|s| s.fetch32(a))
    }
    #[inline]
    fn write8(&mut self, a: u32, v: u8) {
        let o = a.wrapping_sub(RAM_BASE) as usize;
        if o < self.ram_len {
            return self.ram.write8(o as u32, v);
        }
        self.io(|s| s.write8(a, v))
    }
    #[inline]
    fn write16(&mut self, a: u32, v: u16) {
        let o = a.wrapping_sub(RAM_BASE) as usize;
        if a & 1 == 0 && o + 2 <= self.ram_len {
            return self.ram.write16(o as u32, v);
        }
        self.io(|s| s.write16(a, v))
    }
    #[inline]
    fn write32(&mut self, a: u32, v: u32) {
        let o = a.wrapping_sub(RAM_BASE) as usize;
        if a & 3 == 0 && o + 4 <= self.ram_len {
            return self.ram.write32(o as u32, v);
        }
        self.io(|s| s.write32(a, v))
    }
    fn test_set(&mut self, a: u32) -> u8 {
        let o = a.wrapping_sub(RAM_BASE) as usize;
        if o < self.ram_len {
            return self.ram.test_set(o as u32);
        }
        let old = self.read8(a);
        self.write8(a, old | 0x80);
        old
    }
    #[inline]
    fn tick(&mut self) -> bool {
        self.budget = self.budget.saturating_sub(1);
        self.budget == 0
    }
    fn irq_pending(&self) -> bool {
        self.sh.irq1.load(Acquire) != 0
    }
    fn irq_takes(&self, ready: &dyn Fn(u8) -> bool) -> bool {
        Shared::decode(self.sh.irq1.load(Acquire)).is_some_and(|(_, prio)| ready(prio))
    }
    fn ordered(&self) -> bool {
        true
    }
    fn jit_mem(&mut self) -> Option<JitMem> {
        Some(self.mem)
    }
    fn code_writes(&self) -> Option<u64> {
        Some(self.ram.code_writes())
    }
    fn code_mark(&mut self, lo: u32, hi: u32) {
        self.ram.mark_code(lo.wrapping_sub(RAM_BASE), hi.wrapping_sub(RAM_BASE));
        // (a store that took the unflagged path before the flag shows must not slip past this core's own compile)
        fence(SeqCst);
    }
    fn tick_room(&self) -> u64 {
        self.budget.saturating_sub(1)
    }
    fn add_ticks(&mut self, n: u64) {
        self.budget = self.budget.saturating_sub(n);
    }
    fn hw_lock(&mut self, core: u32, set: bool) -> bool {
        let got = self.sh.hw_lock(core, set);
        if !got {
            // the other thread holds it: look at what is asked of this one, and wait for the unlock
            self.budget = self.budget.min(1);
            self.blocked = true;
        }
        got
    }
    fn irq_window(&mut self) {
        if self.sh.irq1.load(Acquire) != 0 {
            self.budget = self.budget.min(1);
        }
    }
    fn service(&mut self) {
        self.budget = self.budget.min(1);
    }
    fn idle(&mut self, _core: u32) {
        self.idle = true;
        self.budget = self.budget.min(1);
    }
    fn next_tick_due(&self) -> bool {
        self.budget <= 1
    }
}


