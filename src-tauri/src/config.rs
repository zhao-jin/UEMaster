use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub hotkey: String,
    pub refresh_interval_secs: u64,
    pub start_minimized: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: "Alt+Q".into(),
            refresh_interval_secs: 5,
            start_minimized: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectPreset {
    pub id: String,
    pub name: String,
    pub uproject_path: String,
    #[serde(default)]
    pub engine_path: Option<String>,
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub default_args: String,
    #[serde(default)]
    pub default_map: String,
    #[serde(default = "default_port")]
    pub default_port: u16,
    #[serde(default)]
    pub log_dir: Option<String>,
    #[serde(default = "default_color")]
    pub icon_color: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

fn default_port() -> u16 { 7777 }
fn default_color() -> String { "#00E5FF".into() }

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum LaunchMode {
    Editor,
    PIE,
    Game,
    DedicatedServer,
    Client,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchHistory {
    pub id: String,
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
    pub launch_count: u32,
    #[serde(default)]
    pub last_used_at: u64,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub projects: Vec<ProjectPreset>,
    #[serde(default)]
    pub history: Vec<LaunchHistory>,
}

/// 配置查找规则（按优先级）：
///  1) **exe 所在目录**（portable 模式，便于 U 盘 / 整目录搬迁）。
///     即使首次运行时该目录不存在 config.toml，也会优先用作写入目标——只要可写。
///  2) %APPDATA%\UEMaster（兜底，作为系统级用户配置）
///
/// 选择策略在首次调用时确定一次并缓存：
///  - 如果 exe 同目录已存在 config.toml → 直接用（即便目录只读也能 load）
///  - 否则尝试在 exe 同目录写一个空文件做"可写探测"；通过则用它，否则回退 APPDATA
fn determine_config_path() -> PathBuf {
    // exe 同目录候选
    let exe_side: Option<PathBuf> = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("config.toml")));

    if let Some(side) = exe_side {
        // a) 已存在 → 直接用
        if side.exists() {
            return side;
        }
        // b) 探测写权限：试着 create + 立即删除
        if let Some(parent) = side.parent() {
            let probe = parent.join(".uemaster_write_probe");
            if std::fs::write(&probe, b"").is_ok() {
                let _ = std::fs::remove_file(&probe);
                return side;
            }
        }
    }

    // c) 兜底：APPDATA\UEMaster\config.toml
    let dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("UEMaster");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("config.toml")
}

/// 历史 APPDATA 路径（用于一次性迁移）
fn legacy_appdata_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("UEMaster")
        .join("config.toml")
}

pub fn config_path() -> PathBuf {
    use std::sync::OnceLock;
    static CACHE: OnceLock<PathBuf> = OnceLock::new();
    CACHE.get_or_init(determine_config_path).clone()
}

/// 兼容旧调用点（目前未被引用，留作公开 API 备用）
#[allow(dead_code)]
pub fn config_dir() -> PathBuf {
    config_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let path = config_path();
        // 首次启动迁移：当前 path 还不存在，但 APPDATA 旧路径有 → 复制过来
        if !path.exists() {
            let legacy = legacy_appdata_path();
            if legacy.exists() && legacy != path {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::copy(&legacy, &path);
            }
        }
        if !path.exists() {
            return Ok(Self::default());
        }
        let s = std::fs::read_to_string(&path)?;
        Ok(toml::from_str(&s)?)
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let s = toml::to_string_pretty(self)?;
        let path = config_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(path, s)?;
        Ok(())
    }

    /// 同 project_id + mode + extra_args + map + port 视为相同条目，命中则累加次数；否则新增
    pub fn record_launch(&mut self, mut entry: LaunchHistory) -> String {
        let now = now_ts();
        if let Some(existing) = self.history.iter_mut().find(|h| {
            h.project_id == entry.project_id
                && h.mode == entry.mode
                && h.map == entry.map
                && h.port == entry.port
                && h.extra_args.trim() == entry.extra_args.trim()
        }) {
            existing.launch_count = existing.launch_count.saturating_add(1);
            existing.last_used_at = now;
            if !entry.label.as_deref().unwrap_or("").is_empty() {
                existing.label = entry.label.clone();
            }
            existing.log_file = entry.log_file.clone();
            existing.working_dir = entry.working_dir.clone();
            return existing.id.clone();
        }
        if entry.id.is_empty() {
            entry.id = format!("h_{}", uuid::Uuid::new_v4().simple());
        }
        entry.created_at = now;
        entry.last_used_at = now;
        entry.launch_count = 1;
        let id = entry.id.clone();
        self.history.push(entry);
        id
    }
}

pub fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
