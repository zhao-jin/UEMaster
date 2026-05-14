import { FolderOpen, X } from "lucide-react";
import clsx from "clsx";
import { memo } from "react";
import type { UeProcess } from "../lib/ipc";
import { killProcess, openInExplorer } from "../lib/ipc";

interface Props {
  process: UeProcess;
  selected: boolean;
  onAfterAction: () => void;
}

const KIND_COLORS: Record<string, string> = {
  Editor: "text-accent-cyan border-accent-cyan/40 bg-accent-cyan/10",
  Game: "text-accent-green border-accent-green/40 bg-accent-green/10",
  DedicatedServer: "text-accent-purple border-accent-purple/40 bg-accent-purple/10",
  Client: "text-accent-orange border-accent-orange/40 bg-accent-orange/10",
  Helper: "text-text-dim border-text-dim/40 bg-white/5",
  Unknown: "text-text-secondary border-text-secondary/40 bg-white/5",
};

const KIND_SHORT: Record<string, string> = {
  Editor: "EDITOR",
  Game: "GAME",
  DedicatedServer: "DS",
  Client: "CLIENT",
  Helper: "HELPER",
  Unknown: "?",
};

function fmtMem(mb: number) {
  if (mb >= 1024) return (mb / 1024).toFixed(2) + " GB";
  return mb.toFixed(0) + " MB";
}

