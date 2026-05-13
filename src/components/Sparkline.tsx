import { memo, useEffect, useId, useMemo, useRef, useState } from "react";

interface Props {
  data: number[];
  /** 不传则按容器宽度自适应 */
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  /** 固定上限，否则自动取 max(viewSlice)（最少 1） */
  max?: number;
  unit?: string;
  label?: string;
  current?: number | string;
  /** 采样间隔（秒），用于 hover tooltip 显示 "Xs ago" */
  sampleIntervalSec?: number;
  /** 可视范围（索引）：[viewStart, viewEnd]，闭区间。不传则显示全部 */
  viewStart?: number;
  viewEnd?: number;
}

export const Sparkline = memo(function Sparkline({
  data,
  width,
  height = 56,
  stroke = "#00E5FF",
  fill = "rgba(0, 229, 255, 0.15)",
  max,
  unit,
  label,
  current,
  sampleIntervalSec = 2,
  viewStart,
  viewEnd,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoW, setAutoW] = useState<number>(width ?? 200);

  // ResizeObserver：容器宽度变化时刷新 sparkline 渲染宽度
  useEffect(() => {
    if (width !== undefined) return;
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const w = Math.max(40, Math.floor(e.contentRect.width));
        setAutoW(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  const w = width ?? autoW;
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  // 计算可视片段（超长时按渲染宽度抽稀，避免 SVG path 过长拖慢渲染）
  const view = useMemo(() => {
    if (data.length === 0) return { slice: [] as number[], start: 0 };
    const s = Math.max(0, Math.min(viewStart ?? 0, data.length - 1));
    const e = Math.max(s, Math.min(viewEnd ?? data.length - 1, data.length - 1));
    const raw = data.slice(s, e + 1);
    // 目标点数：每个像素 2 个点足够；当 raw 长度超过该值时做"块最大值"抽稀
    const target = Math.max(60, Math.floor((width ?? autoW) * 2));
    if (raw.length <= target) return { slice: raw, start: s };
    const bucket = raw.length / target;
    const out: number[] = new Array(target);
    for (let i = 0; i < target; i++) {
      const a = Math.floor(i * bucket);
      const b = Math.min(raw.length, Math.floor((i + 1) * bucket));
      let m = raw[a];
      for (let k = a + 1; k < b; k++) if (raw[k] > m) m = raw[k];
      out[i] = m;
    }
    return { slice: out, start: s };
  }, [data, viewStart, viewEnd, width, autoW]);

  const { path, area, peak, points } = useMemo(() => {
    const slice = view.slice;
    if (slice.length === 0) {
      return { path: "", area: "", peak: 0, points: [] as Array<readonly [number, number]> };
    }
    const peakV = Math.max(1, max ?? Math.max(...slice));
    const stepX = slice.length > 1 ? w / (slice.length - 1) : 0;
    const pts = slice.map((v, i) => {
      const x = i * stepX;
      const y = height - (Math.min(v, peakV) / peakV) * (height - 4) - 2;
      return [x, y] as const;
    });
    const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const a = `${d} L${pts[pts.length - 1][0].toFixed(1)},${height} L0,${height} Z`;
    return { path: d, area: a, peak: peakV, points: pts };
  }, [view, w, height, max]);

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (view.slice.length === 0) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const stepX = view.slice.length > 1 ? w / (view.slice.length - 1) : 0;
    const idx = stepX > 0 ? Math.round(x / stepX) : 0;
    const clamped = Math.max(0, Math.min(view.slice.length - 1, idx));
    const [px, py] = points[clamped];
    setHover({ i: clamped, x: px, y: py });
  };

  const handleLeave = () => setHover(null);

  // 稳定的 SVG gradient id，避免 Math.random 引发 DOM 重解析
  const reactId = useId();
  const gradId = useMemo(
    () => `sparkfill-${reactId.replace(/[:]/g, "")}`,
    [reactId]
  );

  const fmtVal = (v: number): string => {
    if (v >= 1024) return (v / 1024).toFixed(2) + "K";
    return v < 10 ? v.toFixed(1) : Math.round(v).toString();
  };

  const hoverVal = hover ? view.slice[hover.i] : null;
  // hover 索引在 slice 内；用整体 data.length 计算"距最新多久"
  const ageSec = hover != null
    ? (data.length - 1 - (view.start + hover.i)) * sampleIntervalSec
    : 0;
  const ageStr = ageSec === 0 ? "now" : ageSec < 60 ? `${ageSec}s ago`
    : ageSec < 3600 ? `${(ageSec / 60).toFixed(0)}m ago`
    : `${(ageSec / 3600).toFixed(1)}h ago`;

  return (
    <div ref={containerRef} className="w-full">
      {(label || current !== undefined) && (
        <div className="flex items-baseline justify-between mb-1">
          {label && <div className="text-[9px] uppercase tracking-wider text-text-dim">{label}</div>}
          {current !== undefined && (
            <div className="text-[10px] font-mono text-text-primary">
              {current}{unit ? ` ${unit}` : ""}
              <span className="ml-1.5 text-text-dim">peak {fmtVal(peak)}{unit ? ` ${unit}` : ""}</span>
            </div>
          )}
        </div>
      )}
      <div className="relative">
        <svg
          width={w}
          height={height}
          viewBox={`0 0 ${w} ${height}`}
          preserveAspectRatio="none"
          className="block"
          onMouseMove={handleMove}
          onMouseLeave={handleLeave}
          style={{ cursor: view.slice.length > 0 ? "crosshair" : "default" }}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={fill} stopOpacity="1" />
              <stop offset="100%" stopColor={fill} stopOpacity="0" />
            </linearGradient>
          </defs>
          {view.slice.length > 0 && (
            <>
              <path d={area} fill={`url(#${gradId})`} />
              <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
              {hover && (
                <>
                  <line
                    x1={hover.x}
                    x2={hover.x}
                    y1={0}
                    y2={height}
                    stroke={stroke}
                    strokeOpacity="0.35"
                    strokeWidth="1"
                  />
                  <circle cx={hover.x} cy={hover.y} r="3" fill={stroke} stroke="#0A0E1A" strokeWidth="1" />
                </>
              )}
            </>
          )}
          {view.slice.length === 0 && (
            <text x={w / 2} y={height / 2} fill="#5A6479" fontSize="9" textAnchor="middle" dominantBaseline="middle">
              collecting…
            </text>
          )}
        </svg>

        {hover && hoverVal !== null && (
          <div
            className="pointer-events-none absolute text-[10px] font-mono z-10
                       text-shadow whitespace-nowrap"
            style={{
              left: Math.max(0, Math.min(w - 80, hover.x - 40)),
              top: Math.max(-28, hover.y - 28),
              minWidth: 80,
              textAlign: "center",
              textShadow: "0 0 4px #0A0E1A, 0 0 4px #0A0E1A, 0 1px 2px rgba(0,0,0,0.9)",
            }}
          >
            <span style={{ color: stroke, fontWeight: 600 }}>{fmtVal(hoverVal)}{unit ? ` ${unit}` : ""}</span>
            <span className="ml-1.5 text-text-dim">{ageStr}</span>
          </div>
        )}
      </div>
    </div>
  );
});
