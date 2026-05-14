import { useEffect, useState } from "react";
import { Cpu, MemoryStick, MonitorPlay, Skull, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import type { SystemStats, UeProcess } from "../lib/ipc";
import { getSystemStats, killAll, hideWindow } from "../lib/ipc";

interface Props {
  processes: UeProcess[];
  /** Kill All 后用于刷新列表 */
  onAfterAction: () => void;
}

/** 根据百分比给条形/数字一个颜色（绿/黄/红） */
function levelColor(p: number): string {
  if (p >= 85) return "#FF5252";   // red
  if (p >= 60) return "#FFB300";   // amber
  return "#00E5FF";                // cyan
}

function StatMeter({
  icon, label, percent, sub,
}: { icon: React.ReactNode; label: string; percent: number; sub?: string }) {
  const c = levelColor(percent);
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <div className="flex items-center gap-1 min-w-0" title={`${label} ${pct.toFixed(1)}%${sub ? " · " + sub : ""}`}>
      <span className="text-text-dim shrink-0">{icon}</span>
      <span className="text-text-dim text-[10px] uppercase tracking-wider shrink-0">{label}</span>
      <span className="font-mono text-[11px] tabular-nums shrink-0" style={{ color: c }}>
        {pct.toFixed(0)}%
      </span>
      {sub && (
        <span className="font-mono text-[10px] text-text-dim shrink-0 hidden md:inline">{sub}</span>
      )}
    </div>
  );
}

export function StatBar({ processes, onAfterAction }: Props) {
  const totalCpu = processes.reduce((s, p) => s + p.cpu_percent, 0);
  const totalMem = processes.reduce((s, p) => s + p.mem_mb, 0);

  const [sys, setSys] = useState<SystemStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 首次拉一份，避免空白
    getSystemStats().then(s => { if (!cancelled) setSys(s); }).catch(() => {});
    const un = listen<SystemStats>("system-stats", e => setSys(e.payload));
    return () => { cancelled = true; un.then(f => f()); };
  }, []);

  const handleKillAll = async () => {
    if (processes.length === 0) return;
    if (!confirm(`Kill ALL ${processes.length} UE processes? This cannot be undone.`)) return;
    await killAll(processes.map(p => p.pid));
    onAfterAction();
  };

  // mem 子文案
  const memSub = sys
    ? (sys.mem_total_mb >= 1024
      ? `${(sys.mem_used_mb / 1024).toFixed(1)}/${(sys.mem_total_mb / 1024).toFixed(0)}G`
      : `${sys.mem_used_mb}/${sys.mem_total_mb}M`)
    : undefined;

  return (
    <div className="h-9 flex items-center gap-2 px-3 text-[11px] border-t border-border-subtle bg-black/20">
      {/* 左下角：Kill All + Close —— 高频操作集中区。
          UE 进程数已通过 Kill All 按钮里的数量徽章表达，无需再单独显示 "N processes"。 */}
      {/* Kill All —— 红色显眼，0 个进程时灰显 */}
      <button
        onClick={handleKillAll}
        disabled={processes.length === 0}
        title={processes.length === 0 ? "No UE processes" : `Kill all ${processes.length} UE processes`}
        className="h-6 px-2 flex items-center gap-1 rounded-md text-[11px] font-semibold
                   bg-accent-red/15 hover:bg-accent-red/30 border border-accent-red/40 hover:border-accent-red/70
                   text-accent-red hover:shadow-[0_0_6px_rgba(255,82,82,0.45)]
                   disabled:opacity-25 disabled:cursor-not-allowed disabled:hover:bg-accent-red/15
                   disabled:hover:border-accent-red/40 disabled:hover:shadow-none
                   transition-all"
      >
        <Skull size={11} />
        <span>Kill All</span>
        {processes.length > 0 && (
          <span className="text-[10px] font-mono opacity-80">{processes.length}</span>
        )}
      </button>

      {/* Close —— 隐藏到托盘（与 TitleBar 右上 X 等价，方便单手操作） */}
      <button
        onClick={() => hideWindow()}
        title="Hide to tray (Alt+`)"
        className="h-6 w-6 flex items-center justify-center rounded-md
                   text-text-secondary hover:text-accent-red hover:bg-accent-red/15
                   border border-transparent hover:border-accent-red/40
                   transition-all"
      >
        <X size={12} strokeWidth={2.5} />
      </button>

      <div className="text-text-dim/40 ml-1">|</div>
      <div className="text-text-secondary font-mono shrink-0">
        UE-CPU <span className="text-accent-purple">{totalCpu.toFixed(1)}%</span>
      </div>
      <div className="text-text-secondary font-mono shrink-0">
        UE-MEM <span className="text-accent-purple">
          {totalMem >= 1024 ? `${(totalMem / 1024).toFixed(2)}GB` : `${totalMem.toFixed(0)}MB`}
        </span>
      </div>

      {/* 整机指标 */}
      {sys && (
        <>
          <div className="text-text-dim/40">|</div>
          <StatMeter icon={<Cpu size={11} />} label="CPU" percent={sys.cpu_percent} />
          <StatMeter icon={<MemoryStick size={11} />} label="MEM" percent={sys.mem_percent} sub={memSub} />
          {sys.gpu_percent != null && (
            <StatMeter icon={<MonitorPlay size={11} />} label="GPU" percent={sys.gpu_percent} />
          )}
        </>
      )}

      <div className="flex-1" />
    </div>
  );
}
