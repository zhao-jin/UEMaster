use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};

use crate::config::{LaunchMode, ProjectPreset};

pub struct LaunchPlan {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub working_dir: Option<PathBuf>,
    pub env: HashMap<String, String>,
}

pub struct LaunchOptions<'a> {
    pub project: &'a ProjectPreset,
    pub mode: LaunchMode,
    pub map: &'a str,
    pub port: u16,
    pub extra_args: &'a str,
    pub env: HashMap<String, String>,
    pub log_file: &'a str,
    pub working_dir: &'a str,
}

/// 解析 .uproject 并生成最终命令行
pub fn build_plan(opt: &LaunchOptions) -> Result<LaunchPlan> {
    let uproject = PathBuf::from(&opt.project.uproject_path);
    if !uproject.exists() {
        return Err(anyhow!(".uproject not found: {}", uproject.display()));
    }
    let project_dir = uproject
        .parent()
        .ok_or_else(|| anyhow!("invalid uproject path"))?
        .to_path_buf();

    // 推断引擎路径：优先项目预设里的，其次解析 .uproject 的 EngineAssociation
    let engine_root = if let Some(p) = opt.project.engine_path.as_deref().filter(|s| !s.is_empty()) {
        let pb = PathBuf::from(p);
        if !has_editor(&pb) {
            return Err(anyhow!(
                "engine_path is set but UnrealEditor.exe / UE4Editor.exe was not found under '{}'. \
                 Edit %APPDATA%/UEMaster/config.toml and fix the engine_path.",
                pb.display()
            ));
        }
        pb
    } else {
        find_engine_for(&uproject).ok_or_else(|| {
            anyhow!(
                "Cannot locate the engine for '{}'. \
                 Tried EngineAssociation and walking parent dirs but found no Engine/Binaries/Win64/(UnrealEditor|UE4Editor).exe. \
                 Please set 'engine_path' for this project in %APPDATA%/UEMaster/config.toml.",
                uproject.display()
            )
        })?
    };

    let editor_exe = locate_editor_exe(&engine_root)
        .ok_or_else(|| anyhow!("UnrealEditor.exe / UE4Editor.exe not found under {}", engine_root.display()))?;

    let mut args: Vec<String> = Vec::new();

    match opt.mode {
        LaunchMode::Editor => {
            args.push(uproject.to_string_lossy().to_string());
        }
        LaunchMode::PIE => {
            args.push(uproject.to_string_lossy().to_string());
            if !opt.map.is_empty() { args.push(opt.map.to_string()); }
            args.push("-game".to_string());
        }
        LaunchMode::Game => {
            args.push(uproject.to_string_lossy().to_string());
            if !opt.map.is_empty() { args.push(opt.map.to_string()); }
            args.push("-game".to_string());
        }
        LaunchMode::DedicatedServer => {
            args.push(uproject.to_string_lossy().to_string());
            let mut map_arg = opt.map.to_string();
            if opt.port > 0 {
                if map_arg.is_empty() { map_arg = "?listen".into(); }
                map_arg.push_str(&format!("?Port={}", opt.port));
            }
            if !map_arg.is_empty() { args.push(map_arg); }
            args.push("-server".to_string());
            args.push("-log".to_string());
        }
        LaunchMode::Client => {
            args.push(uproject.to_string_lossy().to_string());
            if !opt.map.is_empty() {
                args.push(opt.map.to_string());
            }
            args.push("-game".to_string());
            if opt.port > 0 {
                args.push(format!("-Port={}", opt.port));
            }
        }
    }

    // 追加 extra args（尊重用户输入，不再自动过滤 -log；UI 已不再暴露 Mode 联动）
    if !opt.extra_args.trim().is_empty() {
        for tok in shell_split(opt.extra_args) {
            args.push(tok);
        }
    }

    let working_dir = if !opt.working_dir.is_empty() {
        Some(PathBuf::from(opt.working_dir))
    } else {
        Some(project_dir.clone())
    };

    Ok(LaunchPlan {
        program: editor_exe,
        args,
        working_dir,
        env: opt.env.clone(),
    })
}

