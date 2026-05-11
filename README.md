# UE Master

> Lightweight, portable Unreal Engine process manager for Windows.
> Lives in your tray, summoned by a global hotkey.

![status](https://img.shields.io/badge/status-M1%20scaffold-cyan)
![tech](https://img.shields.io/badge/Tauri-2.0-blue)
![rust](https://img.shields.io/badge/Rust-1.77+-orange)

## Features (M1 scaffold)

- **System tray + global hotkey** (`Ctrl+Alt+U` toggles main window)
- **Frameless window** with Mica/Acrylic background (Win10/11)
- **Process list** with auto-refresh every 2s (only when window is visible)
- **Hover detail card** (frosted glass) — full command line, uptime, etc.
- **Kill / Kill All / Open folder**
- **New Process dialog**:
  - Project preset switcher (per-project default args, map, port, log dir, working dir)
  - **History dropdown sorted by Frecency** (launch_count × time-decay + pin bonus)
  - Pin / rename / delete history entries
  - Quick-insert chips for common args (`-log`, `-windowed`, ...)

## Architecture

```
Frontend: React + TS + Tailwind + Framer Motion + lucide-react
Backend:  Rust + Tauri 2 + sysinfo + windows-rs
Storage:  %APPDATA%\UEMaster\config.toml  (TOML)
```

See `src-tauri/src/` for backend modules:
- `process/`   — UE process discovery, identification, snapshot, kill
- `launcher.rs` — build command line per launch mode (Editor/PIE/Game/DS/Client)
- `config.rs`  — projects + history + Frecency record
- `tray.rs` / `hotkey.rs` / `window_fx.rs`
- `commands.rs` — IPC surface

## Prerequisites

- **Rust** ≥ 1.77 (`rustup default stable`)
- **Node.js** ≥ 18 (`npm` works fine)
- **Microsoft C++ Build Tools** (Visual Studio 2022 with "Desktop development with C++")
- **WebView2** runtime (preinstalled on Win11; Tauri bundler will fetch on Win10)

## Setup

```powershell
# install JS deps
npm install

# install Tauri CLI globally (or use npx)
cargo install tauri-cli --version "^2"

# (optional) generate icons from a source PNG
npm run tauri icon path\to\source.png
```

## Run (dev)

```powershell
npm run tauri dev
```

The window starts **hidden**; press `Ctrl+Alt+U` or click the tray icon.

## Build (release, single portable exe)

```powershell
npm run tauri build
```

Output: `src-tauri/target/release/ue-master.exe` (≈ 6–10 MB).
The NSIS installer at `src-tauri/target/release/bundle/nsis/` is optional;
the raw `.exe` is fully portable as long as WebView2 is installed.

## Config file

Located at `%APPDATA%\UEMaster\config.toml`. Hand-editable; the app reads on
startup and rewrites on any change. Example:

```toml
[settings]
hotkey = "Ctrl+1"
refresh_interval_secs = 2
start_minimized = true

[[projects]]
id = "myrpg"
name = "MyRPG"
uproject_path = "D:/Projects/MyRPG/MyRPG.uproject"
engine_path = "D:/UE_5.4"           # optional
working_dir = "D:/Projects/MyRPG"
default_args = "-log -windowed"
default_map = "L_Lobby"
default_port = 7777
log_dir = "D:/Projects/MyRPG/Saved/Logs"
icon_color = "#00E5FF"
tags = ["RPG"]

[[history]]
id = "h_..."
project_id = "myrpg"
mode = "DedicatedServer"
map  = "L_BattleArena"
port = 7777
extra_args = "-log -NOSTEAM"
launch_count = 12
last_used_at = 1746800000
pinned = true
label = "Stress Test 100p"
```

## Frecency scoring

History dropdown is sorted by:

```
score = launch_count × recency_factor + (10000 if pinned else 0)
recency_factor = 1.0 (≤1d) | 0.7 (≤3d) | 0.5 (≤7d) | 0.3 (≤30d) | 0.1 (else)
```

A new launch with identical (project, mode, map, port, args) bumps the existing
entry's `launch_count` and `last_used_at` instead of creating a duplicate.

## Roadmap

- [x] M1 — Tray + hotkey + main window scaffold
- [x] M2 — Process enumeration + identification + snapshot
- [x] M3 — List UI + 2s push refresh
- [x] M4 — Frosted hover card + Mica window + animations
- [x] M5 — Kill / Kill All / Open folder
- [x] M6 — New process dialog + project presets + Frecency history
- [ ] M7 — Settings page (hotkey / interval / theme) + icon set
- [ ] v2  — Live log tail, crash archive, multi-DS perf compare
