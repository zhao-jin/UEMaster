mod config;
mod process;
mod launcher;
mod tray;
mod hotkey;
mod commands;
mod window_fx;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use parking_lot::Mutex;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub config: Arc<Mutex<config::Config>>,
    pub monitor: Arc<process::Monitor>,
    /// 动态生效的刷新间隔（秒）。commands::update_settings 会直接写这里，
    /// 后台 tick 循环每轮读取，变了就重建 interval。0 表示"暂停监控"。
    pub refresh_secs: Arc<AtomicU64>,
}

/// 把 config.history 里最近使用过的条目转成"命令行关键片段 → label"对照，注入 monitor。
/// 匹配键用 `extra_args`（去掉 -log 等 DS-only 副作用）+ 项目 uproject 文件名，尽可能唯一。
pub(crate) fn sync_history_labels(
    cfg: &Arc<Mutex<config::Config>>,
    monitor: &Arc<process::Monitor>,
) {
    let cfg = cfg.lock();
    // 最近使用优先；只取 label 非空的条目
    let mut entries: Vec<&config::LaunchHistory> = cfg
        .history
        .iter()
        .filter(|h| h.label.as_deref().map_or(false, |s| !s.is_empty()))
        .collect();
    entries.sort_by_key(|h| std::cmp::Reverse(h.last_used_at));

    let mut pairs: Vec<(String, String)> = Vec::new();
    for h in entries {
        let label = h.label.clone().unwrap_or_default();
        if label.is_empty() { continue; }
        // 关键 1: 完整的 extra_args 拼 port/map（最独特）
        if !h.extra_args.trim().is_empty() {
            pairs.push((h.extra_args.trim().to_string(), label.clone()));
        }
        // 关键 2: project 的 uproject 路径 —— 同一项目不同 label 的场景下，
        // 仅靠 uproject 会误匹配，所以仅当该 label 独占该 project 时才加
        if let Some(project) = cfg.projects.iter().find(|p| p.id == h.project_id) {
            let same_project_labels: std::collections::HashSet<&str> = cfg
                .history
                .iter()
                .filter(|x| x.project_id == h.project_id)
                .filter_map(|x| x.label.as_deref().filter(|s| !s.is_empty()))
                .collect();
            if same_project_labels.len() == 1 {
                pairs.push((project.uproject_path.clone(), label));
            }
        }
    }
    monitor.set_history_labels(pairs);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 首次运行判断：config.toml 不存在 = 全新安装，首次启动直接显示主窗口
    let is_first_run = !config::config_path().exists();
    let cfg = config::Config::load().unwrap_or_default();
    let initial_refresh = cfg.settings.refresh_interval_secs.max(1);
    let cfg = Arc::new(Mutex::new(cfg));
    let monitor = Arc::new(process::Monitor::new());
    let refresh_secs = Arc::new(AtomicU64::new(initial_refresh));

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            config: cfg.clone(),
            monitor: monitor.clone(),
            refresh_secs: refresh_secs.clone(),
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_processes,
            commands::kill_process,
            commands::kill_all,
            commands::open_in_explorer,
            commands::read_tail_log,
            commands::list_projects,
            commands::upsert_project,
            commands::remove_project,
            commands::list_history,
            commands::toggle_pin,
            commands::remove_history,
            commands::rename_history,
            commands::launch_process,
            commands::hide_window,
            commands::get_settings,
            commands::update_settings,
            commands::get_system_stats,
            commands::get_full_process,
            commands::get_process_history,
        ])
        .setup(move |app| {
            // 托盘
            tray::setup(app)?;

            // 全局热键
            let hk = cfg.lock().settings.hotkey.clone();
            hotkey::register(app.handle(), &hk)?;

            // 主窗口视觉效果（Mica/Acrylic）；首次运行时直接显示并居中
            if let Some(win) = app.get_webview_window("main") {
                window_fx::apply_effects(&win);
                if is_first_run {
                    let _ = win.center();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }

            // 启动时同步一次历史 label → monitor
            sync_history_labels(&cfg, &monitor);

            // 定时推送进程列表；间隔可在运行时通过 update_settings 调整
            let app_handle = app.handle().clone();
            let monitor_tick = monitor.clone();
            let cfg_tick = cfg.clone();
            let refresh_tick = refresh_secs.clone();
            tauri::async_runtime::spawn(async move {
                let mut cur_secs = refresh_tick.load(Ordering::Relaxed).max(1);
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(cur_secs));
                interval.tick().await; // 立即触发一次
                let mut tick_count: u32 = 0;
                loop {
                    interval.tick().await;

                    // 检查用户是否调整了刷新间隔；变了就重建 interval
                    let desired = refresh_tick.load(Ordering::Relaxed).max(1);
                    if desired != cur_secs {
                        cur_secs = desired;
                        interval = tokio::time::interval(std::time::Duration::from_secs(cur_secs));
                        interval.tick().await; // 吞掉立即触发的一拍
                    }

                    tick_count = tick_count.wrapping_add(1);
                    // 每 10 次刷新同步一次 history label，保证用户改动能传递
                    if tick_count % 10 == 0 {
                        sync_history_labels(&cfg_tick, &monitor_tick);
                    }
                    // 仅当主窗口可见且未最小化时才刷新，节省资源
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let visible = win.is_visible().unwrap_or(false);
                        let minimized = win.is_minimized().unwrap_or(false);
                        if visible && !minimized {
                            let t0 = std::time::Instant::now();
                            let list = monitor_tick.snapshot();
                            let t1 = std::time::Instant::now();
                            let stats = monitor_tick.system_stats();
                            let t2 = std::time::Instant::now();
                            let _ = app_handle.emit("processes-updated", &list);
                            let _ = app_handle.emit("system-stats", &stats);
                            let t3 = std::time::Instant::now();

                            // 启用 PROFILE 环境变量时打印各阶段耗时
                            if std::env::var("UE_MASTER_PROFILE").is_ok() {
                                eprintln!(
                                    "[profile] snapshot={:>6.2}ms sysstats={:>5.2}ms emit={:>5.2}ms procs={}",
                                    (t1 - t0).as_secs_f64() * 1000.0,
                                    (t2 - t1).as_secs_f64() * 1000.0,
                                    (t3 - t2).as_secs_f64() * 1000.0,
                                    list.len()
                                );
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 关闭按钮 = 隐藏到托盘
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
