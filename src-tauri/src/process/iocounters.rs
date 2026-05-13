//! 通过 Win32 GetProcessIoCounters 读取每进程的 I/O 字节数。
//!
//! 注意：Windows 没有公开 API 单独给出"网络 I/O 字节数"。
//! `OtherTransferCount` 通常涵盖网络 socket 读写（以及部分设备/管道 I/O），
//! 在 UE Editor / DS 这类应用上能很好地反映网络流量变化。
//! 我们把它和 Read/Write 一起暴露，前端展示为 "I/O Bytes/s"。
//!
//! ─── 性能优化 ───
//! 旧实现每个 PID 每轮都 OpenProcess+CloseHandle，Win32 句柄反复开关在
//! 200ms tick 节奏下开销可观。新实现用 `IoHandle` 缓存句柄，
//! 进程退出时由 `PerProcState::Drop` 统一释放。

#[cfg(windows)]
use windows::Win32::Foundation::HANDLE;

/// 缓存的 Win32 句柄。非 Windows 平台是空壳。
pub struct IoHandle {
    #[cfg(windows)]
    handle: Option<HANDLE>,
    /// 标记为 true 表示已经尝试过 Open，但失败了（权限不足等）。
    /// 之后跳过避免每秒重复尝试 syscall。
    #[allow(dead_code)]
    failed: bool,
}

impl IoHandle {
    pub fn new() -> Self {
        Self {
            #[cfg(windows)]
            handle: None,
            failed: false,
        }
    }
}

#[cfg(windows)]
unsafe impl Send for IoHandle {}

/// 用缓存的句柄读 IO 字节数；首次调用时延迟 OpenProcess。
#[cfg(windows)]
pub fn read_io_bytes_cached(pid: u32, cache: &mut IoHandle) -> Option<u64> {
    use windows::Win32::System::Threading::{
        GetProcessIoCounters, OpenProcess, IO_COUNTERS, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if cache.failed {
        return None;
    }

    unsafe {
        // 首次调用：开句柄
        if cache.handle.is_none() {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(h) if !h.is_invalid() => {
                    cache.handle = Some(h);
                }
                _ => {
                    cache.failed = true;
                    return None;
                }
            }
        }

        let h = cache.handle?;
        let mut io = IO_COUNTERS::default();
        let ok = GetProcessIoCounters(h, &mut io as *mut _).is_ok();
        if !ok {
            // 句柄可能因为进程已退出而失效，关掉重置
            close_io_handle(cache);
            cache.failed = true;
            return None;
        }
        // 累计字节 = Read + Write + Other（其中 Other 通常含网络 socket I/O）
        Some(
            io.ReadTransferCount
                .saturating_add(io.WriteTransferCount)
                .saturating_add(io.OtherTransferCount),
        )
    }
}

#[cfg(not(windows))]
pub fn read_io_bytes_cached(_pid: u32, _cache: &mut IoHandle) -> Option<u64> {
    None
}

/// 释放缓存的句柄（PerProcState::Drop 调用）
#[cfg(windows)]
pub fn close_io_handle(cache: &mut IoHandle) {
    use windows::Win32::Foundation::CloseHandle;
    if let Some(h) = cache.handle.take() {
        unsafe {
            let _ = CloseHandle(h);
        }
    }
}

#[cfg(not(windows))]
pub fn close_io_handle(_cache: &mut IoHandle) {}
