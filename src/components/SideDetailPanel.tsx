import { useEffect, useMemo, useState } from "react";
import type { UeProcess } from "../lib/ipc";
import {
  Terminal, FolderTree, ChevronRight, X,
} from "lucide-react";
import { Sparkline } from "./Sparkline";
import { RangeBrush } from "./RangeBrush";

interface Props {
  process: UeProcess | null;
  open: boolean;
  width: number;          // panel 内容区宽度
  onClose: () => void;
}

export function SideDetailPanel({ process: p, open, width, onClose }: Props) {
  if (!open) return null;
  return (
    <aside
      style={{ width }}
      className="relative shrink-0 h-full border-l border-border-subtle bg-black/20
                 overflow-hidden flex flex-col animate-fade-in"
    >
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border-subtle">
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/5 text-text-secondary"
          title="Collapse details"
        >
          <ChevronRight size={14} />
        </button>
        <span className="text-[10px] uppercase tracking-wider text-text-dim">Details</span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-accent-red/20 text-text-secondary hover:text-accent-red"
          title="Close"
        >
          <X size={12} />
        </button>
      </div>

      {p ? <DetailContent p={p} /> : <EmptyHint />}
    </aside>
  );
}

function EmptyHint() {
  return (
    <div className="flex-1 flex items-center justify-center text-text-dim text-xs px-4 text-center">
      Click a process row to inspect its CPU / memory / I/O history and command line.
    </div>
  );
}

function DetailContent({ p }: { p: UeProcess }) {
  // 总样本数（三条曲线长度一致；以 cpu 为基准）
  const total = p.history.cpu.length;

  // 时间窗口选择 [viewStart, viewEnd]；默认全量
  const [view, setView] = useState<{ s: number; e: number; followLatest: boolean }>(
    { s: 0, e: Math.max(0, total - 1), followLatest: true }
  );

  // 切换进程时复位
  useEffect(() => {
    setView({ s: 0, e: Math.max(0, total - 1), followLatest: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.pid]);

  // 数据增长时：如果窗口当前贴在末尾（followLatest），跟随新点；否则保持索引不动
  useEffect(() => {
    setView(prev => {
      if (prev.followLatest) {
        return { s: 0, e: Math.max(0, total - 1), followLatest: true };
      }
      // 不跟随：保持 s/e 不变，但截断到合法范围
      const e = Math.min(prev.e, Math.max(0, total - 1));
      const s = Math.min(prev.s, e);
      return { s, e, followLatest: false };
    });
  }, [total]);

  const onBrushChange = (s: number, e: number) => {
    // 用户拖到末尾就重新进入"跟随"模式
    const followLatest = e >= total - 1;
    setView({ s, e, followLatest });
  };
  const onReset = () => setView({ s: 0, e: Math.max(0, total - 1), followLatest: true });

  // 视图边界（兜底）
  const viewS = Math.max(0, Math.min(view.s, Math.max(0, total - 1)));
  const viewE = Math.max(viewS, Math.min(view.e, Math.max(0, total - 1)));
  const isFull = viewS <= 0 && viewE >= total - 1;

  // 缩略图 preview 用 cpu 序列
  const preview = useMemo(() => p.history.cpu, [p.history.cpu]);

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="flex items-center gap-2 pb-2 border-b border-border-subtle flex-wrap">
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

      {/* Command Line — 放在最前面 */}
      <Section icon={<Terminal size={11} />} title="Command Line">
        <div
          className="font-mono text-[10px] text-text-secondary leading-relaxed
                     max-h-40 overflow-y-auto break-all whitespace-pre-wrap select-text cursor-text"
          style={{ userSelect: "text" }}
          onClick={async (e) => {
            try {
              await navigator.clipboard.writeText(p.cmdline);
              const target = e.currentTarget;
              const old = target.style.outline;
              target.style.outline = "1px solid #00E5FF";
              setTimeout(() => { target.style.outline = old; }, 400);
            } catch { /* ignore */ }
          }}
          title="Click to copy"
        >
          {p.cmdline || "(empty)"}
        </div>
      </Section>

      {/* 历史曲线（共享 viewStart/viewEnd） */}
      <div className="mt-3 space-y-2.5">
        <Sparkline
          data={p.history.cpu}
          viewStart={viewS}
          viewEnd={viewE}
          label={`CPU history${isFull ? "" : " (zoomed)"}`}
          unit="%"
          current={p.cpu_percent.toFixed(1)}
          stroke="#00E5FF"
          fill="rgba(0, 229, 255, 0.18)"
          height={42}
        />
        <Sparkline
          data={p.history.mem_mb}
          viewStart={viewS}
          viewEnd={viewE}
          label={`Memory history${isFull ? "" : " (zoomed)"}`}
          unit="MB"
          current={p.mem_mb}
          stroke="#7C4DFF"
          fill="rgba(124, 77, 255, 0.18)"
          height={42}
        />
        <Sparkline
          data={p.history.io_kbps}
          viewStart={viewS}
          viewEnd={viewE}
          label={`I/O Bytes/s history${isFull ? "" : " (zoomed)"}`}
          unit="KB/s"
          current={p.io_kbps}
          stroke="#00E676"
          fill="rgba(0, 230, 118, 0.18)"
          height={42}
        />

        {/* 时间范围选择条 */}
        {total > 1 && (
          <div className="pt-1">
            <RangeBrush
              total={total}
              start={viewS}
              end={viewE}
              preview={preview}
              onChange={onBrushChange}
              onReset={onReset}
            />
          </div>
        )}
      </div>

      {p.exe_path && (
        <Section icon={<FolderTree size={11} />} title="Executable">
          <div className="font-mono text-[10px] text-text-secondary break-all"
               style={{ userSelect: "text" }}>
            {p.exe_path}
          </div>
        </Section>
      )}

      {p.cwd && (
        <Section icon={<FolderTree size={11} />} title="Working Directory">
          <div className="font-mono text-[10px] text-text-secondary break-all"
               style={{ userSelect: "text" }}>
            {p.cwd}
          </div>
        </Section>
      )}

      {p.children.length > 0 && (
        <Section icon={<FolderTree size={11} />} title={`Children (${p.children.length})`}>
          <div className="font-mono text-[10px] text-text-secondary">
            {p.children.join(", ")}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div className="flex items-center gap-1 text-[9px] text-text-dim uppercase tracking-wider mb-1">
        {icon} {title}
      </div>
      {children}
    </div>
  );
}