function fmtUptime(startTs: number): string {
  if (!startTs || startTs <= 0) return "—";
  const s = Math.max(0, (Date.now() / 1000 - startTs) | 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  if (s < 86400) {
    const h = (s / 3600) | 0;
    const m = ((s % 3600) / 60) | 0;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${(s / 86400) | 0}d`;
}

/** 从命令行解析端口；优先 -port= / -Port= ，其次 ?Port= ，最后 :NNNN  */
function parsePort(cmd: string): number | null {
  if (!cmd) return null;
  const re1 = /-port[=:\s]+(\d{2,5})/i;          // -port=7777 / -port 7777
  const re2 = /\?port=(\d{2,5})/i;               // map?port=7777
  const re3 = /(?:^|\s)(?:0\.0\.0\.0|127\.0\.0\.1|localhost):(\d{2,5})/i;
  const m = cmd.match(re1) ?? cmd.match(re2) ?? cmd.match(re3);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 && n < 65536 ? n : null;
}

export function ProcessRow(props: Props) {
  return <ProcessRowInner {...props} />;
}

/**
 * 渲染体：直接输出 9 个 grid cells（顺序：Actions | PRJ | Name | Type | Uptime |
 * CPU | Memory | Misc | PID），由父级 motion.div（subgrid）统一布局。本组件
 * 不再持有自己的 grid 容器，避免每行独立 grid 造成列宽错位。
 */
const ProcessRowInner = memo(function ProcessRowInner({ process: p, selected, onAfterAction }: Props) {
  const cpuColor = p.cpu_percent > 80 ? "text-accent-red"
    : p.cpu_percent > 40 ? "text-accent-orange"
    : "text-text-primary";

  const handleKill = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Kill process ${p.pid} (${p.name})?`)) return;
    await killProcess(p.pid);
    onAfterAction();
  };

  const handleOpenDir = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await openInExplorer(p.exe_path);
  };

  return (
    <>
      {/* Actions —— 列首：打开目录 + Kill 按钮 */}
      <div className="pl-3 min-w-0 flex items-center gap-1 opacity-80 group-hover:opacity-100 transition relative">
        {/* selected 时左侧高亮指示条（贴在第一列最左） */}
        <div
          className={clsx(
            "absolute -left-0 top-1/2 -translate-y-1/2 h-[18px] w-[2px] transition-opacity",
            selected
              ? "bg-accent-cyan opacity-100"
              : "bg-accent-cyan opacity-0 group-hover:opacity-60"
          )}
          style={{ boxShadow: selected ? "0 0 8px #00E5FF" : undefined }}
        />
        <button
          onClick={handleOpenDir}
          className="w-6 h-6 flex items-center justify-center rounded
                     hover:bg-accent-cyan/20 text-text-secondary hover:text-accent-cyan transition"
          title="Open folder"
        >
          <FolderOpen size={12} />
        </button>
        <button
          onClick={handleKill}
          className="w-6 h-6 flex items-center justify-center rounded
                     bg-accent-red/15 border border-accent-red/40 text-accent-red
                     hover:bg-accent-red/35 hover:border-accent-red/70
                     hover:shadow-[0_0_6px_rgba(255,82,82,0.5)]
                     transition"
          title="Kill process"
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      </div>

      {/* PRJ */}
      <div className="min-w-0 truncate text-left">
        {p.project_name ? (
          <span className="text-accent-cyan font-semibold" title={p.project_name}>
            {p.project_name}
          </span>
        ) : (
          <span className="text-text-dim font-mono text-[11px]">---</span>
        )}
      </div>

      {/* Name (launch label) */}
      <div className="min-w-0 overflow-hidden text-left">
        {p.launch_label ? (
          <span className="inline-block max-w-full truncate align-middle
                           px-1.5 py-0.5 text-[10px] font-semibold rounded
                           bg-accent-purple/15 border border-accent-purple/40 text-accent-purple
                           whitespace-nowrap"
                title={p.launch_label}>
            {p.launch_label}
          </span>
        ) : (
          <span className="text-text-dim text-[11px] font-mono">---</span>
        )}
      </div>

      {/* Type */}
      <div className="min-w-0 text-left">
        <span className={clsx(
          "px-1.5 py-0.5 text-[9px] font-bold rounded border whitespace-nowrap",
          KIND_COLORS[p.kind] ?? KIND_COLORS.Unknown
        )}>
          {KIND_SHORT[p.kind] ?? "?"}
        </span>
      </div>

      {/* Uptime */}
      <div className="min-w-0 truncate font-mono text-text-secondary text-left" title="Uptime">
        {fmtUptime(p.start_time)}
      </div>

      {/* CPU */}
      <div className={clsx("min-w-0 truncate font-mono text-left", cpuColor)}>
        {p.cpu_percent.toFixed(1)}%
      </div>

      {/* Memory */}
      <div className="min-w-0 truncate font-mono text-text-secondary text-left">
        {fmtMem(p.mem_mb)}
      </div>

      {/* Misc — 仅 DS 进程显示端口；默认 7777。该列吃掉剩余宽度（1fr）。 */}
      <div className="min-w-0 truncate text-text-secondary font-mono text-[11px] text-left">
        {(() => {
          const isDS = p.kind === "DedicatedServer" || /(^|\s)-server(\s|$)/i.test(p.cmdline ?? "");
          if (!isDS) return <span className="text-text-dim">---</span>;
          const port = parsePort(p.cmdline) ?? 7777;
          return (
            <span className="text-accent-purple" title={`Port ${port}`}>
              :{port}
            </span>
          );
        })()}
      </div>

      {/* PID —— 列尾，紧靠右侧 */}
      <div className="min-w-0 truncate font-mono text-text-secondary text-left pr-3">
        {p.pid}
      </div>
    </>
  );
}, areRowPropsEqual);

/**
 * 自定义浅比较：只关注会影响渲染输出的字段，并对 cpu/mem 加抖动阈值。
 * - cpu / mem 抖动 < 0.5 不重渲染（视觉无差异）
 * - kind / project_name / launch_label / exe_path / cmdline 变化要更新
 */
function areRowPropsEqual(prev: Props, next: Props): boolean {
  if (prev.selected !== next.selected) return false;
  if (prev.onAfterAction !== next.onAfterAction) return false;

  const a = prev.process;
  const b = next.process;
  if (a === b) return true;
  if (a.pid !== b.pid) return false;
  if (a.kind !== b.kind) return false;
  if (a.project_name !== b.project_name) return false;
  if (a.launch_label !== b.launch_label) return false;
  if (a.exe_path !== b.exe_path) return false;
  if (a.cmdline !== b.cmdline) return false;
  if (a.start_time !== b.start_time) return false;

  // CPU 抖动 < 0.5% 视为无变化
  if (Math.abs(a.cpu_percent - b.cpu_percent) > 0.5) return false;
  // 内存 < 1MB 抖动视为无变化
  if (Math.abs(a.mem_mb - b.mem_mb) > 1) return false;

  return true;
}
