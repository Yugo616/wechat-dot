#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod desktop;
mod lifecycle;
mod layout;
use std::sync::Arc;
use serde_json::Value;
use tauri::{Manager, RunEvent, WindowEvent};
use backend::Backend;

#[tauri::command]
async fn bridge(state: tauri::State<'_, Arc<Backend>>, method: String, args: Vec<Value>) -> Result<Value, String> {
    let result = state.inner().request(&method, Value::Array(args)).await;
    if method == "status" && result.is_ok() { eprintln!("WeChat Dot interface connected"); }
    result
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| desktop::show(app)))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![bridge])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let backend = Backend::start(app.handle().clone())?;
            app.manage(backend);
            desktop::create_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close(); let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("WeChat Dot could not start");
    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            if !app.state::<Arc<Backend>>().exit_ready() { api.prevent_exit(); backend::shutdown(app); }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => desktop::show(app),
        _ => {}
    });
}
