//! Plain little-endian RAM region at address 0.
//!
//! Every access goes through relaxed atomics on the bytes, so the two-thread mode (`mt.rs`) can
//! have core 1's thread read and write the same memory as core 0's (as both cores do on the chip)
//! without a data race in Rust's terms. On the hosts we build for (aarch64, x86, wasm) an aligned
//! relaxed atomic is the plain load or store, so the one-thread path costs nothing.

use std::sync::atomic::{AtomicU16, AtomicU32, AtomicU64, AtomicU8, Ordering::*};

const _: () = assert!(cfg!(target_endian = "little"));

pub struct Ram {
    /// the bytes, held as words so the pointer into them is 4-aligned (`RamView`)
    data: Vec<u32>,
    len: usize,
    /// Per 4-byte word: holds code the CPU has built blocks from (`mark_code`). The wasm JIT's
    /// inline stores read it too (`code_ptr`): a store to such a word takes the bus instead.
    /// (Words, not pages: the stock firmware's cpu1 keeps data next to its RAM code, and with
    /// 256-byte pages its stores all took the bus and left the compiled code: 2.7x slower.)
    code: Vec<AtomicU8>,
    /// Writes to code words so far: while it stays the same, no block built from RAM can have
    /// changed (the CPU skips comparing their bytes with memory). Boxed: a `RamView` points at it.
    code_writes: Box<AtomicU64>,
}

/// The RAM as raw parts, for a thread that has no `&Soc` (core 1's, in the two-thread mode): the
/// same operations as `Ram`'s, through `&self`. It stays valid as long as the `Ram` it came from
/// is alive (its buffers never move).
#[derive(Clone, Copy)]
pub struct RamView {
    data: *mut u8,
    len: usize,
    code: *const AtomicU8,
    writes: *const AtomicU64,
}

// SAFETY: the pointers are to buffers that outlive the view and are only touched through atomics
unsafe impl Send for RamView {}
unsafe impl Send for Ram {}

impl RamView {
    #[inline(always)]
    fn at(&self, a: usize) -> &AtomicU8 {
        assert!(a < self.len);
        // SAFETY: in bounds, and the bytes live as long as the Ram
        unsafe { &*(self.data.add(a) as *const AtomicU8) }
    }

    #[inline(always)]
    fn word(&self, a: usize) -> &AtomicU32 {
        assert!(a & 3 == 0 && a + 4 <= self.len);
        // SAFETY: in bounds and 4-aligned (the buffer is `Vec<u32>`)
        unsafe { &*(self.data.add(a) as *const AtomicU32) }
    }

    #[inline(always)]
    fn half(&self, a: usize) -> &AtomicU16 {
        assert!(a & 1 == 0 && a + 2 <= self.len);
        // SAFETY: as `word`
        unsafe { &*(self.data.add(a) as *const AtomicU16) }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    /// Bytes lo..hi hold code: their words are watched from now on. (From lo - 3: a store that
    /// reaches into a code word starts at most 3 bytes before it, and stores check the word they
    /// start in.)
    pub fn mark_code(&self, lo: u32, hi: u32) {
        let last = (hi.max(lo + 1) - 1) as usize >> 2;
        for w in (lo.saturating_sub(3) as usize >> 2)..=last.min(self.len / 4) {
            // SAFETY: the flags are `len / 4 + 1` long
            unsafe { &*self.code.add(w) }.store(1, Relaxed);
        }
    }

    /// Writes to code words so far.
    #[inline(always)]
    pub fn code_writes(&self) -> u64 {
        // SAFETY: boxed, lives as long as the Ram
        unsafe { &*self.writes }.load(Acquire)
    }

    /// Counted after the store itself: a thread that sees the new count then sees the new bytes.
    #[inline(always)]
    fn wrote(&self, a: usize) {
        // SAFETY: a < len, so a >> 2 is inside the flags
        if unsafe { &*self.code.add(a >> 2) }.load(Relaxed) != 0 {
            unsafe { &*self.writes }.fetch_add(1, Release);
        }
    }

    #[inline(always)]
    pub fn read8(&self, a: u32) -> u8 {
        self.at(a as usize).load(Relaxed)
    }

    #[inline(always)]
    pub fn read16(&self, a: u32) -> u16 {
        let a = a as usize;
        if a & 1 == 0 {
            self.half(a).load(Relaxed)
        } else {
            u16::from_le_bytes([self.at(a).load(Relaxed), self.at(a + 1).load(Relaxed)])
        }
    }

    #[inline(always)]
    pub fn read32(&self, a: u32) -> u32 {
        let a = a as usize;
        if a & 3 == 0 {
            self.word(a).load(Relaxed)
        } else {
            u32::from_le_bytes([self.at(a).load(Relaxed), self.at(a + 1).load(Relaxed), self.at(a + 2).load(Relaxed), self.at(a + 3).load(Relaxed)])
        }
    }

    #[inline(always)]
    pub fn write8(&self, a: u32, v: u8) {
        self.at(a as usize).store(v, Relaxed);
        self.wrote(a as usize);
    }

    #[inline(always)]
    pub fn write16(&self, a: u32, v: u16) {
        let a = a as usize;
        if a & 1 == 0 {
            self.half(a).store(v, Relaxed);
        } else {
            let b = v.to_le_bytes();
            self.at(a).store(b[0], Relaxed);
            self.at(a + 1).store(b[1], Relaxed);
        }
        self.wrote(a);
    }

    #[inline(always)]
    pub fn write32(&self, a: u32, v: u32) {
        let a = a as usize;
        if a & 3 == 0 {
            self.word(a).store(v, Relaxed);
        } else {
            for (i, b) in v.to_le_bytes().into_iter().enumerate() {
                self.at(a + i).store(b, Relaxed);
            }
        }
        self.wrote(a);
    }

    /// `testset`: the byte's old value, and the byte now has bit 7 set, in one atomic step.
    #[inline]
    pub fn test_set(&self, a: u32) -> u8 {
        let old = self.at(a as usize).fetch_or(0x80, AcqRel);
        if old & 0x80 == 0 {
            self.wrote(a as usize);
        }
        old
    }
}

impl Ram {
    pub fn new(size: usize) -> Self {
        let mut data = vec![0u32; size.div_ceil(4)];
        let _ = data.as_mut_ptr(); // (the buffer is never reallocated)
        Self {
            data,
            len: size,
            code: (0..size / 4 + 1).map(|_| AtomicU8::new(0)).collect(),
            code_writes: Box::new(AtomicU64::new(0)),
        }
    }

