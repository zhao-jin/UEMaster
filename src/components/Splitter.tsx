import { useRef } from "react";

interface Props {
  /** 当前 detail 宽度（px） */
  width: number;
  /** 容器宽度（用于计算最大值边界） */
  containerWidth: number;
  /** 主面板最小保留宽度，避免拖到看不见 */
  minMain?: number;
  minDetail?: number;
  maxDetail?: number;
  onChange: (next: number) => void;
}

/**
 * 主面板与详情面板之间的可拖动分割条。
 * 拖动只改变 detailWidth；窗口尺寸保持不变（主面板 flex-1 自动让出宽度）。
 */
export function Splitter({
  width,
  containerWidth,
  minMain = 360,
  minDetail = 240,
  maxDetail = 800,
  onChange,
}: Props) {
  const dragging = useRef(false);

  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startW = width;
    let raf: number | null = null;
    let latestX = startX;
    const flush = () => {
      raf = null;
      // 向左拖（dx < 0）→ detail 加宽；向右拖 → detail 变窄
      let next = startW - (latestX - startX);
      // 边界
      const ceil = Math.min(maxDetail, Math.max(minDetail, containerWidth - minMain));
      next = Math.max(minDetail, Math.min(ceil, next));
      onChange(Math.round(next));
    };
    const onMove = (ev: MouseEvent) => {
      latestX = ev.clientX;
      if (raf == null) raf = requestAnimationFrame(flush);
    };
    const onUp = () => {
      dragging.current = false;
      if (raf != null) {
        cancelAnimationFrame(raf);
        flush();
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      onMouseDown={start}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize"
      className="group relative shrink-0 w-1.5 h-full cursor-col-resize
                 bg-border-subtle/40 hover:bg-accent-cyan/40 active:bg-accent-cyan/60 transition-colors"
    >
      {/* 命中区扩展（左右各 +3px），鼠标更容易抓到，不影响视觉宽度 */}
      <div className="absolute inset-y-0 -left-1 -right-1" />
      {/* hover 时的高亮提示线 */}
      <div className="absolute inset-y-2 left-1/2 -translate-x-1/2 w-px
                      bg-transparent group-hover:bg-accent-cyan/70 transition-colors" />
    </div>
  );
}
