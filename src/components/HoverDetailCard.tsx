import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import type { UeProcess } from "../lib/ipc";
import { Cpu, MemoryStick, Clock, Terminal, FolderTree, Activity } from "lucide-react";
import { Sparkline } from "./Sparkline";

interface Props {
  process: UeProcess;
  anchor: { x: number; y: number };
}

const CARD_W = 400;
const CARD_H_MAX = 520;

export function HoverDetailCard({ process: p, anchor }: Props) {
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    const margin = 16;
    let left = anchor.x + 20;
    let top = anchor.y + 8;
    if (left + CARD_W > window.innerWidth - margin) {
      left = anchor.x - CARD_W - 20;
    }
    if (top + CARD_H_MAX > window.innerHeight - margin) {
      top = window.innerHeight - CARD_H_MAX - margin;
    }
    if (top < margin) top = margin;
    if (left < margin) left = margin;
    setPos({ left, top });
  }, [anchor]);

  const upTime = ((Date.now() / 1000 - p.start_time) | 0);
  const upTimeStr = upTime < 60 ? `${upTime}s`
    : upTime < 3600 ? `${(upTime / 60 | 0)}m ${upTime % 60}s`
    : `${(upTime / 3600 | 0)}h ${((upTime % 3600) / 60 | 0)}m`;

  const ioStr = p.io_kbps >= 1024
    ? `${(p.io_kbps / 1024).toFixed(1)} MB/s`
    : `${p.io_kbps} KB/s`;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.15 }}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        width: CARD_W,
        maxHeight: CARD_H_MAX,
        zIndex: 100,
        pointerEvents: "none",
      }}
      className="glass tech-border rounded-xl shadow-panel p-4 overflow-hidden"
    >
      <div className="flex items-center gap-2 pb-2 border-b border-border-subtle">
        {p.launch_label && (
          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded
                           bg-accent-purple/15 border border-accent-purple/40 text-accent-purple">
            {p.launch_label}
          </span>
        )}
        <div className="text-sm font-semibold text-accent-cyan truncate">
          {p.project_name ?? p.name}
        </div>
        <div className="text-[10px] font-mono text-text-dim shrink-0">PID {p.pid}</div>
        <div className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/30 shrink-0">
          {p.kind}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 mt-3">
        <Stat icon={<Cpu size={11} />} label="CPU" value={`${p.cpu_percent.toFixed(1)}%`} />
        <Stat icon={<MemoryStick size={11} />} label="MEM" value={fmtMem(p.mem_mb)} />
        <Stat icon={<Activity size={11} />} label="I/O" value={ioStr} />
        <Stat icon={<Clock size={11} />} label="UP" value={upTimeStr} />
      </div>

      <div className="mt-3 space-y-2.5">
        <Sparkline
          data={p.history.cpu}
          label="CPU history"
          unit="%"
          current={p.cpu_percent.toFixed(1)}
          stroke="#00E5FF"
          fill="rgba(0, 229, 255, 0.18)"
          width={CARD_W - 32}
          height={42}
        />
        <Sparkline
          data={p.history.mem_mb}
          label="Memory history"
          unit="MB"
          current={p.mem_mb}
          stroke="#7C4DFF"
          fill="rgba(124, 77, 255, 0.18)"
          width={CARD_W - 32}
          height={42}
        />
        <Sparkline
          data={p.history.io_kbps}
          label="I/O Bytes/s history"
          unit="KB/s"
          current={p.io_kbps}
          stroke="#00E676"
          fill="rgba(0, 230, 118, 0.18)"
          width={CARD_W - 32}
          height={42}
        />
      </div>

      <Section icon={<Terminal size={11} />} title="Command Line">
        <div className="font-mono text-[10px] text-text-secondary leading-relaxed
                        max-h-16 overflow-y-auto break-all whitespace-pre-wrap">
          {p.cmdline || "(empty)"}
        </div>
      </Section>

      {p.exe_path && (
        <Section icon={<FolderTree size={11} />} title="Executable">
          <div className="font-mono text-[10px] text-text-secondary break-all line-clamp-2">
            {p.exe_path}
          </div>
        </Section>
      )}
    </motion.div>
  );
}

function fmtMem(mb: number): string {
  if (mb >= 1024) return (mb / 1024).toFixed(2) + " GB";
  return mb.toFixed(0) + " MB";
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md bg-black/30 px-2 py-1.5 border border-border-subtle">
      <div className="flex items-center gap-1 text-[9px] text-text-dim uppercase tracking-wider">
        {icon} {label}
      </div>
      <div className="font-mono text-[11px] text-text-primary mt-0.5 truncate">{value}</div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2.5">
      <div className="flex items-center gap-1 text-[9px] text-text-dim uppercase tracking-wider mb-1">
        {icon} {title}
      </div>
      {children}
    </div>
  );
}
