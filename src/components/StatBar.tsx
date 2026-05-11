import { Skull } from "lucide-react";
import type { UeProcess } from "../lib/ipc";
import { killAll } from "../lib/ipc";

interface Props {
  processes: UeProcess[];
  onAfterAction: () => void;
}

export function StatBar({ processes, onAfterAction }: Props) {
  const totalCpu = processes.reduce((s, p) => s + p.cpu_percent, 0);
  const totalMem = processes.reduce((s, p) => s + p.mem_mb, 0);

  const handleKillAll = async () => {
    if (processes.length === 0) return;
    if (!confirm(`Kill ALL ${processes.length} UE processes? This cannot be undone.`)) return;
    await killAll(processes.map(p => p.pid));
    onAfterAction();
  };

  return (
    <div className="h-9 flex items-center gap-4 px-3 text-[11px] border-t border-border-subtle bg-black/20">
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />
        <span className="text-text-secondary">{processes.length} processes</span>
      </div>
      <div className="text-text-dim">|</div>
      <div className="text-text-secondary font-mono">
        CPU <span className="text-accent-cyan">{totalCpu.toFixed(1)}%</span>
      </div>
      <div className="text-text-secondary font-mono">
        MEM <span className="text-accent-cyan">
          {totalMem >= 1024 ? `${(totalMem / 1024).toFixed(2)}GB` : `${totalMem.toFixed(0)}MB`}
        </span>
      </div>
      <div className="flex-1" />
      <span className="text-[10px] text-text-dim/70 italic select-none mr-2"
            title="UEMaster by miles">
        by miles
      </span>
      <button
        onClick={handleKillAll}
        disabled={processes.length === 0}
        className="h-7 px-3 flex items-center gap-1.5 rounded-md text-xs
                   bg-accent-red/10 hover:bg-accent-red/20 border border-accent-red/30
                   text-accent-red disabled:opacity-30 disabled:cursor-not-allowed
                   transition"
      >
        <Skull size={12} /> Kill All
      </button>
    </div>
  );
}
