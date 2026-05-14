import { FolderOpen, X } from "lucide-react";
import clsx from "clsx";
import { memo } from "react";
import type { UeProcess } from "../lib/ipc";
import { killProcess, openInExplorer } from "../lib/ipc";
import { PROC_COLS } from "./ProcessList";

interface Props {
  process: UeProcess;
  selected: boolean;
  /** 接收 pid 的稳定回调（避免父组件每次新建 inline arrow 破坏 memo） */
  onSelect: (pid: number) => void;
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

function fmtIo(kbps: number) {
  if (kbps >= 1024) return (kbps / 1024).toFixed(1) + " MB/s";
  return kbps + " KB/s";
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

/** 真正的渲染体；用 React.memo 包裹，cpu/mem/io 抖动 < 阈值时不重渲染。 */
const ProcessRowInner = memo(function ProcessRowInner({ process: p, selected, onSelect, onAfterAction }: Props) {
  const cpuColor = p.cpu_percent > 80 ? "text-accent-red"
    : p.cpu_percent > 40 ? "text-accent-orange"
    : "text-text-primary";

  const ioColor = p.io_kbps > 0 ? "text-accent-green" : "text-text-secondary";

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
    <div
      data-process-row
      onClick={() => onSelect(p.pid)}
      className={clsx(
        "group relative grid",
        PROC_COLS,
        "gap-2 items-center",
        "px-3 py-2 text-xs border-b border-border-subtle/50 cursor-pointer transition-colors",
        selected
          ? "bg-accent-cyan/10 hover:bg-accent-cyan/15"
          : "hover:bg-bg-rowHover"
      )}
    >
      {/* selected 时左侧持续高亮指示条 */}
      <div
        className={clsx(
          "absolute left-0 top-1.5 bottom-1.5 w-[2px] transition-opacity",
          selected
            ? "bg-accent-cyan opacity-100"
            : "bg-accent-cyan opacity-0 group-hover:opacity-60"
        )}
        style={{ boxShadow: selected ? "0 0 8px #00E5FF" : undefined }}
      />

      {/* PRJ */}
      <div className="truncate min-w-0">
        {p.project_name ? (
          <span className="text-accent-cyan font-semibold truncate" title={p.project_name}>
            {p.project_name}
          </span>
        ) : (
          <span className="text-text-dim font-mono text-[11px]">---</span>
        )}
      </div>

      {/* Name (launch label) — 列模板用 fit-content(120px)，短 label 自然宽，超长按 120px 截断 */}
      <div className="overflow-hidden">
        {p.launch_label ? (
          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded
                           bg-accent-purple/15 border border-accent-purple/40 text-accent-purple
                           whitespace-nowrap"
                title={p.launch_label}>
            {p.launch_label}
          </span>
        ) : (
          <span className="text-text-dim text-[11px] font-mono">---</span>
        )}
      </div>

      <div className="font-mono text-text-secondary">{p.pid}</div>

      <div>
        <span className={clsx(
          "px-1.5 py-0.5 text-[9px] font-bold rounded border",
          KIND_COLORS[p.kind] ?? KIND_COLORS.Unknown
        )}>
          {KIND_SHORT[p.kind] ?? "?"}
        </span>
      </div>

      <div className={clsx("font-mono", cpuColor)}>
        {p.cpu_percent.toFixed(1)}%
      </div>
      <div className="font-mono text-text-secondary">
        {fmtMem(p.mem_mb)}
      </div>
      <div className={clsx("font-mono", ioColor)} title="I/O Bytes/s (Read+Write+Other)">
        {fmtIo(p.io_kbps)}
      </div>
      <div className="font-mono text-text-secondary" title="Uptime">
        {fmtUptime(p.start_time)}
      </div>

      {/* Misc — 仅 DS 进程（命令行带 -server）显示端口；默认 7777 */}
      <div className="truncate min-w-0 text-text-secondary font-mono text-[11px]">
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

      <div className="flex items-center gap-1 opacity-70 group-hover:opacity-100 transition">
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
    </div>
  );
}, areRowPropsEqual);

/**
 * 自定义浅比较：只关注会影响渲染输出的字段，并对 cpu/mem 加抖动阈值。
 * - cpu / mem 抖动 < 0.5 不重渲染（视觉无差异）
 * - io_kbps 跨 0 边界时仍然要更新（绿色/灰色切换）
 * - kind / project_name / launch_label / exe_path / cmdline 变化要更新
 */
function areRowPropsEqual(prev: Props, next: Props): boolean {
  if (prev.selected !== next.selected) return false;
  if (prev.onSelect !== next.onSelect) return false;
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
  // IO 0 边界要保留响应
  if ((a.io_kbps > 0) !== (b.io_kbps > 0)) return false;
  // IO 数值差异 > 5% 才更新
  const ioDiff = Math.abs(a.io_kbps - b.io_kbps);
  if (ioDiff > 1 && ioDiff > Math.max(a.io_kbps, b.io_kbps) * 0.05) return false;

  return true;
}
