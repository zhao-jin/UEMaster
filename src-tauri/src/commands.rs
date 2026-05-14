use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::{LaunchHistory, LaunchMode, ProjectPreset, Settings};
use crate::launcher::{build_plan, spawn, LaunchOptions};
use crate::process::{ProcessHistory, SystemStats, UeProcessInfo};
use crate::AppState;

type Cmd<T> = Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String { e.to_string() }

/* ───────── 进程 ───────── */

#[tauri::command]
pub fn list_processes(state: State<'_, AppState>) -> Cmd<Vec<UeProcessInfo>> {
    Ok(state.monitor.snapshot())
}

#[tauri::command]
pub fn get_system_stats(state: State<'_, AppState>) -> Cmd<SystemStats> {
    Ok(state.monitor.system_stats())
}

/// 详情页用：拉单个 PID 的完整 history（最多 7200 条）
#[tauri::command]
pub fn get_full_process(state: State<'_, AppState>, pid: u32) -> Cmd<Option<UeProcessInfo>> {
    Ok(state.monitor.snapshot_full().into_iter().find(|p| p.pid == pid))
}

/// 详情页专用：仅返回该 PID 的 history（不重新刷整张表，省 CPU）。
/// 列表 tick 推送的 history 已截断到 60 条，详情页用这个拉全量。
#[tauri::command]
pub fn get_process_history(state: State<'_, AppState>, pid: u32) -> Cmd<Option<ProcessHistory>> {
    Ok(state.monitor.history_for_pid(pid))
}

#[tauri::command]
pub fn kill_process(state: State<'_, AppState>, pid: u32, app: AppHandle) -> Cmd<()> {
    state.monitor.kill_pid(pid).map_err(err)?;
    let list = state.monitor.snapshot();
    let _ = app.emit("processes-updated", &list);
    Ok(())
}

#[tauri::command]
pub fn kill_all(state: State<'_, AppState>, pids: Vec<u32>, app: AppHandle) -> Cmd<()> {
    for pid in pids {
        let _ = state.monitor.kill_pid(pid);
    }
    let list = state.monitor.snapshot();
    let _ = app.emit("processes-updated", &list);
    Ok(())
}

#[tauri::command]
pub fn open_in_explorer(path: String) -> Cmd<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let p = PathBuf::from(&path);
        let arg = if p.is_file() { format!("/select,{}", p.display()) } else { p.display().to_string() };
        std::process::Command::new("explorer")
            .arg(arg)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(not(windows))]
    {
        let _ = path;
    }
    Ok(())
}

#[tauri::command]
pub fn read_tail_log(path: String, lines: usize) -> Cmd<String> {
    let content = std::fs::read_to_string(&path).map_err(err)?;
    let collected: Vec<&str> = content.lines().collect();
    let start = collected.len().saturating_sub(lines);
    Ok(collected[start..].join("\n"))
}

/* ───────── 项目预设 ───────── */

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Cmd<Vec<ProjectPreset>> {
    Ok(state.config.lock().projects.clone())
}

#[tauri::command]
pub fn upsert_project(state: State<'_, AppState>, project: ProjectPreset) -> Cmd<()> {
    let mut cfg = state.config.lock();
    if let Some(existing) = cfg.projects.iter_mut().find(|p| p.id == project.id) {
        *existing = project;
    } else {
        cfg.projects.push(project);
    }
    cfg.save().map_err(err)
}

#[tauri::command]
pub fn remove_project(state: State<'_, AppState>, id: String) -> Cmd<()> {
    let mut cfg = state.config.lock();
    cfg.projects.retain(|p| p.id != id);
    cfg.save().map_err(err)
}

/* ───────── 历史 ───────── */

#[tauri::command]
pub fn list_history(state: State<'_, AppState>, project_id: Option<String>) -> Cmd<Vec<LaunchHistory>> {
    let cfg = state.config.lock();
    let v: Vec<_> = cfg
        .history
        .iter()
        .filter(|h| project_id.as_deref().map_or(true, |id| h.project_id == id))
        .cloned()
        .collect();
    Ok(v)
}

#[tauri::command]
pub fn toggle_pin(state: State<'_, AppState>, id: String) -> Cmd<()> {
    let mut cfg = state.config.lock();
    if let Some(h) = cfg.history.iter_mut().find(|h| h.id == id) {
        h.pinned = !h.pinned;
    }
    cfg.save().map_err(err)
}

