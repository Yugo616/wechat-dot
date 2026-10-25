pub struct WindowMetrics {
    pub inner: f64, pub outer: f64, pub webview: f64, pub work_area: f64, pub scale: f64,
}
pub fn content_height(height: f64, min: f64, max: f64, metrics: WindowMetrics) -> f64 {
    let inset = (metrics.inner - metrics.webview).max(0.0) / metrics.scale;
    let frame = (metrics.outer - metrics.webview).max(0.0);
    height.ceil().max(min).min(max.min((metrics.work_area - frame) / metrics.scale)) + inset
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mac_titlebar_inset_does_not_cut_off_bottom_buttons() {
        let metrics = WindowMetrics { inner: 600.0, outer: 600.0, webview: 544.0, work_area: 1672.0, scale: 2.0 };
        assert_eq!(content_height(421.0, 300.0, 720.0, metrics), 449.0);
    }
    #[test]
    fn normal_window_stays_inside_work_area() {
        let metrics = WindowMetrics { inner: 600.0, outer: 656.0, webview: 600.0, work_area: 800.0, scale: 2.0 };
        assert_eq!(content_height(600.0, 300.0, 720.0, metrics), 372.0);
    }
}
