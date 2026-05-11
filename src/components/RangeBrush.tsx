import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  /** 总样本数（最近的在末尾） */
  total: number;
  /** 当前选择 [start, end]，闭区间，索引基于完整 data 数组 */
  start: number;
  end: number;
  /** 用于绘制缩略波形的源数据（CPU 比较直观） */
  preview?: number[];
  /** 采样间隔（秒），用于显示时间窗 */
  sampleIntervalSec?: number;
  height?: number;
  onChange: (start: number, end: number) => void;
  /** 一键复位到"全部时间" */
  onReset?: () => void;
}

const HANDLE_W = 6;

/**
 * 时间范围选择条：
 *  - 上方一条 mini 波形（缩略图，不可交互）
 *  - 中间高亮窗口可整体平移
 *  - 两端有把手可单独拖动改变左右边界
 */
export function RangeBrush({
  total,
  start,
  end,
  preview,
  sampleIntervalSec = 2,
  height = 28,
  onChange,
  onReset,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(200);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setW(Math.max(80, Math.floor(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 索引 ↔ 像素的换算
  const idxToX = (i: number) => (total <= 1 ? 0 : (i / (total - 1)) * w);
  const xToIdx = (x: number) => {
    if (total <= 1) return 0;
    return Math.round((x / w) * (total - 1));
  };

  const xL = Math.max(0, Math.min(w, idxToX(start)));
  const xR = Math.max(0, Math.min(w, idxToX(end)));

  // 缩略波形 path
  const previewPath = useMemo(() => {
    if (!preview || preview.length < 2) return "";
    const peak = Math.max(1, ...preview);
    const stepX = w / (preview.length - 1);
    return preview
      .map((v, i) => {
        const x = i * stepX;
        const y = height - (Math.min(v, peak) / peak) * (height - 4) - 2;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [preview, w, height]);

  type DragMode = "left" | "right" | "move";
  const dragRef = useRef<{ mode: DragMode; startX: number; s: number; e: number } | null>(null);

  const onDown = (mode: DragMode) => (ev: React.MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    dragRef.current = { mode, startX: ev.clientX, s: start, e: end };
    let raf: number | null = null;
    let latestX = ev.clientX;
    const flush = () => {
      raf = null;
      const d = dragRef.current;
      if (!d) return;
      const dx = latestX - d.startX;
      const di = total <= 1 ? 0 : Math.round((dx / w) * (total - 1));
      let s = d.s;
      let e = d.e;
      const minSpan = Math.min(2, total - 1); // 至少两个点
      if (d.mode === "left") {
        s = Math.max(0, Math.min(d.s + di, d.e - minSpan));
      } else if (d.mode === "right") {
        e = Math.max(d.s + minSpan, Math.min(d.e + di, total - 1));
      } else {
        // move：保持区间长度，整体平移
        const span = d.e - d.s;
        s = Math.max(0, Math.min(d.s + di, total - 1 - span));
        e = s + span;
      }
      onChange(s, e);
    };
    const onMove = (mev: MouseEvent) => {
      latestX = mev.clientX;
      if (raf == null) raf = requestAnimationFrame(flush);
    };
    const onUp = () => {
      if (raf != null) {
        cancelAnimationFrame(raf);
        flush();
      }
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = mode === "move" ? "grabbing" : "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const fmtAge = (samplesFromEnd: number) => {
    const s = samplesFromEnd * sampleIntervalSec;
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${(s / 60).toFixed(0)}m`;
    return `${(s / 3600).toFixed(1)}h`;
  };

  const isFull = start <= 0 && end >= total - 1;

  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-[9px] uppercase tracking-wider text-text-dim">Time Range</div>
        <div className="text-[10px] font-mono text-text-dim flex items-center gap-2">
          <span>{fmtAge(total - 1 - start)} ago</span>
          <span className="text-text-dim/50">→</span>
          <span>{fmtAge(total - 1 - end)} ago</span>
          {!isFull && onReset && (
            <button
              onClick={onReset}
              className="ml-1 px-1.5 py-0.5 text-[9px] rounded
                         bg-white/5 hover:bg-accent-cyan/20 text-text-dim hover:text-accent-cyan transition"
              title="Show all time"
            >
              Reset
            </button>
          )}
        </div>
      </div>
      <div
        ref={ref}
        className="relative w-full select-none"
        style={{ height }}
      >
        {/* 缩略波形背景 */}
        <svg
          width={w}
          height={height}
          viewBox={`0 0 ${w} ${height}`}
          preserveAspectRatio="none"
          className="absolute inset-0 block"
        >
          <rect x="0" y="0" width={w} height={height} fill="rgba(255,255,255,0.03)" />
          {previewPath && (
            <path d={previewPath} fill="none" stroke="rgba(0,229,255,0.5)" strokeWidth="1" />
          )}
        </svg>

        {/* 选中窗口 + 拖动整体 */}
        <div
          onMouseDown={onDown("move")}
          className="absolute top-0 bottom-0 bg-accent-cyan/15
                     border-x border-accent-cyan/60 cursor-grab active:cursor-grabbing"
          style={{ left: xL, width: Math.max(2, xR - xL) }}
        />

        {/* 左把手 */}
        <div
          onMouseDown={onDown("left")}
          className="absolute top-0 bottom-0 bg-accent-cyan hover:bg-accent-cyan
                     cursor-col-resize z-10"
          style={{ left: Math.max(0, xL - HANDLE_W / 2), width: HANDLE_W, opacity: 0.85 }}
        />
        {/* 右把手 */}
        <div
          onMouseDown={onDown("right")}
          className="absolute top-0 bottom-0 bg-accent-cyan hover:bg-accent-cyan
                     cursor-col-resize z-10"
          style={{ left: Math.max(0, xR - HANDLE_W / 2), width: HANDLE_W, opacity: 0.85 }}
        />
      </div>
    </div>
  );
}
