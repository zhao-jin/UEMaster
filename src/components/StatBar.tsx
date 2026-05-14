import { useEffect, useState } from "react";
import { Cpu, MemoryStick, MonitorPlay } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import type { SystemStats, UeProcess } from "../lib/ipc";
import { getSystemStats } from "../lib/ipc";

interface Props {
  processes: UeProcess[];
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

export function StatBar({ processes }: Props) {
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

  // mem 子文案
  const memSub = sys
    ? (sys.mem_total_mb >= 1024
      ? `${(sys.mem_used_mb / 1024).toFixed(1)}/${(sys.mem_total_mb / 1024).toFixed(0)}G`
      : `${sys.mem_used_mb}/${sys.mem_total_mb}M`)
    : undefined;

  return (
    <div className="h-9 flex items-center gap-3 px-3 text-[11px] border-t border-border-subtle bg-black/20">
      {/* UE 进程聚合 */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />
        <span className="text-text-secondary">{processes.length} processes</span>
      </div>
      <div className="text-text-dim/40">|</div>
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
