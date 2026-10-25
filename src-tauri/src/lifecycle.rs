use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Default)]
pub struct ExitGate(AtomicU8);
impl ExitGate {
    pub fn begin(&self) -> bool { self.0.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_ok() }
    pub fn stopping(&self) -> bool { self.0.load(Ordering::SeqCst) != 0 }
    pub fn ready(&self) -> bool { self.0.load(Ordering::SeqCst) == 2 }
    pub fn finish(&self) { self.0.store(2, Ordering::SeqCst); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_quit_waits_until_backend_cleanup_finishes() {
        let gate = ExitGate::default();
        assert!(!gate.ready()); assert!(gate.begin());
        assert!(!gate.begin()); assert!(!gate.ready());
        gate.finish(); assert!(gate.ready()); assert!(!gate.begin());
    }
}
