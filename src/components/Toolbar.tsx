import { useEffect, useState } from "react";
import {
  Plus, RefreshCw, PanelRight, PanelRightClose, Rocket, Pin,
  Settings as SettingsIcon, Pencil, Trash2,
} from "lucide-react";
import clsx from "clsx";
import {
  type LaunchHistory, type ProjectPreset,
  listHistory, listProjects, launchProcess, removeHistory,
} from "../lib/ipc";
import { EditHistoryDialog } from "./EditHistoryDialog";

interface Props {
  onNew: () => void;
  onRefresh: () => void;
  loading: boolean;
  detailOpen: boolean;
  onToggleDetail: () => void;
  onOpenSettings: () => void;
  /** 启动后的回调，例如刷新进程列表 */
  onLaunched?: () => void;
}

/** Frecency 评分：与 NewProcessDialog 同口径 */
function score(h: LaunchHistory): number {
  const ageDays = (Date.now() / 1000 - h.last_used_at) / 86400;
  const recency = ageDays <= 1 ? 1.0 : ageDays <= 3 ? 0.7 : ageDays <= 7 ? 0.5 : ageDays <= 30 ? 0.3 : 0.1;
  return h.launch_count * recency + (h.pinned ? 10000 : 0);
}

export function Toolbar(p: Props) {
  const [history, setHistory] = useState<LaunchHistory[]>([]);
  const [projects, setProjects] = useState<ProjectPreset[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 当前正在编辑的历史条目 id（用于弹出 EditHistoryDialog） */
  const [editingId, setEditingId] = useState<string | null>(null);

  const reload = async () => {
    try {
      const [hs, ps] = await Promise.all([listHistory(), listProjects()]);
      setHistory(hs);
      setProjects(ps);
    } catch { /* ignore */ }
  };
  useEffect(() => { reload(); }, []);
  // 列表变化（loading 切换）后顺带刷新一次，捕获新启动产生的历史
  useEffect(() => { if (!p.loading) reload(); }, [p.loading]);

  // 全部带 Name 的历史，按 frecency 排序；不再做上限截断（外层 flex 容器自带横向滚动）
  const quick = [...history]
    .filter(h => (h.label ?? "").trim().length > 0)
    .sort((a, b) => score(b) - score(a));

  const projName = (id: string) => projects.find(x => x.id === id)?.name ?? "?";

  const fire = async (h: LaunchHistory) => {
    if (busyId) return;
    setBusyId(h.id);
    try {
      const r = await launchProcess({
        project_id: h.project_id,
        mode: h.mode,
        map: h.map,
        port: h.port,
        extra_args: h.extra_args,
        env: h.env,
        log_file: h.log_file,
        working_dir: h.working_dir,
        label: h.label ?? null,
        save_as_template: false,
      });
      if (r.replaced_pids?.length) {
        console.info(`[launch] replaced ${r.replaced_pids.length} stale DS instance(s):`, r.replaced_pids);
      }
      p.onLaunched?.();
      // 启动会推动 frecency，刷新一下
      reload();
    } catch (e) {
      alert(`Launch failed: ${e}`);
    } finally {
      setBusyId(null);
    }
  };

  // 快速删除（带二次确认）
  const handleQuickDelete = async (h: LaunchHistory, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!confirm(`Delete quick-launch button "${h.label}"?`)) return;
    try {
      await removeHistory(h.id);
      await reload();
    } catch (err) {
      alert(`Delete failed: ${err}`);
    }
  };

  // 打开编辑对话框
  const handleQuickEdit = (h: LaunchHistory, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setEditingId(h.id);
  };

  const editingHistory = editingId ? history.find(x => x.id === editingId) ?? null : null;

  return (
    <div className="h-12 flex items-center gap-2 px-3 border-b border-border-subtle">
      <button
        onClick={p.onNew}
        className="h-8 px-3 flex items-center gap-1.5 text-sm rounded-md
                   bg-gradient-to-r from-accent-cyan/20 to-accent-purple/20
                   hover:from-accent-cyan/30 hover:to-accent-purple/30
                   border border-accent-cyan/30 hover:border-accent-cyan/60
                   text-accent-cyan hover:shadow-glowSm transition-all"
      >
        <Plus size={14} /> New
      </button>

      {/* 快速启动条 —— 全部带 Name 的历史，按 frecency 排序；超出宽度时横向滚动 */}
      {quick.length > 0 && (
        <div className="flex-1 min-w-0 flex items-center gap-1 ml-1 pl-2 border-l border-border-subtle/60
                        overflow-x-auto overflow-y-hidden quick-scroll">
          {quick.map(h => {
            const isBusy = busyId === h.id;
            return (
              <div
                key={h.id}
                className={clsx(
                  "group relative h-7 max-w-[160px] flex items-center rounded-md",
                  "text-[11px] border transition-all shrink-0",
                  isBusy
                    ? "border-accent-cyan/60 bg-accent-cyan/10 text-accent-cyan"
                    : "border-border-subtle bg-black/20 text-text-secondary hover:border-accent-cyan/50 hover:bg-accent-cyan/10",
                  busyId && !isBusy && "opacity-40"
                )}
              >
                <button
                  onClick={() => fire(h)}
                  disabled={!!busyId}
                  title={`${projName(h.project_id)} · ${h.mode} · ${h.label}\n${h.extra_args || "(no args)"}\n\nClick: launch · Right-click: edit / delete`}
                  className="flex-1 min-w-0 h-full pl-2 pr-1 flex items-center gap-1 disabled:cursor-not-allowed"
                >
                  {h.pinned ? (
                    <Pin size={9} className="text-accent-cyan fill-accent-cyan shrink-0" />
                  ) : (
                    <Rocket size={10} className={clsx(
                      "shrink-0 transition",
                      isBusy ? "text-accent-cyan animate-pulse" : "text-text-dim group-hover:text-accent-cyan"
                    )} />
                  )}
                  <span className="truncate font-medium flex-1 text-left">{h.label}</span>
                  <span className="text-text-dim text-[9px] font-mono shrink-0">
                    {projName(h.project_id).slice(0, 3).toUpperCase()}
                  </span>
                </button>
                {/* hover 时显示的编辑/删除小按钮 */}
                <div className="hidden group-hover:flex items-center pr-0.5 gap-0.5 shrink-0">
                  <button
                    onClick={(e) => handleQuickEdit(h, e)}
                    disabled={!!busyId}
                    title="Edit parameters"
                    className="w-4 h-4 flex items-center justify-center rounded
                               text-text-dim hover:text-accent-cyan hover:bg-accent-cyan/15"
                  >
                    <Pencil size={9} />
                  </button>
                  <button
                    onClick={(e) => handleQuickDelete(h, e)}
                    disabled={!!busyId}
                    title="Delete this button"
                    className="w-4 h-4 flex items-center justify-center rounded
                               text-text-dim hover:text-accent-red hover:bg-accent-red/15"
                  >
                    <Trash2 size={9} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 没有快捷启动条时也要把右上按钮推到右侧 */}
      {quick.length === 0 && <div className="flex-1" />}

      {/* 右上：Settings / Refresh / Toggle details */}
      <button
        onClick={p.onOpenSettings}
        className="h-8 w-8 flex items-center justify-center rounded-md
                   hover:bg-white/5 text-text-secondary hover:text-accent-cyan transition"
        title="Settings"
      >
        <SettingsIcon size={14} />
      </button>
      <button
        onClick={p.onRefresh}
        className="h-8 w-8 flex items-center justify-center rounded-md
                   hover:bg-white/5 text-text-secondary hover:text-accent-cyan transition"
        title="Refresh"
      >
        <RefreshCw size={14} className={clsx(p.loading && "animate-spin")} />
      </button>
      <button
        onClick={p.onToggleDetail}
        className={clsx(
          "h-8 w-8 flex items-center justify-center rounded-md transition",
          p.detailOpen
            ? "bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/30"
            : "hover:bg-white/5 text-text-secondary border border-transparent"
        )}
        title={p.detailOpen ? "Hide details panel" : "Show details panel"}
      >
        {p.detailOpen ? <PanelRightClose size={14} /> : <PanelRight size={14} />}
      </button>

      {/* 编辑对话框 */}
      {editingHistory && (
        <EditHistoryDialog
          history={editingHistory}
          onClose={() => setEditingId(null)}
          onUpdated={reload}
        />
      )}
    </div>
  );
}
