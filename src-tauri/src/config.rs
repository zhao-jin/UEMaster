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

pub fn config_dir() -> PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("UEMaster");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.toml")
}

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let path = config_path();
        if !path.exists() {
            return Ok(Self::default());
        }
        let s = std::fs::read_to_string(&path)?;
        Ok(toml::from_str(&s)?)
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let s = toml::to_string_pretty(self)?;
        std::fs::write(config_path(), s)?;
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
