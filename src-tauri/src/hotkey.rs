use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::tray::toggle_main;

/// 把用户友好的 accelerator（如 "Alt+Q"、"Alt+`"）规范化为 global-hotkey 期望的格式
/// （如 "Alt+KeyQ"、"Alt+Backquote"）。
/// 同时支持已经是 W3C Code 形式的输入（KeyA/Digit5/Backquote/F1...）原样通过。
fn normalize_accel(accel: &str) -> String {
    accel
        .split('+')
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .map(|tok| {
            let upper = tok.to_uppercase();
            // 修饰键原样
            match upper.as_str() {
                "CTRL" | "CONTROL" | "ALT" | "OPTION" | "SHIFT" | "SUPER" | "META"
                | "CMD" | "COMMAND" | "CMDORCTRL" | "COMMANDORCONTROL" => {
                    return tok.to_string();
                }
                _ => {}
            }
            // 单字母 → KeyX
            if tok.len() == 1 {
                let c = tok.chars().next().unwrap();
                if c.is_ascii_alphabetic() {
                    return format!("Key{}", c.to_ascii_uppercase());
                }
                if c.is_ascii_digit() {
                    return format!("Digit{}", c);
                }
                // 标点：交给下游 parse_key 处理（它支持 ` \ [ ] - = ' ; , . /）
                return c.to_string();
            }
            // 多字符 token：原样（F1、Space、Tab、Enter、Backquote、ArrowUp 等）
            tok.to_string()
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// 注册全局热键。返回真正的注册结果（不再吞错）。
pub fn register<R: Runtime>(app: &AppHandle<R>, accel: &str) -> tauri::Result<()> {
    let app_clone = app.clone();
    let normalized = normalize_accel(accel);

    app.global_shortcut()
        .on_shortcut(normalized.as_str(), move |_app, _shortcut, _event| {
            toggle_main(&app_clone);
        })
        .map_err(|e| {
            eprintln!(
                "[ue-master] failed to register hotkey '{}' (normalized '{}'): {}",
                accel, normalized, e
            );
            tauri::Error::Anyhow(anyhow::anyhow!(
                "register hotkey '{}' failed: {}",
                normalized,
                e
            ))
        })
}

/// 重新注册：先撤销所有已注册的热键，再注册新的 accel。
/// 用于 Settings 中即时切换 hotkey。
pub fn reregister<R: Runtime>(app: &AppHandle<R>, accel: &str) -> tauri::Result<()> {
    if let Err(e) = app.global_shortcut().unregister_all() {
        eprintln!("[ue-master] unregister_all failed: {}", e);
    }
    register(app, accel)
}
