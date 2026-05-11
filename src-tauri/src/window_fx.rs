use tauri::{Runtime, WebviewWindow};

/// 主窗口已设为不透明，不再应用 Mica/Acrylic。
/// 保留函数签名以便后续按需开启（例如设置页里的"启用毛玻璃背景"开关）。
pub fn apply_effects<R: Runtime>(_win: &WebviewWindow<R>) {}
