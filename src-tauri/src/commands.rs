use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::{LaunchHistory, LaunchMode, ProjectPreset, Settings};
use crate::launcher::{build_plan, spawn, LaunchOptions};
use crate::process::{SystemStats, UeProcessInfo};
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

    // 把 Label 绑到 PID，主界面列表会实时显示
    if let Some(lbl) = req.label.as_deref().filter(|s| !s.is_empty()) {
        state.monitor.tag_launch(pid, lbl.to_string());
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

    Ok(LaunchResult { pid, history_id })
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
