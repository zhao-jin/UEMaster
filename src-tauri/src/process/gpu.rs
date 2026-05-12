//! Windows GPU 总占用率采样（PDH `\GPU Engine(*)\Utilization Percentage`）。
//!
//! 与任务管理器同源：把所有 GPU Engine 实例的占用相加（一台机器可能多 GPU 多 engine），
//! 再钳制到 0..=100。采样开销很低（单次 PdhCollectQueryData + 遍历当前实例值）。
//!
//! 失败（PDH 不可用、没有 GPU、查询初始化失败）时 `sample()` 返回 None，UI 自动隐藏 GPU 项。

#![cfg(windows)]

use std::sync::Mutex;

use windows::core::PCWSTR;
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
    PDH_MORE_DATA,
};

pub struct GpuSampler {
    inner: Mutex<Option<Inner>>,
}

struct Inner {
    query: isize,
    counter: isize,
    primed: bool,
}

unsafe impl Send for Inner {}
unsafe impl Sync for Inner {}

impl Drop for Inner {
    fn drop(&mut self) {
        unsafe {
            PdhCloseQuery(self.query);
        }
    }
}

fn wide_nul(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

impl GpuSampler {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Self::try_init()),
        }
    }

    fn try_init() -> Option<Inner> {
        unsafe {
            let mut query: isize = 0;
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                return None;
            }
            let path = wide_nul(r"\GPU Engine(*)\Utilization Percentage");
            let mut counter: isize = 0;
            let r = PdhAddEnglishCounterW(query, PCWSTR(path.as_ptr()), 0, &mut counter);
            if r != 0 {
                PdhCloseQuery(query);
                return None;
            }
            // 第一次 collect 用于建立基准
            PdhCollectQueryData(query);
            Some(Inner {
                query,
                counter,
                primed: false,
            })
        }
    }

    /// 返回 0..100 的 GPU 总占用百分比（多 engine 求和并钳制）。
    /// 第一次调用通常返回 None（PDH 需要两次采样间隔才能算出速率）。
    pub fn sample(&self) -> Option<f32> {
        let mut guard = self.inner.lock().ok()?;
        let inner = guard.as_mut()?;
        unsafe {
            if PdhCollectQueryData(inner.query) != 0 {
                return None;
            }
            // 第一次采样作为基准，下次再返回真实值
            if !inner.primed {
                inner.primed = true;
                return None;
            }

            let mut buf_size: u32 = 0;
            let mut item_count: u32 = 0;
            // 第一次调用查所需大小
            let r = PdhGetFormattedCounterArrayW(
                inner.counter,
                PDH_FMT_DOUBLE,
                &mut buf_size,
                &mut item_count,
                None,
            );
            if r != PDH_MORE_DATA && r != 0 {
                return None;
            }
            if buf_size == 0 || item_count == 0 {
                return Some(0.0);
            }

            let mut buf: Vec<u8> = vec![0u8; buf_size as usize];
            let arr_ptr = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            let r = PdhGetFormattedCounterArrayW(
                inner.counter,
                PDH_FMT_DOUBLE,
                &mut buf_size,
                &mut item_count,
                Some(arr_ptr),
            );
            if r != 0 {
                return None;
            }
            let items = std::slice::from_raw_parts(arr_ptr, item_count as usize);
            let mut total: f64 = 0.0;
            for it in items {
                if it.FmtValue.CStatus == PDH_CSTATUS_VALID_DATA {
                    let v = it.FmtValue.Anonymous.doubleValue;
                    if v.is_finite() && v > 0.0 {
                        total += v;
                    }
                }
            }
            Some(total.clamp(0.0, 100.0) as f32)
        }
    }
}
