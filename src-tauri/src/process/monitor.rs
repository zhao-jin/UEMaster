use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Instant;

use parking_lot::Mutex;
use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use super::identify::{identify, UeKind};
use super::iocounters::{close_io_handle, read_io_bytes_cached, IoHandle};
#[cfg(windows)]
use super::cmdline::full_cmdline_for_pid;
#[cfg(windows)]
use super::gpu::GpuSampler;

/// 历史样本数量上限（足够长：@2s 是 4 小时，@5s 是 10 小时）。
/// 进程终止后整个 PerProcState 会被回收，单进程峰值内存约 7200 × 3 × 4B ≈ 86KB
const HISTORY_LEN: usize = 7200;

/// 普通 tick 推送给前端的 history 长度上限（节省 IPC 流量）。
/// 详情页通过 get_process_history 单独按 PID 拉全量。
const PUSH_HISTORY_TAIL: usize = 60;

/// 多少轮 tick 才做一次"全表扫描"以发现新 UE 进程。
/// 平时只刷已知 UE 进程的 PID，开销显著降低。
const FULL_SCAN_EVERY: u32 = 10;

/// 历史 label 的命令行匹配规则。
///
/// 规则维度（小写、空白 normalize 后比对）：
///   - `must_contain`：cmdline 必须包含的子串（多个，全部满足才算匹配）
///   - `must_not_contain`：cmdline 必须不包含的子串（多个，任一命中即不匹配）
///
/// 这样能优雅表达"DS 启动 = uproject 路径 ∧ -server"、
/// "Editor 启动 = uproject 路径 ∧ ¬-server" 等组合，避免引入 mode 概念到 monitor 层。
#[derive(Debug, Clone)]
pub struct HistoryLabelRule {
    pub must_contain: Vec<String>,
    pub must_not_contain: Vec<String>,
    pub label: String,
}

impl HistoryLabelRule {
    /// 单一子串规则的便捷构造（最常见的 case：直接拿 extra_args 当 key）
    pub fn single(needle: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            must_contain: vec![needle.into()],
            must_not_contain: Vec::new(),
            label: label.into(),
        }
    }

    /// `cmd_norm` 应已 to_lowercase + normalize_ws；规则内字符串自身也会做相同处理。
    fn matches(&self, cmd_norm: &str) -> bool {
        for s in &self.must_contain {
            let n = normalize_ws(&s.to_lowercase());
            if n.is_empty() || !cmd_norm.contains(&n) {
                return false;
            }
        }
        for s in &self.must_not_contain {
            let n = normalize_ws(&s.to_lowercase());
            if !n.is_empty() && cmd_norm.contains(&n) {
                return false;
            }
        }
        true
    }
}

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

/// 每个进程的采样状态（环形 history + 静态字段缓存 + Win32 句柄缓存）
struct PerProcState {
    last_io_bytes: u64,
    last_sample_at: Instant,
    /// 用 VecDeque 实现 O(1) 滑窗
    cpu_hist: VecDeque<f32>,
    mem_hist: VecDeque<u32>,
    io_hist: VecDeque<u32>,
    /// 命令行：进程一旦确定就不会变，缓存避免重复 PEB 调用
    cached_cmdline: Option<String>,
    /// 项目名：靠 cmdline + cwd 解析，结果缓存避免每 2s 扫磁盘
    cached_project: Option<Option<String>>,
    /// exe 路径：sysinfo 用 OnlyIfNotSet 拿到一次后缓存
    cached_exe: Option<String>,
    /// cwd：sysinfo 偶尔会拿不到；首次拿到就缓存
    cached_cwd: Option<Option<String>>,
    /// 名称：进程生命期内不变，缓存
    cached_name: Option<String>,
    /// kind 经过 cmdline 精修后的最终结果，缓存
    cached_kind: Option<UeKind>,
    /// start_time：进程生命期内不变，缓存
    cached_start_time: Option<u64>,
    /// 历史 label 匹配结果：根据 cmdline 一次定下，缓存
    cached_history_label: Option<Option<String>>,
    /// 历史 label 表的版本号；版本变了要重算 cached_history_label
    history_label_version: u64,
    /// IO 用的进程句柄；首次成功 OpenProcess 后缓存，进程退出时统一释放
    io_handle: IoHandle,
}

