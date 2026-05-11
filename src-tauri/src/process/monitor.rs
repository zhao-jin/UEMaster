use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

use parking_lot::Mutex;
use serde::Serialize;
use sysinfo::{ProcessRefreshKind, System};

use super::identify::{identify, UeKind};
use super::iocounters::read_io_bytes;
#[cfg(windows)]
use super::cmdline::full_cmdline_for_pid;

/// 历史样本数量上限（足够长：@2s 是 4 小时，@5s 是 10 小时）。
/// 进程终止后整个 PerProcState 会被回收，单进程峰值内存约 7200 × 3 × 4B ≈ 86KB
const HISTORY_LEN: usize = 7200;

#[derive(Debug, Clone, Default, Serialize)]
pub struct ProcessHistory {
    pub cpu: Vec<f32>,        // %
    pub mem_mb: Vec<u32>,     // MB
    pub io_kbps: Vec<u32>,    // KB/s
}

#[derive(Debug, Clone, Serialize)]
pub struct UeProcessInfo {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
    pub kind: UeKind,
    pub cmdline: String,
    pub cwd: Option<String>,
    pub exe_path: String,
    pub project_name: Option<String>,
    /// 用户在"New Process"里填的 Name，由本应用启动时记录
    pub launch_label: Option<String>,
    pub cpu_percent: f32,
    pub mem_mb: u64,
    pub io_kbps: u32,         // 当前 I/O 速率 (KB/s)
    pub threads: u32,
    pub start_time: u64,
    pub children: Vec<u32>,
    pub history: ProcessHistory,
}

/// 每个进程的采样状态：上次 IO 字节累计 + 上次采样时刻 + 历史环形 + 静态字段缓存
struct PerProcState {
    last_io_bytes: u64,
    last_sample_at: Instant,
    history: ProcessHistory,
    /// 命令行：进程一旦确定就不会变，缓存避免重复 PEB 调用
    cached_cmdline: Option<String>,
    /// 项目名：靠 cmdline + cwd 解析，结果缓存避免每 2s 扫磁盘
    cached_project: Option<Option<String>>,
    /// 历史 label 匹配结果：根据 cmdline 一次定下，缓存
    cached_history_label: Option<Option<String>>,
    /// 历史 label 表的版本号；版本变了要重算 cached_history_label
    history_label_version: u64,
}

impl PerProcState {
    fn new(initial_bytes: u64) -> Self {
        Self {
            last_io_bytes: initial_bytes,
            last_sample_at: Instant::now(),
            history: ProcessHistory::default(),
            cached_cmdline: None,
            cached_project: None,
            cached_history_label: None,
            history_label_version: 0,
        }
    }

    /// 给历史环形 push 一条样本，超长则前移
    fn push_history(&mut self, cpu: f32, mem_mb: u32, io_kbps: u32) {
        push_capped(&mut self.history.cpu, cpu, HISTORY_LEN);
        push_capped(&mut self.history.mem_mb, mem_mb, HISTORY_LEN);
        push_capped(&mut self.history.io_kbps, io_kbps, HISTORY_LEN);
    }
}

fn push_capped<T>(v: &mut Vec<T>, x: T, cap: usize) {
    if v.len() >= cap {
        v.remove(0);
    }
    v.push(x);
}

pub struct Monitor {
    sys: Mutex<System>,
    state: Mutex<HashMap<u32, PerProcState>>,
    /// PID → 用户启动时设置的 Label（"Name 标记"）。
    /// 由 commands::launch_process 调用 `tag_launch()` 写入；子进程完全消失后自动清理。
    labels: Mutex<HashMap<u32, String>>,
    /// 命令行 → Label 的查找表，用于"之前启动（或外部）的进程"名字恢复。
    /// 由外层（launch_process / 定期刷新）通过 `set_history_labels()` 注入最新历史。
    /// 匹配规则：进程的完整命令行 contains(key)
    history_labels: Mutex<Vec<(String, String)>>,
    /// history_labels 的版本号；每次 set 时 +1，用于让缓存失效
    history_label_version: std::sync::atomic::AtomicU64,
}

