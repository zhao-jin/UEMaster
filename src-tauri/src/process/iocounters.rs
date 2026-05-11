//! 通过 Win32 GetProcessIoCounters 读取每进程的 I/O 字节数。
//!
//! 注意：Windows 没有公开 API 单独给出"网络 I/O 字节数"。
//! `OtherTransferCount` 通常涵盖网络 socket 读写（以及部分设备/管道 I/O），
//! 在 UE Editor / DS 这类应用上能很好地反映网络流量变化。
//! 我们把它和 Read/Write 一起暴露，前端展示为 "I/O Bytes/s"。

#[cfg(windows)]
pub fn read_io_bytes(pid: u32) -> Option<u64> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetProcessIoCounters, OpenProcess, IO_COUNTERS, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        if handle.is_invalid() {
            return None;
        }
        let mut io = IO_COUNTERS::default();
        let ok = GetProcessIoCounters(handle, &mut io as *mut _).is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        // 累计字节 = Read + Write + Other（其中 Other 通常含网络 socket I/O）
        Some(io.ReadTransferCount.saturating_add(io.WriteTransferCount).saturating_add(io.OtherTransferCount))
    }
}

#[cfg(not(windows))]
pub fn read_io_bytes(_pid: u32) -> Option<u64> {
    None
}