impl PerProcState {
    fn new() -> Self {
        Self {
            last_io_bytes: 0,
            last_sample_at: Instant::now(),
            cpu_hist: VecDeque::with_capacity(HISTORY_LEN),
            mem_hist: VecDeque::with_capacity(HISTORY_LEN),
            io_hist: VecDeque::with_capacity(HISTORY_LEN),
            cached_cmdline: None,
            cached_project: None,
            cached_exe: None,
            cached_cwd: None,
            cached_name: None,
            cached_kind: None,
            cached_start_time: None,
            cached_history_label: None,
            history_label_version: 0,
            io_handle: IoHandle::new(),
        }
    }

    fn push(&mut self, cpu: f32, mem_mb: u32, io_kbps: u32) {
        push_capped(&mut self.cpu_hist, cpu, HISTORY_LEN);
        push_capped(&mut self.mem_hist, mem_mb, HISTORY_LEN);
        push_capped(&mut self.io_hist, io_kbps, HISTORY_LEN);
    }

    /// 取尾部 n 条样本（None = 全量）
    fn snapshot_history(&self, tail: Option<usize>) -> ProcessHistory {
        match tail {
            Some(n) if self.cpu_hist.len() > n => {
                let start = self.cpu_hist.len() - n;
                ProcessHistory {
                    cpu: self.cpu_hist.iter().skip(start).copied().collect(),
                    mem_mb: self.mem_hist.iter().skip(start).copied().collect(),
                    io_kbps: self.io_hist.iter().skip(start).copied().collect(),
                }
            }
            _ => ProcessHistory {
                cpu: self.cpu_hist.iter().copied().collect(),
                mem_mb: self.mem_hist.iter().copied().collect(),
                io_kbps: self.io_hist.iter().copied().collect(),
            },
        }
    }
}

impl Drop for PerProcState {
    fn drop(&mut self) {
        // 回收 IO 句柄
        close_io_handle(&mut self.io_handle);
    }
}

fn push_capped<T>(v: &mut VecDeque<T>, x: T, cap: usize) {
    if v.len() >= cap {
        v.pop_front();
    }
    v.push_back(x);
}

pub struct Monitor {
    sys: Mutex<System>,
    state: Mutex<HashMap<u32, PerProcState>>,
    /// 已知的 UE 进程 PID 集合 —— 平时只刷这些，每 FULL_SCAN_EVERY 轮做一次全量发现
    known_ue_pids: Mutex<HashSet<u32>>,
    /// tick 计数；用于决定是否做全量发现扫描
    tick_count: AtomicU32,
    /// PID → 用户启动时设置的 Label（"Name 标记"）。
    /// 由 commands::launch_process 调用 `tag_launch()` 写入；子进程完全消失后自动清理。
    labels: Mutex<HashMap<u32, String>>,
    /// 命令行 → Label 的匹配规则表，用于"之前启动（或外部）的进程"名字恢复。
    /// 由外层（launch_process / 定期刷新）通过 `set_history_labels()` 注入最新历史。
    /// 匹配规则见 `HistoryLabelRule::matches`。
    history_labels: Mutex<Vec<HistoryLabelRule>>,
    /// history_labels 的版本号；每次 set 时 +1，用于让缓存失效
    history_label_version: AtomicU64,
    /// 全局指标的独立 sysinfo 实例：与 process 表分开避免 process refresh 干扰 cpu/mem 节奏
    global_sys: Mutex<System>,
    #[cfg(windows)]
    gpu: GpuSampler,
}

/// 全局机器指标，喂给底部 StatBar
#[derive(Debug, Clone, Default, Serialize)]
pub struct SystemStats {
    /// 整机 CPU 占用 %（0..=100）
    pub cpu_percent: f32,
    /// 已用内存 MB
    pub mem_used_mb: u64,
    /// 总内存 MB
    pub mem_total_mb: u64,
    /// 内存占比 %（0..=100）
    pub mem_percent: f32,
    /// GPU 占用 %（0..=100）；不支持时为 None
    pub gpu_percent: Option<f32>,
}

