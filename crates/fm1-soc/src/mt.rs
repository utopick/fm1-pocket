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
//! Stopping. B runs only between `Shared::start` and `Shared::quiesce`; the runner quiesces it at
//! the end of every render (`machine::settle`), so nothing outside the emulator sees core 1 in
//! the middle of a step. B parks in the thread's `park`, so a stopped core 1 costs nothing.
//!
//! The one-thread scheduler (`machine::run_dual_from`) is the default and the reference: this
//! mode runs only after `Soc::set_threads(2)`, and its output varies with the host's scheduler.
//!
//! wasm: `std::thread::spawn` panics on wasm32-unknown-unknown, so `Soc::set_threads` refuses
//! there; enabling it takes a build with atomics and shared memory, and the spawn replaced by a
//! Worker (see `spawn`, the only place that creates a thread).

use crate::{Soc, RAM_BASE, VEC_BASE, XIP_BASE};
use fm1_core::{Bus, Cpu, JitMem};
use std::sync::atomic::{fence, AtomicBool, AtomicU32, AtomicU64, Ordering::*};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle, Thread};
use std::time::Duration;

/// How far (in cycles) the cores may drift apart: 16 slices. `Soc::mt_window` overrides it.
pub const WINDOW: u64 = 16 * crate::machine::SLICE as u64;

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

/// The state both threads see. Everything here is atomic or behind a mutex.
pub struct Shared {
    gate: AtomicU32,
    /// B is waiting for the gate (A hands it over at its next chance)
    want: AtomicU32,
    /// the hardware lock: 0 free, else the owner's core + 1
    lock: AtomicU32,
    /// core 1's pending interrupt, as `pending_irq_for(1)` (0 none, else 1 | irq << 8 | prio << 16)
    irq1: AtomicU32,
    paused1: AtomicBool,
    /// core 1 asleep on `idle`, until an interrupt of its bank is pending
    idle: AtomicBool,
    a_cycles: AtomicU64,
    b_cycles: AtomicU64,
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
    thread: Mutex<Option<Thread>>,
    /// times A waited for B's clock, B for A's, B for the gate (tuning: `Mt::stats`)
    pub a_waits: AtomicU64,
    pub b_waits: AtomicU64,
    pub b_gates: AtomicU64,
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
    handle: Option<JoinHandle<()>>,
}

fn backoff(i: &mut u32) {
    if *i < 40 {
        std::hint::spin_loop();
    } else if *i < 200 {
        thread::yield_now();
    } else {
        thread::park_timeout(Duration::from_micros(50));
    }
    *i = i.saturating_add(1);
}

impl Shared {
    fn new() -> Shared {
        Shared {
            gate: AtomicU32::new(GATE_A),
            want: AtomicU32::new(0),
            lock: AtomicU32::new(0),
            irq1: AtomicU32::new(0),
            paused1: AtomicBool::new(false),
            idle: AtomicBool::new(false),
            a_cycles: AtomicU64::new(0),
            b_cycles: AtomicU64::new(0),
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
        }
    }

    pub fn set_window(&self, cycles: u64) {
        self.window.store(cycles.max(crate::machine::SLICE as u64), Relaxed);
    }

    fn wake(&self) {
        if self.sleeping.load(SeqCst) {
            if let Some(t) = self.thread.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                t.unpark();
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
        for _ in 0..64 {
            match self.lock.compare_exchange(0, me, Acquire, Relaxed) {
                Ok(_) => return true,
                Err(owner) if owner == me => return true,
                Err(_) => std::hint::spin_loop(),
            }
        }
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
        let mut i = 0;
        while self.gate.compare_exchange(GATE_FREE, GATE_B, Acquire, Relaxed).is_err() {
            backoff(&mut i);
        }
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
        let old = self.irq1.swap(w, AcqRel);
        if w != 0 && old == 0 {
            self.wake();
        }
    }

    /// A, before each slice: its clock and core 1's interrupt where B can see them, and a wait
    /// while B is more than the window behind.
    pub fn a_sync(&self, soc: &Soc) {
        self.publish_irq(soc);
        let a = soc.periph.cycles;
        self.a_cycles.store(a, Release);
        self.yield_soc();
        let w = self.window.load(Relaxed);
        let mut i = 0;
        while self.b_live.load(Acquire) && self.state.load(Acquire) == RUNNING && a > self.b_cycles.load(Acquire) + w {
            if i == 0 {
                self.a_waits.fetch_add(1, Relaxed);
            }
            self.yield_soc();
            backoff(&mut i);
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
    fn start(self: &Arc<Self>, job: Job, soc: &Soc, handle: &mut Option<JoinHandle<()>>) {
        if self.state.load(Acquire) == RUNNING {
            // (the same machine, or the runner would have quiesced: a different one is a bug)
            return;
        }
        let a = soc.periph.cycles;
        *self.job.lock().unwrap_or_else(|e| e.into_inner()) = Some(job);
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
            *self.thread.lock().unwrap_or_else(|e| e.into_inner()) = Some(h.thread().clone());
            *handle = Some(h);
        } else if let Some(t) = self.thread.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            t.unpark();
        }
    }

    /// Stops B and waits until it is parked, with the `Soc` and the `Cpu` as it left them.
    pub fn quiesce(&self) {
        if self.state.load(Acquire) == PARKED {
            return;
        }
        self.stop.store(true, Release);
        let mut i = 0;
        while self.state.load(Acquire) != PARKED {
            if let Some(t) = self.thread.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                t.unpark();
            }
            self.yield_soc();
            backoff(&mut i);
        }
        self.stop.store(false, Relaxed);
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
        Mt { shared: Arc::new(sh), handle: None }
    }