/// 启动 UE 子进程。Windows 平台直接走 Win32 `CreateProcessW`，
/// 显式设置 `bInheritHandles = FALSE`，让子进程**不继承**父进程的任何句柄
/// （包括 stdio）。这样：
///  - 父进程是 GUI 子系统、stdio=NULL 也不会传染给子进程
///  - 子进程拥有自己全新的 console（CREATE_NEW_CONSOLE），UE 的 -log 会正常输出
///  - GUI 模式（无 -log/-server）下 UE 启动后会自己 FreeConsole，黑窗一闪即逝
///
/// 非 Windows 平台仍走 std Command。
#[cfg(windows)]
pub fn spawn(plan: &LaunchPlan) -> Result<u32> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        CreateProcessW, CREATE_NEW_CONSOLE, CREATE_UNICODE_ENVIRONMENT,
        PROCESS_INFORMATION, STARTUPINFOW,
    };

    // ── 拼命令行 ──
    // CreateProcessW 接受单条命令行字符串，第一个 token 必须用引号包住程序路径
    // （路径里可能含空格），后续参数同理需要包引号。
    fn quote(arg: &str) -> String {
        if !arg.is_empty() && !arg.chars().any(|c| c == ' ' || c == '\t' || c == '"') {
            arg.to_string()
        } else {
            // 简单包引号：把内部 " 转义成 \"，反斜杠不另特殊处理（足够覆盖 UE 参数）
            let escaped = arg.replace('"', "\\\"");
            format!("\"{}\"", escaped)
        }
    }
    let mut cmdline = quote(&plan.program.to_string_lossy());
    for a in &plan.args {
        cmdline.push(' ');
        cmdline.push_str(&quote(a));
    }
    let mut cmdline_w: Vec<u16> = cmdline.encode_utf16().chain(std::iter::once(0)).collect();

    // ── working_dir（可选） ──
    let cwd_w: Option<Vec<u16>> = plan.working_dir.as_ref().map(|p| {
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    });

    // ── env block（UTF-16，"K=V\0K=V\0\0"） ──
    // 不传 env 时 CreateProcessW 会让子进程继承父环境；这里把父环境 + plan.env 合并
    let env_block: Vec<u16> = build_env_block(&plan.env);

    // ── STARTUPINFOW ──
    let mut si = STARTUPINFOW::default();
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    // 不指定 hStdInput/Output/Error，CreateProcessW + bInheritHandles=FALSE +
    // CREATE_NEW_CONSOLE 会让子进程自己拥有全新的 console。

    let mut pi = PROCESS_INFORMATION::default();

    // CREATE_UNICODE_ENVIRONMENT 表明 env_block 是 UTF-16
    let flags = CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT;

    let env_ptr: *const std::ffi::c_void = if env_block.is_empty() {
        std::ptr::null()
    } else {
        env_block.as_ptr() as *const _
    };

    let cwd_ptr: windows::core::PCWSTR = match cwd_w.as_ref() {
        Some(v) => windows::core::PCWSTR(v.as_ptr()),
        None => windows::core::PCWSTR(std::ptr::null()),
    };

    let ok = unsafe {
        CreateProcessW(
            windows::core::PCWSTR(std::ptr::null()),         // lpApplicationName: NULL，从 cmdline 取
            PWSTR(cmdline_w.as_mut_ptr()),                   // lpCommandLine
            None,                                            // lpProcessAttributes
            None,                                            // lpThreadAttributes
            false,                                           // bInheritHandles = FALSE ✱关键✱
            flags,
            Some(env_ptr),
            cwd_ptr,
            &si,
            &mut pi,
        )
    };

    if let Err(e) = ok {
        return Err(anyhow!("CreateProcessW failed: {} (cmdline={})", e, cmdline));
    }

    // 拿到 pid 后立刻关闭 process / thread 的句柄，避免泄漏
    let pid = pi.dwProcessId;
    unsafe {
        let _ = CloseHandle(pi.hThread);
        let _ = CloseHandle(pi.hProcess);
    }

    Ok(pid)
}

#[cfg(not(windows))]
pub fn spawn(plan: &LaunchPlan) -> Result<u32> {
    use std::process::Command;
    let mut cmd = Command::new(&plan.program);
    cmd.args(&plan.args);
    if let Some(cwd) = &plan.working_dir {
        cmd.current_dir(cwd);
    }
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    let child = cmd.spawn()?;
    Ok(child.id())
}