impl Monitor {
    pub fn new() -> Self {
        let sys = System::new();
        // 注意：不在 new() 里 refresh_all，第一次 snapshot_with 会做全量扫描
        Self {
            sys: Mutex::new(sys),
            state: Mutex::new(HashMap::new()),
            known_ue_pids: Mutex::new(HashSet::new()),
            tick_count: AtomicU32::new(0),
            labels: Mutex::new(HashMap::new()),
            history_labels: Mutex::new(Vec::new()),
            history_label_version: AtomicU64::new(0),
            global_sys: Mutex::new(System::new()),
            #[cfg(windows)]
            gpu: GpuSampler::new(),
        }
    }

    /// 采样整机 CPU / 内存 / GPU 占用
    pub fn system_stats(&self) -> SystemStats {
        let mut g = self.global_sys.lock();
        // CPU 需要两次刷新之间隔一段时间才有意义；调用方按 ~1s+ 节奏调用即可
        g.refresh_cpu_usage();
        g.refresh_memory();
        let cpu_percent = g.global_cpu_usage().clamp(0.0, 100.0);
        let total = g.total_memory(); // bytes
        let used = g.used_memory();
        let mem_total_mb = total / 1024 / 1024;
        let mem_used_mb = used / 1024 / 1024;
        let mem_percent = if total > 0 {
            (used as f64 / total as f64 * 100.0) as f32
        } else {
            0.0
        };
        drop(g);

        #[cfg(windows)]
        let gpu_percent = self.gpu.sample();
        #[cfg(not(windows))]
        let gpu_percent: Option<f32> = None;

        SystemStats {
            cpu_percent,
            mem_used_mb,
            mem_total_mb,
            mem_percent,
            gpu_percent,
        }
    }

    /// 绑定 label 到某个 PID（launch 成功后调用）
    pub fn tag_launch(&self, pid: u32, label: String) {
        self.labels.lock().insert(pid, label);
    }

    /// 用历史记录构建匹配规则表。
    /// 传入的 entries 应按新鲜度排序（最新在前），这样命令行有多条匹配时取首个。
    pub fn set_history_labels(&self, rules: Vec<HistoryLabelRule>) {
        *self.history_labels.lock() = rules;
        // bump 版本号，触发各 PerProcState 的 history label 缓存失效
        self.history_label_version.fetch_add(1, Ordering::Relaxed);
    }

    /// 拍一次快照（自动刷新）—— 推送给前端列表用，history 字段被截断到 PUSH_HISTORY_TAIL
    /// 节省 IPC 序列化和拷贝开销。详情页通过 `history_for_pid` 单独按 PID 拉全量。
    pub fn snapshot(&self) -> Vec<UeProcessInfo> {
        self.snapshot_with(Some(PUSH_HISTORY_TAIL))
    }

    /// 完整 snapshot（仅在 list_processes 命令里被调用，少用）
    pub fn snapshot_full(&self) -> Vec<UeProcessInfo> {
        self.snapshot_with(None)
    }

    /// 仅返回某 PID 的完整 history（不重新刷整张表）。
    /// 详情页 5s 周期调用，数据量约 86KB / PID。
    pub fn history_for_pid(&self, pid: u32) -> Option<ProcessHistory> {
        self.state.lock().get(&pid).map(|s| s.snapshot_history(None))
    }

