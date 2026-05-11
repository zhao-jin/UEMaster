use serde::{Deserialize, Serialize};
use sysinfo::Process;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum UeKind {
    Editor,
    Game,
    DedicatedServer,
    Client,
    Helper,
    Unknown,
}

impl UeKind {
    pub fn is_ue(self) -> bool { !matches!(self, UeKind::Unknown) }
}

/// 综合判定一个进程是否为 UE 进程及其类型
///
/// 当前策略：
///   1) 仅识别 UE 编辑器进程（UnrealEditor.exe / UE4Editor.exe）作为 UE 进程
///   2) 如果命令行带 `-server`，判定为 DedicatedServer（UE 的 DS 实际上是
///      同一个 Editor 可执行文件加 `-server` 参数启动的）
///   3) 否则归为 Editor
pub fn identify(p: &Process) -> UeKind {
    let name = p.name().to_string_lossy().to_lowercase();

    let is_ue_editor = name == "unrealeditor.exe"
        || name == "ue4editor.exe"
        || name == "unrealeditor"
        || name == "ue4editor";
    if !is_ue_editor {
        return UeKind::Unknown;
    }

    // 扫 cmd 参数是否带 -server（大小写不敏感，支持 -server / /server）
    for seg in p.cmd() {
        let s = seg.to_string_lossy();
        for tok in s.split_whitespace() {
            let t = tok.trim_matches('"').trim_matches('\'');
            if t.eq_ignore_ascii_case("-server") || t.eq_ignore_ascii_case("/server") {
                return UeKind::DedicatedServer;
            }
        }
    }

    UeKind::Editor
}