/// 把"父进程环境 + 用户传入的 env"合并成 CreateProcessW 需要的 UTF-16 `K=V\0K=V\0\0` 块。
/// 用户 env 中相同 key 会覆盖父环境。
#[cfg(windows)]
fn build_env_block(extra: &HashMap<String, String>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let mut merged: HashMap<String, String> = std::env::vars().collect();
    for (k, v) in extra {
        merged.insert(k.clone(), v.clone());
    }
    if merged.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<u16> = Vec::new();
    for (k, v) in &merged {
        let entry = format!("{}={}", k, v);
        for ch in std::ffi::OsString::from(entry).encode_wide() {
            out.push(ch);
        }
        out.push(0);
    }
    out.push(0); // 双 NUL 结束
    out
}

/* ---------- helpers ---------- */

fn locate_editor_exe(engine_root: &Path) -> Option<PathBuf> {
    for name in [
        "Engine/Binaries/Win64/UnrealEditor.exe",
        "Engine/Binaries/Win64/UE4Editor.exe",
        "Engine/Binaries/Win64/UE5Editor.exe",
    ] {
        let p = engine_root.join(name);
        if p.exists() { return Some(p); }
    }
    None
}

/// 朴素引擎查找：按以下顺序尝试
/// 1) 解析 .uproject 中 EngineAssociation：
///    - 绝对路径 → 直接使用
///    - 相对路径（如 "../ue4_tracking_rdcsp"）→ 相对于 .uproject 父目录解析
///    - 版本号（如 "5.4"）→ 在 Epic Games 标准安装目录中查找
/// 2) 沿 .uproject 父目录向上回溯，查找包含 `Engine/Binaries/Win64/UnrealEditor.exe`
///    或 `UE4Editor.exe` 的目录（自定义/源码引擎常见布局）
fn find_engine_for(uproject: &Path) -> Option<PathBuf> {
    let project_dir = uproject.parent()?;

    // 1) 解析 EngineAssociation 字段
    if let Ok(s) = std::fs::read_to_string(uproject) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if let Some(assoc) = v.get("EngineAssociation").and_then(|x| x.as_str()) {
                let assoc = assoc.trim();
                if !assoc.is_empty() {
                    // 绝对路径
                    let p = PathBuf::from(assoc);
                    if p.is_absolute() && has_editor(&p) {
                        return Some(p);
                    }
                    // 相对路径
                    if assoc.contains('/') || assoc.contains('\\') {
                        let candidate = project_dir.join(assoc);
                        if let Ok(canonical) = candidate.canonicalize() {
                            let cleaned = strip_unc(&canonical);
                            if has_editor(&cleaned) {
                                return Some(cleaned);
                            }
                        } else if has_editor(&candidate) {
                            return Some(candidate);
                        }
                    }
                    // 版本号 "5.4" / "4.27"
                    for root in [
                        format!("C:/Program Files/Epic Games/UE_{}", assoc),
                        format!("D:/Program Files/Epic Games/UE_{}", assoc),
                        format!("E:/Epic Games/UE_{}", assoc),
                        format!("D:/Epic Games/UE_{}", assoc),
                    ] {
                        let p = PathBuf::from(root);
                        if has_editor(&p) {
                            return Some(p);
                        }
                    }
                }
            }
        }
    }

    // 2) 沿 .uproject 向上回溯查找 Engine/Binaries/Win64/UnrealEditor.exe
    let mut cur = Some(project_dir);
    for _ in 0..8 {
        let dir = match cur {
            Some(d) => d,
            None => break,
        };
        if has_editor(dir) {
            return Some(dir.to_path_buf());
        }
        // 同级目录扫一遍（自定义引擎常与项目并列）
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() && has_editor(&p) {
                    return Some(p);
                }
            }
        }
        cur = dir.parent();
    }

    None
}

/// 判断指定目录是否是合法的 UE 引擎根目录
fn has_editor(engine_root: &Path) -> bool {
    locate_editor_exe(engine_root).is_some()
}

/// 去掉 Windows canonicalize 返回的 \\?\ 前缀，避免 spawn 时路径异常
fn strip_unc(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

#[allow(dead_code)]
fn chrono_like_now() -> String {
    let secs = crate::config::now_ts();
    format!("ts_{secs}")
}

/// 朴素 shell 切分：支持双引号，避免引入 shell-words 依赖
fn shell_split(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    for ch in s.chars() {
        match ch {
            '"' => in_q = !in_q,
            c if c.is_whitespace() && !in_q => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() { out.push(cur); }
    out
}