    #[inline(always)]
    pub fn view(&self) -> RamView {
        RamView { data: self.data.as_ptr() as *mut u8, len: self.len, code: self.code.as_ptr(), writes: &*self.code_writes }
    }

    pub fn mark_code(&mut self, lo: u32, hi: u32) {
        self.view().mark_code(lo, hi)
    }

    /// Host pointer to the code-word flags (the wasm JIT's inline stores).
    pub fn code_ptr(&self) -> *const u8 {
        self.code.as_ptr() as *const u8
    }

    /// Is the word a store at offset `a` starts in marked as code (a store there counts)?
    pub fn is_code(&self, a: u32) -> bool {
        self.code.get(a as usize >> 2).is_some_and(|c| c.load(Relaxed) != 0)
    }

    /// Writes to code words so far: while it stays the same, no block built from RAM can have changed.
    #[inline(always)]
    pub fn code_writes(&self) -> u64 {
        self.view().code_writes()
    }

    pub fn len(&self) -> usize {
        self.len
    }

    /// Host pointer to the bytes (the JIT's inline loads and stores).
    pub fn as_mut_ptr(&mut self) -> *mut u8 {
        self.data.as_mut_ptr() as *mut u8
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// `n` bytes from offset `addr`, when they all lie inside (a DMA source). (Core 1's thread may
    /// write meanwhile: a DMA reads what is there, as on the chip.)
    pub fn bytes(&self, addr: u32, n: u32) -> Option<&[u8]> {
        let end = (addr as usize).checked_add(n as usize)?;
        // SAFETY: inside the buffer, which lives as long as `self`
        (end <= self.len).then(|| unsafe { std::slice::from_raw_parts((self.data.as_ptr() as *const u8).add(addr as usize), n as usize) })
    }

    #[inline(always)]
    pub fn read8(&self, addr: u32) -> u8 {
        self.view().read8(addr)
    }

    #[inline(always)]
    pub fn read16(&self, addr: u32) -> u16 {
        self.view().read16(addr)
    }

    #[inline(always)]
    pub fn read32(&self, addr: u32) -> u32 {
        self.view().read32(addr)
    }

    #[inline(always)]
    pub fn write8(&mut self, addr: u32, value: u8) {
        self.view().write8(addr, value)
    }

    #[inline(always)]
    pub fn write16(&mut self, addr: u32, value: u16) {
        self.view().write16(addr, value)
    }

    #[inline(always)]
    pub fn write32(&mut self, addr: u32, value: u32) {
        self.view().write32(addr, value)
    }

    /// A word put back as it was (the polling-loop probe undoing its stores): not counted.
    pub(crate) fn restore32(&mut self, addr: u32, value: u32) {
        let (v, a) = (self.view(), addr as usize);
        for (i, b) in value.to_le_bytes().into_iter().enumerate() {
            v.at(a + i).store(b, Relaxed);
        }
    }

    /// Load raw bytes at an offset (firmware loading).
    pub fn load(&mut self, offset: u32, bytes: &[u8]) {
        let v = self.view();
        let o = offset as usize;
        assert!(o + bytes.len() <= self.len);
        for (i, b) in bytes.iter().enumerate() {
            v.at(o + i).store(*b, Relaxed);
        }
        self.code_writes.fetch_add(1, Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_all_widths() {
        let mut ram = Ram::new(64);
        ram.write32(0, 0xDEAD_BEEF);
        assert_eq!(ram.read32(0), 0xDEAD_BEEF);
        assert_eq!(ram.read16(0), 0xBEEF);
        assert_eq!(ram.read8(1), 0xBE);
        ram.write16(8, 0x1234);
        assert_eq!(ram.read8(8), 0x34);
        assert_eq!(ram.read8(9), 0x12);
    }
}
