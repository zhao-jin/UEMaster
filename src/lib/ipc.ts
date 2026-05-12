import { invoke } from "@tauri-apps/api/core";

export type UeKind = "Editor" | "Game" | "DedicatedServer" | "Client" | "Helper" | "Unknown";

export interface ProcessHistory {
  cpu: number[];
  mem_mb: number[];
  io_kbps: number[];
}

export interface UeProcess {
  pid: number;
  parent_pid: number;
  name: string;
  kind: UeKind;
  cmdline: string;
  cwd: string | null;
  exe_path: string;
  project_name: string | null;
  launch_label: string | null;
  cpu_percent: number;
  mem_mb: number;
  io_kbps: number;
  threads: number;
  start_time: number;
  children: number[];
  history: ProcessHistory;
}

export type LaunchMode = "Editor" | "PIE" | "Game" | "DedicatedServer" | "Client";

export interface ProjectPreset {
  id: string;
  name: string;
  uproject_path: string;
  engine_path?: string | null;
  working_dir?: string | null;
  default_args: string;
  default_map: string;
  default_port: number;
  log_dir?: string | null;
  icon_color: string;
  tags: string[];
}

export interface LaunchHistory {
  id: string;
  project_id: string;
  mode: LaunchMode;
  map: string;
  port: number;
  extra_args: string;
  env: Record<string, string>;
  log_file: string;
  working_dir: string;
  launch_count: number;
  last_used_at: number;
  created_at: number;
  pinned: boolean;
  label?: string | null;
}

export interface LaunchRequest {
  project_id: string;
  mode: LaunchMode;
  map: string;
  port: number;
  extra_args: string;
  env: Record<string, string>;
  log_file: string;
  working_dir: string;
  label?: string | null;
  save_as_template?: boolean;
}

// 进程
export const listProcesses = () => invoke<UeProcess[]>("list_processes");
export const killProcess = (pid: number) => invoke<void>("kill_process", { pid });
export const killAll = (pids: number[]) => invoke<void>("kill_all", { pids });
export const openInExplorer = (path: string) => invoke<void>("open_in_explorer", { path });
export const readTailLog = (path: string, lines: number) =>
  invoke<string>("read_tail_log", { path, lines });

// 项目预设
export const listProjects = () => invoke<ProjectPreset[]>("list_projects");
export const upsertProject = (p: ProjectPreset) => invoke<void>("upsert_project", { project: p });
export const removeProject = (id: string) => invoke<void>("remove_project", { id });

// 历史
export const listHistory = (projectId?: string) =>
  invoke<LaunchHistory[]>("list_history", { projectId: projectId ?? null });
export const togglePin = (id: string) => invoke<void>("toggle_pin", { id });
export const removeHistory = (id: string) => invoke<void>("remove_history", { id });
export const renameHistory = (id: string, label: string) =>
  invoke<void>("rename_history", { id, label });

// 启动
export const launchProcess = (req: LaunchRequest) =>
  invoke<{ pid: number; history_id: string }>("launch_process", { req });

// 窗口
export const hideWindow = () => invoke<void>("hide_window");

// Settings
export interface Settings {
  hotkey: string;
  refresh_interval_secs: number;
  start_minimized: boolean;
}
export interface SettingsPatch {
  refresh_interval_secs?: number;
  start_minimized?: boolean;
  hotkey?: string;
}
export const getSettings = () => invoke<Settings>("get_settings");
export const updateSettings = (patch: SettingsPatch) =>
  invoke<Settings>("update_settings", { patch });

// 全局机器指标
export interface SystemStats {
  cpu_percent: number;
  mem_used_mb: number;
  mem_total_mb: number;
  mem_percent: number;
  gpu_percent: number | null;
}
export const getSystemStats = () => invoke<SystemStats>("get_system_stats");