impl Monitor {
    pub fn new() -> Self {
        // 注意：不再用 ProcessRefreshKind::everything()，避免 sysinfo 内部解析
        // 我们用不到的字段（exe / cwd / cmd 已经手动管理 + 缓存）
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::new()
                .with_cpu()
                .with_memory()
                .with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
        );
        Self {
            sys: Mutex::new(sys),
            state: Mutex::new(HashMap::new()),
            labels: Mutex::new(HashMap::new()),
            history_labels: Mutex::new(Vec::new()),
            history_label_version: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// 绑定 label 到某个 PID（launch 成功后调用）
    pub fn tag_launch(&self, pid: u32, label: String) {
        self.labels.lock().insert(pid, label);
    }

    /// 用历史记录构建"命令行 → label"查找表。
    /// 传入的 entries 应按新鲜度排序（最新在前），这样命令行有多条匹配时取首个。
    pub fn set_history_labels(&self, entries: Vec<(String, String)>) {
        *self.history_labels.lock() = entries;
        // bump 版本号，触发各 PerProcState 的 history label 缓存失效
        self.history_label_version
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    /// 拍一次快照（自动刷新）
    pub fn snapshot(&self) -> Vec<UeProcessInfo> {
        let mut sys = self.sys.lock();
        // 只刷 CPU/MEM；exe 用 OnlyIfNotSet（首次拿到后不再重读）；cwd/cmd 完全不让 sysinfo 处理
        sys.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::new()
                .with_cpu()
                .with_memory()
                .with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
        );

        // 收集 UE 进程
        let mut all: Vec<(u32, u32, UeKind)> = Vec::new();
        let mut by_pid: HashMap<u32, &sysinfo::Process> = HashMap::new();

        for (pid, proc) in sys.processes() {
            let kind = identify(proc);
            if !kind.is_ue() {
                continue;
            }
            let parent = proc.parent().map(|p| p.as_u32()).unwrap_or(0);
            all.push((pid.as_u32(), parent, kind));
            by_pid.insert(pid.as_u32(), proc);
        }

        // 父 -> 子 索引
        let mut children_map: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, parent, _) in &all {
            if *parent != 0 {
                children_map.entry(*parent).or_default().push(*pid);
            }
        }

        // 状态表：清理已经消失的 PID，避免内存增长
        let alive: std::collections::HashSet<u32> = all.iter().map(|(p, _, _)| *p).collect();
        {
            let mut st = self.state.lock();
            st.retain(|pid, _| alive.contains(pid));
            let mut lb = self.labels.lock();
            lb.retain(|pid, _| alive.contains(pid));
        }

        let labels_snapshot = self.labels.lock().clone();
        // 仅当版本变化或某 PID 还没缓存时才会真正访问 history_labels
        let cur_history_version = self
            .history_label_version
            .load(std::sync::atomic::Ordering::Relaxed);
        let history_labels = self.history_labels.lock().clone();

        let now = Instant::now();
        let mut out = Vec::with_capacity(all.len());
        let mut state = self.state.lock();

        for (pid, parent, kind) in &all {
            if let Some(p) = by_pid.get(pid) {
                let entry = state.entry(*pid).or_insert_with(|| PerProcState::new(0));

                // ── cmdline 缓存（命令行进程生命期内不变） ──
                if entry.cached_cmdline.is_none() {
                    let cmd_vec: Vec<String> = p
                        .cmd()
                        .iter()
                        .map(|s| s.to_string_lossy().to_string())
                        .collect();
                    let mut cmdline = cmd_vec.join(" ");
                    #[cfg(windows)]
                    if cmdline.trim().is_empty() {
                        if let Some(full) = full_cmdline_for_pid(*pid) {
                            cmdline = full;
                        }
                    }
                    entry.cached_cmdline = Some(cmdline);
                }
                let cmdline = entry.cached_cmdline.clone().unwrap_or_default();

                // ── project_name 缓存（依赖 cmdline + cwd + 磁盘扫描，开销大） ──
                let project_name = if let Some(cached) = entry.cached_project.clone() {
                    cached
                } else {
                    let exe = p.exe().map(PathBuf::from).unwrap_or_default();
                    let cwd = p.cwd().map(PathBuf::from);
                    let v = extract_project_name(&cmdline, &exe, cwd.as_deref());
                    entry.cached_project = Some(v.clone());
                    v
                };

                // ── history label 缓存（按版本号失效） ──
                let history_label = if entry.history_label_version == cur_history_version {
                    entry.cached_history_label.clone().flatten()
                } else {
                    let v = find_history_label(&cmdline, &history_labels);
                    entry.cached_history_label = Some(v.clone());
                    entry.history_label_version = cur_history_version;
                    v
                };

                // ── exe / cwd 用于上报；优先用 sysinfo 已经读到的（OnlyIfNotSet） ──
                let exe_path = p
                    .exe()
                    .map(|x| x.to_string_lossy().to_string())
                    .unwrap_or_default();
                let cwd_str = p.cwd().map(|c| c.to_string_lossy().to_string());

                // ── IO 速率（每轮都要算） ──
                let cur_io_bytes = read_io_bytes(*pid).unwrap_or(0);
                let dt = now.saturating_duration_since(entry.last_sample_at).as_secs_f64();
                let io_kbps: u32 = if dt > 0.05 && cur_io_bytes >= entry.last_io_bytes && entry.last_io_bytes != 0 {
                    let delta = (cur_io_bytes - entry.last_io_bytes) as f64;
                    (delta / 1024.0 / dt).clamp(0.0, u32::MAX as f64) as u32
                } else {
                    0
                };
                entry.last_io_bytes = cur_io_bytes;
                entry.last_sample_at = now;

                let cpu = p.cpu_usage();
                let mem_mb_u64 = p.memory() / 1024 / 1024;
                let mem_mb = mem_mb_u64.min(u32::MAX as u64) as u32;

                entry.push_history(cpu, mem_mb, io_kbps);
                let history_clone = entry.history.clone();

                // ── 根据完整命令行（可能来自 PEB）再次精修 kind ──
                // identify() 只用 sysinfo 的 cmd 字段，Windows 下经常拿不到别人进程的命令行，
                // 所以 DS 可能初判成 Editor。这里用缓存的 cmdline 纠正。
                let refined_kind = refine_kind(*kind, &cmdline);

                out.push(UeProcessInfo {
                    pid: *pid,
                    parent_pid: *parent,
                    name: p.name().to_string_lossy().to_string(),
                    kind: refined_kind,
                    cmdline,
                    cwd: cwd_str,
                    exe_path,
                    project_name,
                    launch_label: labels_snapshot.get(pid).cloned().or(history_label),
                    cpu_percent: cpu,
                    mem_mb: mem_mb_u64,
                    io_kbps,
                    threads: 0,
                    start_time: p.start_time(),
                    children: children_map.get(pid).cloned().unwrap_or_default(),
                    history: history_clone,
                });
            }
        }

        out.sort_by_key(|p| (kind_order(p.kind), p.pid));
        out
    }