#[tauri::command]
pub fn remove_history(state: State<'_, AppState>, id: String) -> Cmd<()> {
    let mut cfg = state.config.lock();
    cfg.history.retain(|h| h.id != id);
    cfg.save().map_err(err)?;
    drop(cfg);
    crate::sync_history_labels(&state.config, &state.monitor);
    Ok(())
}

#[tauri::command]
pub fn rename_history(state: State<'_, AppState>, id: String, label: String) -> Cmd<()> {
    let mut cfg = state.config.lock();
    if let Some(h) = cfg.history.iter_mut().find(|h| h.id == id) {
        h.label = if label.is_empty() { None } else { Some(label) };
    }
    cfg.save().map_err(err)?;
    drop(cfg);
    crate::sync_history_labels(&state.config, &state.monitor);
    Ok(())
}

/* ───────── 启动进程 ───────── */

#[derive(Debug, Deserialize)]
pub struct LaunchRequest {
    pub project_id: String,
    pub mode: LaunchMode,
    #[serde(default)]
    pub map: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub extra_args: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub log_file: String,
    #[serde(default)]
    pub working_dir: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub save_as_template: bool,
}

#[derive(Debug, Serialize)]
pub struct LaunchResult {
    pub pid: u32,
    pub history_id: String,
    /// 启动前因为"同端口 DS 冲突"被自动 kill 的旧进程 PID 列表（仅 DS 模式可能非空）。
    /// 前端可据此提示用户："已替换 N 个旧 DS 实例"。
    #[serde(default)]
    pub replaced_pids: Vec<u32>,
}

#[tauri::command]
pub fn launch_process(
    state: State<'_, AppState>,
    app: AppHandle,
    req: LaunchRequest,
) -> Cmd<LaunchResult> {
    let project = {
        let cfg = state.config.lock();
        cfg.projects
            .iter()
            .find(|p| p.id == req.project_id)
            .cloned()
            .ok_or_else(|| "project not found".to_string())?
    };

    let opt = LaunchOptions {
        project: &project,
        mode: req.mode,
        map: &req.map,
        port: req.port,
        extra_args: &req.extra_args,
        env: req.env.clone(),
        log_file: &req.log_file,
        working_dir: &req.working_dir,
    };
    let plan = build_plan(&opt).map_err(|e| {
        let msg = format!("{:#}", e);
        eprintln!("[launch_process] build_plan failed: {}", msg);
        msg
    })?;

    // ── DS 检测：启动前清理同端口的旧 DS 进程，避免端口冲突 ──
    //
    // 注意：用户在历史里有可能 mode 选的是 "Editor"，但在 extra_args 里手动加了
    // `-server -port=...` 来跑 DS（这是 RED 项目的实际用法）。所以仅判断
    // `req.mode == DedicatedServer` 会漏掉这种情况。
    // 真实判定：mode 显式 DS  或  extra_args 里出现 -server / /server。
    //
    // 端口判定（按优先级）：
    //   1) req.port > 0
    //   2) 从 extra_args 解析 -port=NNNN / ?Port=NNNN / -Port NNNN
    //   3) UE 默认 7777
    let mut replaced_pids: Vec<u32> = Vec::new();
    let extra_lower = req.extra_args.to_ascii_lowercase();
    let extra_has_server = extra_lower
        .split_whitespace()
        .any(|tok| tok == "-server" || tok == "/server");
    let is_ds_launch = matches!(req.mode, LaunchMode::DedicatedServer) || extra_has_server;
    if is_ds_launch {
        let target_port = if req.port > 0 {
            req.port
        } else {
            crate::process::parse_port_from_cmdline(&req.extra_args).unwrap_or(7777)
        };
        // 先做一次轻量 snapshot 让 monitor 内部 cmdline 缓存更新
        let _ = state.monitor.snapshot();
        let conflict_pids = state.monitor.find_ds_pids_by_port(target_port);
        if !conflict_pids.is_empty() {
            eprintln!(
                "[launch_process] DS port {} in use by {:?}, killing first",
                target_port, conflict_pids
            );
            for old_pid in &conflict_pids {
                if let Err(e) = state.monitor.kill_pid(*old_pid) {
                    eprintln!("[launch_process] kill old DS pid={} failed: {}", old_pid, e);
                } else {
                    replaced_pids.push(*old_pid);
                }
            }
            // taskkill /T /F 是异步的，且 OS 释放 socket 也要一点时间。
            // 给 800ms 缓冲，避免新 DS bind 时撞旧的 SO_REUSEADDR 残留。
            if !replaced_pids.is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(800));
            }
        }
    }

    let pid = spawn(&plan).map_err(|e| {
        let msg = format!("spawn failed: {} (program={}, args={:?})",
            e, plan.program.display(), plan.args);
        eprintln!("[launch_process] {}", msg);
        msg
    })?;
    eprintln!(
        "[launch_process] launched pid={} program={} args={:?}",
        pid, plan.program.display(), plan.args
    );

    // 把 Label 绑到 PID，主界面列表会实时显示；同时把 PID 立刻注册为已知 UE 进程，
    // 避免要等 ~50s 全表扫描才出现在列表里 / labels 被 retain 清掉。
    if let Some(lbl) = req.label.as_deref().filter(|s| !s.is_empty()) {
        state.monitor.tag_launch(pid, lbl.to_string());
    } else {
        state.monitor.register_pid(pid);
    }

    // 历史已更新，重新同步历史 label 查找表（用户 rename / 新 label 都能立刻对老进程生效）
    crate::sync_history_labels(&state.config, &state.monitor);

    // 记录历史
    let history_id = {
        let mut cfg = state.config.lock();
        let entry = LaunchHistory {
            id: String::new(),
            project_id: req.project_id.clone(),
            mode: req.mode,
            map: req.map.clone(),
            port: req.port,
            extra_args: req.extra_args.clone(),
            env: req.env.clone(),
            log_file: req.log_file.clone(),
            working_dir: req.working_dir.clone(),
            launch_count: 0,
            last_used_at: 0,
            created_at: 0,
            pinned: req.save_as_template,
            label: req.label.clone(),
        };
        let id = cfg.record_launch(entry);
        if req.save_as_template {
            if let Some(h) = cfg.history.iter_mut().find(|h| h.id == id) {
                h.pinned = true;
            }
        }
        cfg.save().map_err(err)?;
        id
    };

    // 立即触发一次刷新
    let list = state.monitor.snapshot();
    let _ = app.emit("processes-updated", &list);

    Ok(LaunchResult { pid, history_id, replaced_pids })
}

