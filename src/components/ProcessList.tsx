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
 *
 * 关键约束：每一行（ProcessRow）都是独立的 grid 容器，并不共享父级 grid 的 track
 * 计算结果。这意味着 max-content / fit-content 在每行都会"按本行内容"重新求值，
 * 导致同一逻辑列在不同行上出现宽度差（例如 Name="Editor" 与 Name="DS71001"）。
 *
 * 因此这里**所有列都使用边界明确的 minmax(min, max)**——min/max 都是显式像素值，
 * 让浏览器只在该范围内挑列宽且不依赖具体行内容；同时所有列内容靠左对齐，整表对齐。
 *
 * 单位放宽以容纳真实数据：
 *  - Name label 实测最长 "DS71001"≈68px 加 padding → 96px 上限够用
 *  - Memory 最长 "12.43 GB" ≈ 60px → 80px 上限
 *  - I/O 最长 "11.3 MB/s" ≈ 70px → 84px 上限
 *  - Uptime 最长 "9999d" / "23h 59m" ≈ 60px → 76px 上限
 *
 * 整表横向溢出由父容器 overflow-x-auto 兜底（窄窗时可滚）。
 */
export const PROC_COLS =
  "grid-cols-[minmax(56px,1fr)_96px_64px_72px_64px_80px_84px_76px_60px_64px]";

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
      {/* 表头 */}
      <div className={`sticky top-0 z-10 grid ${PROC_COLS} gap-2
                      px-3 py-2 text-[10px] uppercase tracking-wider text-text-dim text-left
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
