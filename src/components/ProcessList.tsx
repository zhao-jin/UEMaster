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
 * 整表共享的 grid 列模板。
 * 顺序：Actions | PRJ | Name | Type | Uptime | CPU | Memory | Misc | PID
 *
 * 设计要点：
 *  1) 整张表（表头 + 所有 ProcessRow）共用**同一个** grid 容器，每行通过 CSS subgrid
 *     继承本列模板。这样 max-content / 1fr 在整表全局求值，不再像以前那样"每行各
 *     自一个 grid"导致列宽错位。
 *  2) 大部分列用 max-content，按整列最长内容自适应。Misc 用 1fr 吃掉剩余宽度，
 *     PID 仍保留 max-content（它在最右，让数字紧靠右侧不浪费宽度）。
 *  3) PRJ 设 minmax(56px, max-content)，下界保证空数据时也能撑出表头宽。
 */
export const PROC_COLS =
  "grid-cols-[max-content_minmax(56px,max-content)_max-content_max-content_max-content_max-content_max-content_minmax(60px,1fr)_max-content]";

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
    <div className="relative h-full overflow-y-auto overflow-x-auto" onClick={handleBgClick}>
      {/* 整表共享 grid —— 表头 + 每行通过 subgrid 共享列轨道，保证列宽全局对齐。
          gap-x 控制列间距，行间距 gap-y=0（行间靠 border-bottom 分隔）。 */}
      <div className={`grid ${PROC_COLS} gap-x-2`}>
        {/* 表头：display:contents 让 9 个 cell 直接成为外层 grid 的子项；
            sticky 由每个 cell 自己承担（统一 top-0），而不是 wrapper。 */}
        <div className="contents">
          {[
            "Actions", "PRJ", "Name", "Type", "Uptime",
            "CPU", "Memory", "Misc", "PID",
          ].map((h, i) => (
            <div
              key={i}
              className="sticky top-0 z-10 px-3 py-2
                         text-[10px] uppercase tracking-wider text-text-dim text-left
                         bg-bg-base/60 backdrop-blur border-b border-border-subtle
                         first:pl-3 last:pr-3"
            >
              {h}
            </div>
          ))}
        </div>

        <AnimatePresence initial={false}>
          {processes.map((p) => (
            <motion.div
              key={p.pid}
              data-process-row
              onClick={() => handleSelect(p.pid)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className={`group relative col-span-full grid grid-cols-subgrid gap-x-2 items-center
                          py-2 text-xs border-b border-border-subtle/50 cursor-pointer
                          transition-colors ${
                            selectedPid === p.pid
                              ? "bg-accent-cyan/10 hover:bg-accent-cyan/15"
                              : "hover:bg-bg-rowHover"
                          }`}
            >
              <ProcessRow
                process={p}
                selected={selectedPid === p.pid}
                onAfterAction={handleAfter}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
