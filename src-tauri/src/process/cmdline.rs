//! Read the full command line of a running process via PEB.
//!
//! `sysinfo` on Windows returns an empty `cmd()` for processes other than the
//! current one (cmdline isn't part of the process snapshot APIs). We open the
//! target with PROCESS_QUERY_LIMITED_INFORMATION + PROCESS_VM_READ, locate its
//! PEB via NtQueryInformationProcess(ProcessBasicInformation), then walk
//! PEB → ProcessParameters → CommandLine (UNICODE_STRING).

#![cfg(windows)]

use std::ffi::c_void;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
};

/// Try to read the full command line for `pid`. Returns `None` on any failure
/// (access denied, 32/64-bit mismatch, transient race, etc.) — caller should
/// gracefully fall back.
pub fn full_cmdline_for_pid(pid: u32) -> Option<String> {
    unsafe {
        let h: HANDLE = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
            false,
            pid,
        )
        .ok()?;
        if h.is_invalid() {
            return None;
        }
        let result = read_via_peb(h);
        let _ = CloseHandle(h);
        result
    }
}

/// PROCESS_BASIC_INFORMATION layout (only the field we need is documented stable)
#[repr(C)]
#[derive(Default)]
struct ProcessBasicInformation {
    _exit_status: isize,
    peb_base_address: usize,
    _affinity: usize,
    _base_priority: isize,
    _unique_process_id: usize,
    _inherited_unique_process_id: usize,
}

/// UNICODE_STRING { USHORT Length; USHORT MaxLength; PWSTR Buffer; }
#[repr(C)]
#[derive(Default)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: usize, // PWSTR
}

unsafe fn read_via_peb(h: HANDLE) -> Option<String> {
    // 1) NtQueryInformationProcess(ProcessBasicInformation) → PEB base address
    type NtQip = unsafe extern "system" fn(
        ProcessHandle: HANDLE,
        ProcessInformationClass: i32,
        ProcessInformation: *mut c_void,
        ProcessInformationLength: u32,
        ReturnLength: *mut u32,
    ) -> i32;

    let ntdll = windows::Win32::System::LibraryLoader::GetModuleHandleW(
        windows::core::w!("ntdll.dll"),
    )
    .ok()?;
    let proc_addr = windows::Win32::System::LibraryLoader::GetProcAddress(
        ntdll,
        windows::core::s!("NtQueryInformationProcess"),
    )?;
    let nt_qip: NtQip = std::mem::transmute(proc_addr);

    let mut pbi = ProcessBasicInformation::default();
    let mut ret_len: u32 = 0;
    let status = nt_qip(
        h,
        0, // ProcessBasicInformation
        &mut pbi as *mut _ as *mut c_void,
        std::mem::size_of::<ProcessBasicInformation>() as u32,
        &mut ret_len,
    );
    if status < 0 || pbi.peb_base_address == 0 {
        return None;
    }

    // 2) Read PEB -> ProcessParameters pointer.
    //    On x64: PEB.ProcessParameters at offset 0x20.
    //    (We only support 64-bit hosts since UE on Windows is x64.)
    let process_params_ptr = read_usize(h, pbi.peb_base_address + 0x20)?;
    if process_params_ptr == 0 {
        return None;
    }

    // 3) Read RTL_USER_PROCESS_PARAMETERS.CommandLine at offset 0x70 (x64).
    let mut cmd_us = UnicodeString::default();
    let ok = ReadProcessMemory(
        h,
        (process_params_ptr + 0x70) as *const c_void,
        &mut cmd_us as *mut _ as *mut c_void,
        std::mem::size_of::<UnicodeString>(),
        None,
    )
    .is_ok();
    if !ok || cmd_us.length == 0 || cmd_us.buffer == 0 {
        return None;
    }

    // 4) Read the UTF-16 buffer
    let len_bytes = cmd_us.length as usize;
    let mut buf: Vec<u16> = vec![0u16; len_bytes / 2];
    let ok2 = ReadProcessMemory(
        h,
        cmd_us.buffer as *const c_void,
        buf.as_mut_ptr() as *mut c_void,
        len_bytes,
        None,
    )
    .is_ok();
    if !ok2 {
        return None;
    }

    Some(String::from_utf16_lossy(&buf))
}

unsafe fn read_usize(h: HANDLE, addr: usize) -> Option<usize> {
    let mut v: usize = 0;
    let ok = ReadProcessMemory(
        h,
        addr as *const c_void,
        &mut v as *mut _ as *mut c_void,
        std::mem::size_of::<usize>(),
        None,
    )
    .is_ok();
    if ok { Some(v) } else { None }
}
