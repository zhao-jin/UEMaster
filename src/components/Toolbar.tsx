import { useEffect, useState } from "react";
import { Plus, RefreshCw, PanelRight, PanelRightClose, Rocket, Pin, Settings as SettingsIcon, Skull } from "lucide-react";
import clsx from "clsx";
import {
  type LaunchHistory, type ProjectPreset, type UeProcess,
  listHistory, listProjects, launchProcess, killAll,
} from "../lib/ipc";

interface Props {
  onNew: () => void;
  onRefresh: () => void;
  loading: boolean;
  detailOpen: boolean;
  onToggleDetail: () => void;
  onOpenSettings: () => void;
  /** 启动后的回调，例如刷新进程列表 */
  onLaunched?: () => void;
  /** Kill All 用：当前 UE 进程列表 */
  processes: UeProcess[];
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
              <button
                key={h.id}
                onClick={() => fire(h)}
                disabled={!!busyId}
                title={`${projName(h.project_id)} · ${h.mode} · ${h.label}\n${h.extra_args || "(no args)"}`}
                className={clsx(
                  "group h-7 max-w-[160px] px-2 flex items-center gap-1 rounded-md",
                  "text-[11px] border transition-all shrink-0",
                  isBusy
                    ? "border-accent-cyan/60 bg-accent-cyan/10 text-accent-cyan"
                    : "border-border-subtle bg-black/20 text-text-secondary",
                  !isBusy && "hover:border-accent-cyan/50 hover:bg-accent-cyan/10 hover:text-accent-cyan",
                  busyId && !isBusy && "opacity-40 cursor-not-allowed"
                )}
              >
                {h.pinned ? (
                  <Pin size={9} className="text-accent-cyan fill-accent-cyan shrink-0" />
                ) : (
                  <Rocket size={10} className={clsx(
                    "shrink-0 transition",
                    isBusy ? "text-accent-cyan animate-pulse" : "text-text-dim group-hover:text-accent-cyan"
                  )} />
                )}
                <span className="truncate font-medium">{h.label}</span>
                <span className="text-text-dim text-[9px] font-mono shrink-0">
                  {projName(h.project_id).slice(0, 3).toUpperCase()}
                </span>
              </button>
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

      {/* Kill All —— 显眼的红色按钮，仅有 UE 进程时可点 */}
      <button
        onClick={async () => {
          if (p.processes.length === 0) return;
          if (!confirm(`Kill ALL ${p.processes.length} UE processes? This cannot be undone.`)) return;
          await killAll(p.processes.map(x => x.pid));
          p.onLaunched?.();   // 复用刷新回调
        }}
        disabled={p.processes.length === 0}
        title={p.processes.length === 0 ? "No UE processes" : `Kill all ${p.processes.length} UE processes`}
        className="h-8 px-2.5 ml-1 flex items-center gap-1 rounded-md text-xs font-semibold
                   bg-accent-red/15 hover:bg-accent-red/30 border border-accent-red/40 hover:border-accent-red/70
                   text-accent-red hover:shadow-[0_0_8px_rgba(255,82,82,0.4)]
                   disabled:opacity-25 disabled:cursor-not-allowed disabled:hover:bg-accent-red/15
                   disabled:hover:border-accent-red/40 disabled:hover:shadow-none
                   transition-all"
      >
        <Skull size={13} />
        <span>Kill All</span>
        {p.processes.length > 0 && (
          <span className="text-[10px] font-mono opacity-80">{p.processes.length}</span>
        )}
      </button>
    </div>
  );
}
