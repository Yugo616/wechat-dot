use std::sync::{Arc, OnceLock};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, LogicalSize, PhysicalPosition, menu::{Menu, MenuItem, PredefinedMenuItem, Submenu}, tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState}};
use tauri_plugin_opener::OpenerExt;
use crate::backend::{self, Backend};
use crate::layout::{content_height, WindowMetrics};

pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
}
fn action(app: &AppHandle, name: &str) {
    let backend = app.state::<Arc<Backend>>().inner().clone(); let name = name.to_owned();
    tauri::async_runtime::spawn(async move { let _ = backend.request("action", json!([name])).await; });
}
pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id("main").icon(tauri::include_image!("../assets/tray.png"))
        .icon_as_template(cfg!(target_os = "macos")).tooltip("WeChat Dot").show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| { if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event { show(tray.app_handle()); } })
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "open" => show(app), "quit" => backend::shutdown(app),
                "weixin" | "dot" | "check-update" | "install-update" => { show(app); action(app, event.id.as_ref()); },
                name => action(app, name)
            }
        }).build(app)?;
    update_tray(app, &json!({}))
}
fn update_tray(app: &AppHandle, status: &Value) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id("main") else { return Ok(()) };
    let active = status["running"] == true || status["connecting"] == true;
    let ready = status["dot"] == "ready" && status["weixin"] == "ready";
    let title = status["summaryTitle"].as_str().unwrap_or("WeChat Dot");
    let item = |id: &str, label: &str, enabled| MenuItem::with_id(app, id, label, enabled, None::<&str>);
    let heading = item("heading", title, false)?;
    let open = item("open", "打开 WeChat Dot", true)?;
    let toggle = item(if active { "pause" } else { "start" }, if active { "暂停转发" } else { "开始转发" }, active || ready)?;
    let dot = item("show-dot", "打开专用窗口", status["dot"] == "ready")?;
    let login = Submenu::with_items(app, "重新登录", true, &[&item("weixin", "微信", true)?, &item("dot", "ChatGPT", true)?])?;
    let update_ready = status["update"]["phase"] == "ready";
    let update = item(if update_ready { "install-update" } else { "check-update" }, if update_ready { "重启更新" } else { "检查更新" }, true)?;
    let menu = Menu::with_items(app, &[&heading, &open, &toggle, &PredefinedMenuItem::separator(app)?, &dot, &login, &update])?;
    if status["exitAction"].is_string() { menu.append(&item("reset-exit", "恢复退出询问", true)?)?; }
    menu.append(&PredefinedMenuItem::separator(app)?)?; menu.append(&item("quit", "退出后台", true)?)?;
    tray.set_menu(Some(menu))?; tray.set_tooltip(Some(format!("WeChat Dot · {title}")))
}
fn resize(app: &AppHandle, value: &Value) {
    static CONTENT_INSET: OnceLock<f64> = OnceLock::new();
    let Some(window) = app.get_webview_window("main") else { return };
    let (Some(height), Some(width), Some(min), Some(max)) = (value["height"].as_f64(), value["windowWidth"].as_f64(), value["minContentHeight"].as_f64(), value["maxContentHeight"].as_f64()) else { return };
    let (Ok(Some(monitor)), Ok(inner), Ok(outer)) = (window.current_monitor(), window.inner_size(), window.outer_size()) else { return };
    let scale = monitor.scale_factor(); let area = monitor.work_area();
    let Ok(webview) = window.as_ref().size() else { return };
    let viewport = value["viewportHeight"].as_f64().unwrap_or(webview.height as f64 / scale);
    // Measure the titlebar once; queued content resizes must not become extra window chrome.
    let inset = CONTENT_INSET.get_or_init(|| (inner.height as f64 / scale - viewport).max(0.0));
    let view_height = inner.height as f64 - inset * scale;
    let height = content_height(height, min, max, WindowMetrics { inner: inner.height as f64, outer: outer.height as f64, webview: view_height, work_area: area.size.height as f64, scale });
    let _ = window.set_size(LogicalSize::new(width, height));
    if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
        let bottom = area.position.y + area.size.height as i32;
        if position.y + size.height as i32 > bottom { let _ = window.set_position(PhysicalPosition::new(position.x, (bottom - size.height as i32).max(area.position.y))); }
    }
}
pub fn event(app: &AppHandle, backend: &Arc<Backend>, message: &Value) {
    let value = &message["value"];
    match message["event"].as_str() {
        Some("status") => {
            *backend.status.lock().unwrap() = value.clone(); let _ = app.emit("status", value);
            let app = app.clone(); let state = value.clone();
            let _ = app.clone().run_on_main_thread(move || { let _ = update_tray(&app, &state); });
        }
        Some("show") => show(app),
        Some("hide") => { if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); } },
        Some("resize") => resize(app, value),
        Some("quit") => backend::shutdown(app),
        Some("open-url") => { if let Some(url) = value.as_str() { let _ = app.opener().open_url(url, None::<&str>); } },
        Some("open-path") => { if let Some(path) = value.as_str() { let _ = app.opener().open_path(path, None::<&str>); } },
        _ => {}
    }
}