    /// 杀进程（含子进程树）
    #[cfg(windows)]
    pub fn kill_pid(&self, pid: u32) -> anyhow::Result<()> {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()?;
        if !status.success() {
            return Err(anyhow::anyhow!("taskkill failed: {status}"));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    pub fn kill_pid(&self, pid: u32) -> anyhow::Result<()> {
        let mut sys = self.sys.lock();
        sys.refresh_processes(
            sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
            true,
        );
        if let Some(p) = sys.process(sysinfo::Pid::from_u32(pid)) {
            p.kill();
        }
        Ok(())
    }
}

fn kind_order(k: UeKind) -> u8 {
    match k {
        UeKind::Editor => 0,
        UeKind::DedicatedServer => 1,
        UeKind::Game => 2,
        UeKind::Client => 3,
        UeKind::Helper => 4,
        UeKind::Unknown => 5,
    }
}

/// 用完整命令行再次精修 kind。
/// 关键：Windows 下 sysinfo 经常拿不到别人进程的命令行，identify() 初判
/// 只看 exe 名，会把 DS 错判为 Editor。这里基于 PEB 取到的完整 cmdline 修正。
fn refine_kind(initial: UeKind, cmdline: &str) -> UeKind {
    if cmdline.is_empty() {
        return initial;
    }
    for tok in cmdline.split_whitespace() {
        let t = tok.trim_matches('"').trim_matches('\'');
        if t.eq_ignore_ascii_case("-server") || t.eq_ignore_ascii_case("/server") {
            return UeKind::DedicatedServer;
        }
    }
    initial
}

/// 提取 UE 项目名。识别顺序：
/// 1) 命令行参数中的 `.uproject` 路径（含引号包裹和双反斜杠）
/// 2) 进程 cwd 及其向上 5 级父目录中查找 `*.uproject`
/// 3) 上述每一级父目录的【兄弟子目录】中查找 `*.uproject`
///    （处理 UE Editor cwd=Engine\Binaries\Win64 但项目在 LetsGo\ 的情况）
/// 4) 进程可执行文件名（仅当不是 UnrealEditor / UE4Editor 等引擎自带程序）
fn extract_project_name(
    cmdline: &str,
    exe: &std::path::Path,
    cwd: Option<&std::path::Path>,
) -> Option<String> {
    // 1) 命令行扫描
    for token in cmdline.split_whitespace() {
        let t = token.trim_matches('"').trim_matches('\'');
        if t.to_lowercase().contains(".uproject") {
            // 切到 .uproject 截断
            let lower = t.to_lowercase();
            let end = lower.find(".uproject").unwrap() + ".uproject".len();
            let p = std::path::Path::new(&t[..end]);
            if let Some(stem) = p.file_stem() {
                return Some(stem.to_string_lossy().to_string());
            }
        }
    }

    // 2 & 3) 沿父目录回溯 + 兄弟扫描
    if let Some(start) = cwd {
        let mut cur: Option<&std::path::Path> = Some(start);
        for _ in 0..6 {
            let dir = match cur {
                Some(d) => d,
                None => break,
            };
            // 当前目录直找
            if let Some(name) = find_uproject_in_dir(dir) {
                return Some(name);
            }
            // 兄弟目录扫描
            if let Some(parent) = dir.parent() {
                if let Ok(entries) = std::fs::read_dir(parent) {
                    for e in entries.flatten() {
                        let p = e.path();
                        if p.is_dir() && p.as_path() != dir {
                            if let Some(name) = find_uproject_in_dir(&p) {
                                return Some(name);
                            }
                        }
                    }
                }
            }
            cur = dir.parent();
        }
    }

    // 4) 兜底：可执行文件名
    if let Some(stem) = exe.file_stem() {
        let s = stem.to_string_lossy().to_string();
        let lower = s.to_lowercase();
        if !lower.starts_with("unreal") && !lower.starts_with("ue4") && !lower.starts_with("ue5") {
            return Some(s);
        }
    }
    None
}

fn find_uproject_in_dir(dir: &std::path::Path) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("uproject"))
            == Some(true)
        {
            if let Some(stem) = path.file_stem() {
                return Some(stem.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// 从 history_labels 中找第一条 key 是当前进程 cmdline 子串的条目，返回 label。
/// 匹配方向：key ⊂ cmdline（把历史的完整 extra_args 或 uproject 路径拿去 contain 进程命令行）。
fn find_history_label(cmdline: &str, history: &[(String, String)]) -> Option<String> {
    if cmdline.is_empty() { return None; }
    let cmd_low = cmdline.to_lowercase();
    for (key, label) in history {
        let k = key.trim().to_lowercase();
        if k.is_empty() { continue; }
        if cmd_low.contains(&k) {
            return Some(label.clone());
        }
    }
    None
}
