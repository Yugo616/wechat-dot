use std::sync::atomic::{AtomicU8, Ordering};
use serde_json::Value;

pub fn disconnected_status(previous: &Value) -> Value {
    let mut status = previous.clone();
    status["running"] = false.into(); status["problem"] = Value::Null;
    status["connecting"] = false.into();
    status["summaryTitle"] = "正在自动重试".into();
    status["dotRetry"] = "后台连接已断开，正在自动重试…".into();
    status
}

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
    fn backend_crash_replaces_the_forwarding_title_and_actions() {
        let status = disconnected_status(&serde_json::json!({ "running": true, "connecting": true, "summaryTitle": "正在转发", "exitAction": "minimize" }));
        assert_eq!(status["running"], false);
        assert_eq!(status["connecting"], false);
        assert_eq!(status["summaryTitle"], "正在自动重试");
        assert_eq!(status["exitAction"], "minimize");
    }
    #[test]
    fn repeated_quit_waits_until_backend_cleanup_finishes() {
        let gate = ExitGate::default();
        assert!(!gate.ready()); assert!(gate.begin());
        assert!(!gate.begin()); assert!(!gate.ready());
        gate.finish(); assert!(gate.ready()); assert!(!gate.begin());
    }
}