    /// (cores 1's time in the window waits, for tuning) A's waits for B, B's for A, B's for the `Soc`
    pub fn stats(&self) -> (u64, u64, u64) {
        let s = &self.shared;
        (s.a_waits.load(Relaxed), s.b_waits.load(Relaxed), s.b_gates.load(Relaxed))
    }
}

impl Drop for Mt {
    fn drop(&mut self) {
        let s = &self.shared;
        s.quit.store(true, Release);
        s.stop.store(true, Release);
        // (the Soc is being dropped by A: whatever B was waiting for it for, it may have)
        s.gate.store(GATE_FREE, Release);
        if let Some(h) = self.handle.take() {
            while !h.is_finished() {
                s.gate.store(GATE_FREE, Release);
                h.thread().unpark();
                thread::yield_now();
            }
            let _ = h.join();
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn spawn(sh: Arc<Shared>) -> JoinHandle<()> {
    thread::Builder::new().name("fm1-core1".into()).spawn(move || worker(sh)).expect("core 1's thread")
}

#[cfg(target_arch = "wasm32")]
fn spawn(_: Arc<Shared>) -> JoinHandle<()> {
    unreachable!("`Soc::set_threads` refuses on wasm32")
}

/// Where the two-thread mode can run at all in this build.
pub const AVAILABLE: bool = cfg!(not(target_arch = "wasm32"));

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
            thread::park();
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
        thread::park_timeout(Duration::from_millis(1));
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
}

/// Core 1's thread, from `start` to `quiesce`.
///
/// SAFETY: `job`'s pointers are valid for the whole session.
unsafe fn session(sh: &Shared, job: Job) -> Result<(), String> {
    let c1 = &mut *job.cpu;
    let mut live = false;
    let mut calm = 0u32;
    let mut i = 0u32;
    loop {
        if sh.stop.load(Acquire) {
            return Ok(());
        }
        if sh.idle.load(Acquire) && sh.irq1.load(Acquire) != 0 {
            sh.idle.store(false, Release);
        }
        if sh.paused1.load(Acquire) || sh.idle.load(Acquire) {
            sh.b_live.store(false, Release);
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
        if b >= a + w {
            if i == 0 {
                sh.b_waits.fetch_add(1, Relaxed);
            }
            backoff(&mut i);
            continue;
        }
        i = 0;
        let (k, why) = run_chunk(sh, c1, &job, a + w - b)?;
        let b = b + k;
        sh.b_cycles.store(b, Release);
        match why {
            Why::Budget | Why::Held => calm = 0,
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
                let mut j = if calm > 16 { 200 } else { 0 };
                while sh.a_cycles.load(Acquire) < target && !sh.stop.load(Acquire) && sh.irq1.load(Acquire) == 0 && !sh.paused1.load(Acquire) {
                    backoff(&mut j);
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
}

impl<'a> Core1Mt<'a> {
    fn new(sh: &'a Shared, job: &Job) -> Self {
        Core1Mt { sh, soc: job.soc, ram: job.ram, mem: job.mem, xip: job.xip, xip_len: job.xip_len, ram_len: job.ram.len(), budget: 0, idle: false, reset: false }
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
            // the other thread holds it: let it run, and look at what is asked of this one
            self.budget = self.budget.min(1);
            thread::yield_now();
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
