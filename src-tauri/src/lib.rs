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

/// 把 config.history 里最近使用过的条目转成"命令行匹配规则 → label"对照，注入 monitor。
///
/// 历史 label 注入两类规则，monitor 端按顺序取首个命中：
///   1) extra_args 完整子串（最独特，DS / 带参数 Game 都靠这个）。
///   2) (project + 语义模式) 维度的命令行特征：
///      * Editor 语义 → uproject_path ∧ ¬-server ∧ ¬-game
///      * DS 语义     → uproject_path ∧ -server
///      * Game 语义   → uproject_path ∧ -game ∧ ¬-server
///      仅当该 (project, 语义) 桶里只有 1 个非空 label 时启用，避免误匹配。
///
/// 关键：分桶用"语义模式"——例如用户在 mode=Editor 但 extra_args 含 -server 的"伪
/// DS"历史条目，会被归入 DS 桶；这样 (RED, Editor 语义) 桶里只剩纯净 Editor 一条，
/// 规则 2 才能给纯启动 RED.uproject 的 Editor 进程贴上 label。
pub(crate) fn sync_history_labels(
    cfg: &Arc<Mutex<config::Config>>,
    monitor: &Arc<process::Monitor>,
) {
    use process::HistoryLabelRule;

    /// 语义模式：表面 mode + extra_args 综合判定。
    #[derive(Clone, Copy, Eq, PartialEq, Hash, Debug)]
    enum Sem { Editor, DS, Game }

    fn semantic_mode(h: &config::LaunchHistory) -> Sem {
        let extra_lower = h.extra_args.to_ascii_lowercase();
        let has_server = extra_lower.split_whitespace().any(|t| {
            let t = t.trim_matches('"').trim_matches('\'');
            t.eq_ignore_ascii_case("-server") || t.eq_ignore_ascii_case("/server")
        });
        let has_game = extra_lower.split_whitespace().any(|t| {
            let t = t.trim_matches('"').trim_matches('\'');
            t.eq_ignore_ascii_case("-game")
        });
        if has_server { return Sem::DS; }
        match h.mode {
            config::LaunchMode::DedicatedServer => Sem::DS,
            config::LaunchMode::Editor => {
                if has_game { Sem::Game } else { Sem::Editor }
            }
            config::LaunchMode::Game
            | config::LaunchMode::PIE
            | config::LaunchMode::Client => Sem::Game,
        }
    }

    let cfg = cfg.lock();
    // 最近使用优先；只取 label 非空的条目
    let mut entries: Vec<&config::LaunchHistory> = cfg
        .history
        .iter()
        .filter(|h| h.label.as_deref().map_or(false, |s| !s.is_empty()))
        .collect();
    entries.sort_by_key(|h| std::cmp::Reverse(h.last_used_at));

    // 预统计：每个 (project_id, 语义) 下有多少条不同 label 的历史
    use std::collections::HashMap;
    let mut bucket: HashMap<(String, Sem), std::collections::HashSet<String>> =
        HashMap::new();
    for h in &cfg.history {
        if let Some(lbl) = h.label.as_deref().filter(|s| !s.is_empty()) {
            bucket
                .entry((h.project_id.clone(), semantic_mode(h)))
                .or_default()
                .insert(lbl.to_string());
        }
    }

    let mut rules: Vec<HistoryLabelRule> = Vec::new();
    for h in entries {
        let label = h.label.clone().unwrap_or_default();
        if label.is_empty() { continue; }

        // ── 规则 1：extra_args 完整子串 ──
        let trimmed = h.extra_args.trim();
        if !trimmed.is_empty() {
            rules.push(HistoryLabelRule::single(trimmed, label.clone()));
        }

        // ── 规则 2：(project, 语义) 维度特征 ──
        // 仅当该 (project, 语义) 桶里只有 1 个 label 时才启用，避免误匹配
        let sem = semantic_mode(h);
        let same_bucket = bucket
            .get(&(h.project_id.clone(), sem))
            .map(|s| s.len())
            .unwrap_or(0);
        if same_bucket != 1 { continue; }

        let project = match cfg.projects.iter().find(|p| p.id == h.project_id) {
            Some(p) => p,
            None => continue,
        };
        let uproj = project.uproject_path.clone();
        if uproj.is_empty() { continue; }

        let (must, must_not): (Vec<String>, Vec<String>) = match sem {
            Sem::Editor => (
                vec![uproj],
                vec!["-server".to_string(), "-game".to_string()],
            ),
            Sem::DS => (
                vec![uproj, "-server".to_string()],
                Vec::new(),
            ),
            Sem::Game => (
                vec![uproj, "-game".to_string()],
                vec!["-server".to_string()],
            ),
        };
        rules.push(HistoryLabelRule {
            must_contain: must,
            must_not_contain: must_not,
            label,
        });
    }
    monitor.set_history_labels(rules);
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
            commands::update_history,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_history(
        project_id: &str,
        mode: config::LaunchMode,
        extra: &str,
        label: &str,
    ) -> config::LaunchHistory {
        config::LaunchHistory {
            id: format!("h_{}_{}", project_id, label),
            project_id: project_id.into(),
            mode,
            map: String::new(),
            port: 0,
            extra_args: extra.into(),
            log_file: String::new(),
            working_dir: String::new(),
            launch_count: 1,
            last_used_at: 0,
            created_at: 0,
            pinned: false,
            label: Some(label.into()),
            env: Default::default(),
        }
    }

    fn mk_project(id: &str, uproj: &str) -> config::ProjectPreset {
        config::ProjectPreset {
            id: id.into(),
            name: id.into(),
            uproject_path: uproj.into(),
            engine_path: None,
            working_dir: None,
            default_args: String::new(),
            default_map: String::new(),
            default_port: 7777,
            log_dir: None,
            icon_color: "#fff".into(),
            tags: vec![],
        }
    }

    /// 真实场景复现：同一 project + mode=Editor，但其中一条 extra_args 含 -server
    /// 假装成 DS。原实现按表面 mode 分桶 → (RED, Editor) 桶里有 2 个 label →
    /// 规则 2 跳过 → 纯净 Editor (extra_args="") 完全失配。新实现按"语义模式"分桶：
    /// 含 -server 的归 DS 桶，纯净 Editor 单独占 Editor 桶 → 规则 2 启用。
    #[test]
    fn sync_history_labels_separates_pseudo_ds_from_editor() {
        let mut cfg = config::Config::default();
        cfg.projects.push(mk_project("proj_red", "I:\\RED\\LetsGo\\RED.uproject"));
        // mode=Editor 但 extra_args 含 -server → 语义 DS
        cfg.history.push(mk_history(
            "proj_red",
            config::LaunchMode::Editor,
            "-server -port=17777",
            "DS71001",
        ));
        // mode=Editor 且 extra_args 为空 → 语义 Editor
        cfg.history.push(mk_history(
            "proj_red",
            config::LaunchMode::Editor,
            "",
            "Editor",
        ));

        let cfg = Arc::new(Mutex::new(cfg));
        let monitor = Arc::new(process::Monitor::new());
        sync_history_labels(&cfg, &monitor);

        // 1) 纯净 Editor 命令行 → 应命中 "Editor" label
        let cmd_editor =
            "I:\\RED\\Engine\\Binaries\\Win64\\UE4Editor.exe I:\\RED\\LetsGo\\RED.uproject";
        let label = monitor.test_find_history_label(cmd_editor);
        assert_eq!(
            label.as_deref(),
            Some("Editor"),
            "纯净 Editor 命令行应该匹配到 'Editor' history label"
        );

        // 2) 含 -server 的 DS 命令行 → 应命中 "DS71001"（走规则 1 extra_args 子串）
        let cmd_ds = "I:\\RED\\Engine\\Binaries\\Win64\\UE4Editor.exe I:\\RED\\LetsGo\\RED.uproject -server -port=17777";
        let label_ds = monitor.test_find_history_label(cmd_ds);
        assert_eq!(label_ds.as_deref(), Some("DS71001"));
    }
}