/* ───────── 窗口 ───────── */

#[tauri::command]
pub fn hide_window(app: AppHandle) -> Cmd<()> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    Ok(())
}

/* ───────── 监控设置 ───────── */

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Cmd<Settings> {
    Ok(state.config.lock().settings.clone())
}

/// 更新部分 settings（目前主要是 refresh_interval_secs）。
/// 为前向兼容，传入字段为 Option，未提供的不修改。
#[derive(Debug, Deserialize, Default)]
pub struct SettingsPatch {
    pub refresh_interval_secs: Option<u64>,
    pub start_minimized: Option<bool>,
    pub hotkey: Option<String>,
}

#[tauri::command]
pub fn update_settings(
    state: State<'_, AppState>,
    app: AppHandle,
    patch: SettingsPatch,
) -> Cmd<Settings> {
    let mut cfg = state.config.lock();
    if let Some(v) = patch.refresh_interval_secs {
        let v = v.max(1).min(3600); // 1s 起步；最大 1 小时
        cfg.settings.refresh_interval_secs = v;
        state
            .refresh_secs
            .store(v, std::sync::atomic::Ordering::Relaxed);
    }
    if let Some(v) = patch.start_minimized {
        cfg.settings.start_minimized = v;
    }
    if let Some(v) = patch.hotkey {
        let trimmed = v.trim().to_string();
        if !trimmed.is_empty() && trimmed != cfg.settings.hotkey {
            // 先尝试重新注册；成功才落库，避免坏值锁死
            if let Err(e) = crate::hotkey::reregister(&app, &trimmed) {
                return Err(format!("Failed to apply hotkey '{}': {}", trimmed, e));
            }
            cfg.settings.hotkey = trimmed;
        }
    }
    cfg.save().map_err(err)?;
    Ok(cfg.settings.clone())
}
