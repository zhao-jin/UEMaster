use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};

pub fn setup<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let handle = app.handle().clone();

    let show  = MenuItem::with_id(&handle, "show", "Show / Hide", true, None::<&str>)?;
    let new_p = MenuItem::with_id(&handle, "new",  "New Process",  true, None::<&str>)?;
    let sep   = PredefinedMenuItem::separator(&handle)?;
    let quit  = MenuItem::with_id(&handle, "quit", "Quit",        true, None::<&str>)?;

    let menu = Menu::with_items(&handle, &[&show, &new_p, &sep, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .map(|img| img.to_owned())
        .unwrap_or_else(default_icon);

    let _tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("UE Master — Alt+`")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_main(app),
            "new" => {
                show_main(app);
                let _ = app.emit("open-new-dialog", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

pub fn toggle_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
            let _ = win.unminimize();
        }
    }
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.unminimize();
    }
}

/// 兜底图标（1x1 透明 png 占位）
fn default_icon() -> tauri::image::Image<'static> {
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    tauri::image::Image::from_bytes(PNG).expect("default icon")
}
