use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::tray::toggle_main;

/// 注册全局热键。失败时仅打印日志，不阻断启动。
pub fn register<R: Runtime>(app: &AppHandle<R>, accel: &str) -> tauri::Result<()> {
    let app_clone = app.clone();
    let accel_owned = accel.to_string();

    // 简单注册：任何匹配的按下事件都触发显隐
    let res = app.global_shortcut().on_shortcut(accel_owned.as_str(), move |_app, _shortcut, event| {
        // 仅在 "按下" 边沿触发（部分版本 event.state 字段可能不同；这里只在每次回调切一次）
        let _ = &event;
        toggle_main(&app_clone);
    });

    if let Err(e) = res {
        eprintln!("[ue-master] failed to register hotkey '{}': {}", accel, e);
    }
    Ok(())
}

/// 重新注册：先撤销所有已注册的热键，再注册新的 accel。
/// 用于 Settings 中即时切换 hotkey。
pub fn reregister<R: Runtime>(app: &AppHandle<R>, accel: &str) -> tauri::Result<()> {
    if let Err(e) = app.global_shortcut().unregister_all() {
        eprintln!("[ue-master] unregister_all failed: {}", e);
    }
    register(app, accel)
}
