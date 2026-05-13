import { AnimatePresence, motion } from "framer-motion";
import { useCallback } from "react";
import { ProcessRow } from "./ProcessRow";
import type { UeProcess } from "../lib/ipc";
import { Hexagon } from "lucide-react";

interface Props {
  processes: UeProcess[];
  selectedPid: number | null;
  onSelect: (pid: number) => void;
  /** 在行外（空白区/表头）单击时触发 —— 用于取消选中 */
  onClickOutsideRow?: () => void;
  onAfterAction: () => void;
}

/**
 * 列模板 — 共享给表头和每一行，保持对齐。
 * 顺序：PRJ | Name | PID | Type | CPU | Memory | I/O | Uptime | Misc | Actions
 *  - Misc 拿走全部剩余宽度（1fr），其他列按内容自适应
 */
export const PROC_COLS =
  "grid-cols-[minmax(64px,max-content)_minmax(48px,max-content)_minmax(48px,auto)_minmax(56px,auto)_minmax(56px,auto)_minmax(64px,auto)_minmax(72px,auto)_minmax(48px,auto)_minmax(80px,1fr)_minmax(56px,max-content)]";

export function ProcessList({ processes, selectedPid, onSelect, onClickOutsideRow, onAfterAction }: Props) {
  // onSelect/onAfterAction 对外引用稳定即可向下透传给 React.memo 的 ProcessRow
  const handleSelect = useCallback((pid: number) => onSelect(pid), [onSelect]);
  const handleAfter = useCallback(() => onAfterAction(), [onAfterAction]);

  const handleBgClick = (e: React.MouseEvent) => {
    // 只在点到行外（包括表头/空白处/底部空白）时触发
    const target = e.target as HTMLElement;
    if (!target.closest("[data-process-row]")) {
      onClickOutsideRow?.();
    }
  };

  if (processes.length === 0) {
    return (
      <div
        onClick={handleBgClick}
        className="h-full flex flex-col items-center justify-center text-text-dim animate-fade-in"
      >
        <Hexagon size={48} className="text-accent-cyan/40 animate-pulse-glow" />
        <div className="mt-3 text-sm">No UE Editor running</div>
        <div className="mt-1 text-xs">Press Alt+` to toggle, or click "New" to launch one.</div>
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-y-auto" onClick={handleBgClick}>
      {/* 表头 */}
      <div className={`sticky top-0 z-10 grid ${PROC_COLS} gap-2
                      px-3 py-2 text-[10px] uppercase tracking-wider text-text-dim
                      bg-bg-base/60 backdrop-blur border-b border-border-subtle`}>
        <div>PRJ</div>
        <div>Name</div>
        <div>PID</div>
        <div>Type</div>
        <div>CPU</div>
        <div>Memory</div>
        <div>I/O</div>
        <div>Uptime</div>
        <div>Misc</div>
        <div>Actions</div>
      </div>

      <AnimatePresence initial={false}>
        {processes.map((p) => (
          <motion.div
            key={p.pid}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            transition={{ duration: 0.18 }}
          >
            <ProcessRow
              process={p}
              selected={selectedPid === p.pid}
              onSelect={handleSelect}
              onAfterAction={handleAfter}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