    /// 内部：刷新 sysinfo + 收集 UE 进程 + 算 IO/历史 + 返回快照。
    /// `history_tail` 控制返回的 history 长度（None = 全量）。
    fn snapshot_with(&self, history_tail: Option<usize>) -> Vec<UeProcessInfo> {
        // ── 决定本轮是否做"全表扫描" ──
        // 第一次（tick_count 还是 0）必须全扫一次，否则 known_ue_pids 永远是空。
        let tick = self.tick_count.fetch_add(1, Ordering::Relaxed);
        let need_full_scan = tick == 0 || tick % FULL_SCAN_EVERY == 0;

        let refresh_kind = ProcessRefreshKind::new()
            .with_cpu()
            .with_memory()
            .with_exe(sysinfo::UpdateKind::OnlyIfNotSet);

        let mut sys = self.sys.lock();

        if need_full_scan {
            // 全表刷新：发现新 UE 进程
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind);

            // 重建 known_ue_pids：遍历所有进程，识别 UE 进程
            let mut known: HashSet<u32> = HashSet::new();
            for (pid, proc) in sys.processes() {
                if identify(proc).is_ue() {
                    known.insert(pid.as_u32());
                }
            }
            *self.known_ue_pids.lock() = known;
        } else {
            // 增量刷新：只刷已知 UE 进程
            let pids: Vec<Pid> = self
                .known_ue_pids
                .lock()
                .iter()
                .map(|p| Pid::from_u32(*p))
                .collect();
            if !pids.is_empty() {
                sys.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&pids),
                    true,
                    refresh_kind,
                );
            }
        }

        // ── 收集本轮存活的 UE 进程 ──
        // 注意：增量 refresh 模式下，已死的进程会被 sysinfo 自动从表里移除，
        // 所以这里直接看 sys.process(pid) 是否还在即可。
        let known_snapshot: Vec<u32> = self.known_ue_pids.lock().iter().copied().collect();

        let mut alive: Vec<u32> = Vec::new();
        let mut dead_in_known: Vec<u32> = Vec::new();
        for pid in &known_snapshot {
            if sys.process(Pid::from_u32(*pid)).is_some() {
                alive.push(*pid);
            } else {
                dead_in_known.push(*pid);
            }
        }
        // 把已死 PID 从 known 表里剔除
        if !dead_in_known.is_empty() {
            let mut k = self.known_ue_pids.lock();
            for pid in &dead_in_known {
                k.remove(pid);
            }
        }

        // ── 收集 parent / children 关系 ──
        let mut parents: HashMap<u32, u32> = HashMap::new();
        let mut children_map: HashMap<u32, Vec<u32>> = HashMap::new();
        for pid in &alive {
            if let Some(p) = sys.process(Pid::from_u32(*pid)) {
                let parent = p.parent().map(|x| x.as_u32()).unwrap_or(0);
                parents.insert(*pid, parent);
                if parent != 0 {
                    children_map.entry(parent).or_default().push(*pid);
                }
            }
        }

        // ── 清理 state / labels 中的死 PID ──
        let alive_set: HashSet<u32> = alive.iter().copied().collect();
        {
            let mut st = self.state.lock();
            st.retain(|pid, _| alive_set.contains(pid));
            let mut lb = self.labels.lock();
            lb.retain(|pid, _| alive_set.contains(pid));
        }

        let labels_snapshot = self.labels.lock().clone();
        let cur_history_version = self.history_label_version.load(Ordering::Relaxed);
        let history_labels = self.history_labels.lock().clone();

        let now = Instant::now();
        let mut out = Vec::with_capacity(alive.len());
        let mut state = self.state.lock();

        for pid in &alive {
            let p = match sys.process(Pid::from_u32(*pid)) {
                Some(x) => x,
                None => continue,
            };
            let parent = parents.get(pid).copied().unwrap_or(0);
            let entry = state.entry(*pid).or_insert_with(PerProcState::new);

            // ── name / start_time（生命期内不变，缓存） ──
            if entry.cached_name.is_none() {
                entry.cached_name = Some(p.name().to_string_lossy().to_string());
            }
            if entry.cached_start_time.is_none() {
                entry.cached_start_time = Some(p.start_time());
            }
            let name = entry.cached_name.clone().unwrap_or_default();
            let start_time = entry.cached_start_time.unwrap_or(0);

            // ── cmdline 缓存 ──
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

            // ── exe / cwd（首次拿到就缓存） ──
            if entry.cached_exe.is_none() {
                if let Some(e) = p.exe() {
                    entry.cached_exe = Some(e.to_string_lossy().to_string());
                }
            }
            if entry.cached_cwd.is_none() {
                entry.cached_cwd = Some(p.cwd().map(|c| c.to_string_lossy().to_string()));
            }
            let exe_path = entry.cached_exe.clone().unwrap_or_default();
            let cwd_str = entry.cached_cwd.clone().unwrap_or(None);

            // ── kind 缓存（用 cmdline 精修一次定终身） ──
            if entry.cached_kind.is_none() {
                let initial = identify(p);
                entry.cached_kind = Some(refine_kind(initial, &cmdline));
            }
            let kind = entry.cached_kind.unwrap_or(UeKind::Unknown);

            // ── project_name 缓存 ──
            let project_name = if let Some(cached) = entry.cached_project.clone() {
                cached
            } else {
                let exe_path_buf = PathBuf::from(&exe_path);
                let cwd_path = cwd_str.as_deref().map(std::path::Path::new);
                let v = extract_project_name(&cmdline, &exe_path_buf, cwd_path);
                entry.cached_project = Some(v.clone());
                v
            };

            // ── history label 缓存 ──
            let history_label = if entry.history_label_version == cur_history_version
                && entry.cached_history_label.is_some()
            {
                entry.cached_history_label.clone().flatten()
            } else {
                let v = find_history_label(&cmdline, &history_labels);
                entry.cached_history_label = Some(v.clone());
                entry.history_label_version = cur_history_version;
                v
            };

            // ── IO 速率（每轮都要算；用缓存的句柄） ──
            let cur_io_bytes = read_io_bytes_cached(*pid, &mut entry.io_handle).unwrap_or(0);
            let dt = now.saturating_duration_since(entry.last_sample_at).as_secs_f64();
            let io_kbps: u32 = if dt > 0.05
                && cur_io_bytes >= entry.last_io_bytes
                && entry.last_io_bytes != 0
            {
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

            entry.push(cpu, mem_mb, io_kbps);
            let history_clone = entry.snapshot_history(history_tail);

            out.push(UeProcessInfo {
                pid: *pid,
                parent_pid: parent,
                name,
                kind,
                cmdline,
                cwd: cwd_str,
                exe_path,
                project_name,
                launch_label: labels_snapshot.get(pid).cloned().or(history_label),
                cpu_percent: cpu,
                mem_mb: mem_mb_u64,
                io_kbps,
                threads: 0,
                start_time,
                children: children_map.get(pid).cloned().unwrap_or_default(),
                history: history_clone,
            });
        }

        out.sort_by_key(|p| (kind_order(p.kind), p.pid));
        out
    }

    /// 查找命令行匹配指定端口的 DS 进程（含 -server 标记）。
    /// 仅扫缓存，不做新的全表刷新；调用前最好已经有过一次 snapshot。
    /// 端口解析口径与前端 `parsePort` 对齐：`-port=NNNN` / `-Port NNNN` /
    /// `?Port=NNNN` / `host:NNNN`，并把"未显式指定端口的 DS"视为 7777（UE 默认）。
    pub fn find_ds_pids_by_port(&self, port: u16) -> Vec<u32> {
        let st = self.state.lock();
        let mut out = Vec::new();
        for (pid, s) in st.iter() {
            let cmd = s.cached_cmdline.as_deref().unwrap_or("");
            if cmd.is_empty() { continue; }
            // 必须是 DS：要么 cached_kind 已经精修成 DedicatedServer，要么 cmdline 含 -server
            let is_ds = matches!(s.cached_kind, Some(UeKind::DedicatedServer))
                || cmdline_has_server_flag(cmd);
            if !is_ds { continue; }

            let p = parse_port_from_cmdline(cmd).unwrap_or(7777);
            if p == port {
                out.push(*pid);
            }
        }
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

    // 2 & 3) 沿父目录回溯 + 兄弟扫描（限制兄弟目录扫描数量，防止大目录拖慢）
    const MAX_SIBLINGS_PER_LEVEL: usize = 30;
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
                    let mut scanned = 0usize;
                    for e in entries.flatten() {
                        if scanned >= MAX_SIBLINGS_PER_LEVEL {
                            break;
                        }
                        let p = e.path();
                        if p.is_dir() && p.as_path() != dir {
                            scanned += 1;
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

/// 从 history_labels 中找第一条匹配当前进程 cmdline 的规则，返回 label。
/// 规则结构见 `HistoryLabelRule`。
fn find_history_label(cmdline: &str, history: &[HistoryLabelRule]) -> Option<String> {
    if cmdline.is_empty() { return None; }
    let cmd_norm = normalize_ws(&cmdline.to_lowercase());
    for rule in history {
        if rule.matches(&cmd_norm) {
            return Some(rule.label.clone());
        }
    }
    None
}

/// 把字符串里所有连续空白（含 \t \n）压缩为单个 ASCII 空格，去掉首尾空白。
fn normalize_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = true; // 避免开头空格
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push(' ');
                prev_ws = true;
            }
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    if out.ends_with(' ') { out.pop(); }
    out
}

/// 命令行是否带 `-server` / `/server` 标记（即 DS）。
fn cmdline_has_server_flag(cmdline: &str) -> bool {
    for tok in cmdline.split_whitespace() {
        let t = tok.trim_matches('"').trim_matches('\'');
        if t.eq_ignore_ascii_case("-server") || t.eq_ignore_ascii_case("/server") {
            return true;
        }
    }
    false
}

/// 从命令行解析 UE 监听端口（DS 用）。识别口径与前端 `parsePort` 一致：
///   1) `-port=NNNN` / `-port:NNNN` / `-port NNNN`（大小写不敏感）
///   2) `?Port=NNNN`（map URL 风格，UE 标准）
///   3) `host:NNNN`（127.0.0.1:7777 / 0.0.0.0:7777 / localhost:7777）
/// 任何匹配到的合法端口（1..65535）即返回；都没匹配返回 None。
pub fn parse_port_from_cmdline(cmdline: &str) -> Option<u16> {
    if cmdline.is_empty() { return None; }
    let lower = cmdline.to_ascii_lowercase();

    // 1) -port=NNNN / -port:NNNN
    if let Some(p) = find_port_after(&lower, "-port=").or_else(|| find_port_after(&lower, "-port:")) {
        return Some(p);
    }
    // 1b) -port NNNN（空白分隔）
    if let Some(idx) = lower.find("-port") {
        // 确保 "-port" 是一个独立 token 边界（前面是空白或起始）
        let prev_ok = idx == 0 || lower.as_bytes()[idx - 1].is_ascii_whitespace();
        if prev_ok {
            let after = &lower[idx + "-port".len()..];
            // 跳过空白
            let after_trim = after.trim_start();
            if after.len() != after_trim.len() {
                if let Some(num) = take_leading_digits(after_trim, 5) {
                    return Some(num);
                }
            }
        }
    }
    // 2) ?port=NNNN
    if let Some(p) = find_port_after(&lower, "?port=") {
        return Some(p);
    }
    // 3) host:NNNN
    for host in ["127.0.0.1:", "0.0.0.0:", "localhost:"] {
        if let Some(p) = find_port_after(&lower, host) {
            return Some(p);
        }
    }
    None
}

/// 找 `needle` 之后的 1..=5 位数字端口，返回有效端口（1..65535）。
fn find_port_after(haystack: &str, needle: &str) -> Option<u16> {
    let idx = haystack.find(needle)?;
    let rest = &haystack[idx + needle.len()..];
    take_leading_digits(rest, 5)
}

/// 取字符串前缀的连续数字（最多 max_len 位）作为 u16 端口；越界返回 None。
fn take_leading_digits(s: &str, max_len: usize) -> Option<u16> {
    let bytes = s.as_bytes();
    let mut end = 0usize;
    while end < bytes.len() && end < max_len && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end == 0 { return None; }
    let n: u32 = s[..end].parse().ok()?;
    if (1..=65535).contains(&n) { Some(n as u16) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_port_dash_eq() {
        assert_eq!(parse_port_from_cmdline("UE.exe foo -Port=7777 -server"), Some(7777));
        assert_eq!(parse_port_from_cmdline("-port=8000"), Some(8000));
    }

    #[test]
    fn parse_port_question_mark() {
        assert_eq!(
            parse_port_from_cmdline("UE.exe map?listen?Port=12345 -server"),
            Some(12345)
        );
    }

    #[test]
    fn parse_port_space_separated() {
        assert_eq!(parse_port_from_cmdline("UE.exe -Port 9000 -server"), Some(9000));
    }

    #[test]
    fn parse_port_host_form() {
        assert_eq!(parse_port_from_cmdline("connect 127.0.0.1:7777"), Some(7777));
    }

    #[test]
    fn parse_port_invalid() {
        assert_eq!(parse_port_from_cmdline(""), None);
        assert_eq!(parse_port_from_cmdline("UE.exe -server"), None);
        // 0 不是有效端口
        assert_eq!(parse_port_from_cmdline("-Port=0"), None);
        // 超界
        assert_eq!(parse_port_from_cmdline("-Port=70000"), None);
    }

    #[test]
    fn normalize_ws_collapses_spaces() {
        assert_eq!(normalize_ws("  a  b\tc\n d "), "a b c d");
        assert_eq!(normalize_ws("single"), "single");
        assert_eq!(normalize_ws(""), "");
    }

    #[test]
    fn label_match_extra_args_with_double_space() {
        // 复刻线上 case：history.extra_args 含 "  \"-mwtitle=...\""（双空格 + 转义引号）
        // 进程实际 cmdline 是单空格 + 普通引号
        let cmdline = r#"UE4Editor.exe RED.uproject -skipcompile -port=17777 -localds=71000 -LOG=DSRED.log "-mwtitle=RED Local DS 71000""#;
        let key = r#"-skipcompile -port=17777 -localds=71000 -LOG=DSRED.log  "-mwtitle=RED Local DS 71000""#;
        let rules = vec![HistoryLabelRule::single(key, "DS71000")];
        assert_eq!(find_history_label(cmdline, &rules).as_deref(), Some("DS71000"));
    }

    #[test]
    fn label_match_real_world_red_ds71000() {
        // 完全复刻 config.toml 里 DS71000 历史 + wmic 抓的实际命令行
        let cmdline = r#"I:\RED\LetsGoDevelop\ue4_tracking_rdcsp\Engine/Binaries/Win64/UE4Editor.exe I:\RED\LetsGoDevelop\LetsGo\RED.uproject -skipcompile -map=/Game/LetsGo/RuntimeLogicLevels/DS/LetsGo_MainLevel -server -log -nosteam -port=17777 -ds_game_type=121 -localds=71000 -startmode=1 -CustomMatchType=71000 -LOG=DSRED.log "-mwtitle=RED Local DS 71000""#;
        let key = r#"-skipcompile -map=/Game/LetsGo/RuntimeLogicLevels/DS/LetsGo_MainLevel -server -log -nosteam -port=17777 -ds_game_type=121 -localds=71000 -startmode=1 -CustomMatchType=71000 -LOG=DSRED.log  "-mwtitle=RED Local DS 71000""#;
        let rules = vec![HistoryLabelRule::single(key, "DS71000")];
        assert_eq!(
            find_history_label(cmdline, &rules).as_deref(),
            Some("DS71000"),
            "real-world DS71000 history->cmdline match must succeed"
        );
    }

    #[test]
    fn label_match_must_not_contain() {
        // Editor: uproject ∧ ¬-server ∧ ¬-game
        let editor_rule = HistoryLabelRule {
            must_contain: vec!["RED.uproject".into()],
            must_not_contain: vec!["-server".into(), "-game".into()],
            label: "Editor".into(),
        };
        let ds_rule = HistoryLabelRule {
            must_contain: vec!["RED.uproject".into(), "-server".into()],
            must_not_contain: vec![],
            label: "DS".into(),
        };
        let rules = vec![ds_rule, editor_rule]; // DS 排前面，规则按命中顺序

        // 1) 纯 Editor cmdline
        let cmd_editor = "UE4Editor.exe RED.uproject -skipcompile";
        assert_eq!(find_history_label(cmd_editor, &rules).as_deref(), Some("Editor"));
        // 2) DS cmdline
        let cmd_ds = "UE4Editor.exe RED.uproject -server -log";
        assert_eq!(find_history_label(cmd_ds, &rules).as_deref(), Some("DS"));
        // 3) Game cmdline（应该都不匹配，因为 Editor 规则排除 -game）
        let cmd_game = "UE4Editor.exe RED.uproject -game";
        assert_eq!(find_history_label(cmd_game, &rules), None);
    }
}
