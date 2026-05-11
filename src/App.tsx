import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { TitleBar } from "./components/TitleBar";
import { Toolbar } from "./components/Toolbar";
import { ProcessList } from "./components/ProcessList";
import { StatBar } from "./components/StatBar";
import { NewProcessDialog } from "./components/NewProcessDialog";
import { SideDetailPanel } from "./components/SideDetailPanel";
import { Splitter } from "./components/Splitter";
import { SettingsDialog } from "./components/SettingsDialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useProcesses } from "./hooks/useProcesses";

const DEFAULT_DETAIL_WIDTH = 360;
const STORAGE_KEY_LAYOUT = "ueMaster.layout.v1";

/* 持久化的布局快照 */
interface LayoutState {
  winW?: number;
  winH?: number;
  winX?: number;
  winY?: number;
  detailOpen?: boolean;
  detailWidth?: number;
}

function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_LAYOUT);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return typeof v === "object" && v != null ? v : {};
  } catch {
    return {};
  }
}
function saveLayout(patch: LayoutState) {
  try {
    const cur = loadLayout();
    localStorage.setItem(STORAGE_KEY_LAYOUT, JSON.stringify({ ...cur, ...patch }));
  } catch { /* ignore */ }
}

export default function App() {
  const { processes, refresh, loading } = useProcesses();
  const [showNew, setShowNew] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);

  const initialLayout = useRef<LayoutState>(loadLayout());
  const [detailOpen, setDetailOpen] = useState<boolean>(
    initialLayout.current.detailOpen ?? true
  );
  const [detailWidth, setDetailWidth] = useState<number>(() => {
    const v = initialLayout.current.detailWidth;
    return typeof v === "number" && v >= 240 && v <= 600 ? v : DEFAULT_DETAIL_WIDTH;
  });

  /**
   * 主面板临时锁宽（仅在切换详情页时短暂使用）。
   */
  const [mainLockWidth, setMainLockWidth] = useState<number | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);

  /* 一次性：应用启动时恢复窗口尺寸与位置 */
  useEffect(() => {
    (async () => {
      const L = initialLayout.current;
      try {
        const win = Window.getCurrent();
        if (L.winW != null && L.winH != null && L.winW > 0 && L.winH > 0) {
          await win.setSize(new LogicalSize(
            Math.max(400, Math.min(L.winW, 3840)),
            Math.max(300, Math.min(L.winH, 2160)),
          ));
        }
        if (L.winX != null && L.winY != null) {
          await win.setPosition(new LogicalPosition(L.winX, L.winY));
        } else {
          // 首次启动：居中
          await win.center();
        }
      } catch { /* ignore */ }
    })();
  }, []);

  /* 持久化：detailWidth / detailOpen 变化 */
  useEffect(() => {
    saveLayout({ detailWidth });
  }, [detailWidth]);
  useEffect(() => {
    saveLayout({ detailOpen });
  }, [detailOpen]);

  /* 持久化：窗口 resize / move（Tauri 事件 + 防抖） */
  useEffect(() => {
    const win = Window.getCurrent();
    let timer: number | null = null;
    const captureAndSave = async () => {
      try {
        const size = await win.innerSize();
        const pos = await win.outerPosition();
        const factor = await win.scaleFactor();
        saveLayout({
          winW: Math.round(size.width / factor),
          winH: Math.round(size.height / factor),
          winX: Math.round(pos.x / factor),
          winY: Math.round(pos.y / factor),
        });
      } catch { /* ignore */ }
    };
    const schedule = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { captureAndSave(); }, 250);
    };
    const unResize = win.onResized(() => schedule());
    const unMoved = win.onMoved(() => schedule());
    // 关闭（隐藏到托盘前）立即保存一次，避免 250ms 防抖错过
    const unClose = win.onCloseRequested(() => { captureAndSave(); });
    // 页面卸载也保存一次（兜底）
    const onUnload = () => { captureAndSave(); };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      unResize.then(f => f());
      unMoved.then(f => f());
      unClose.then(f => f());
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);

  useEffect(() => {
    const un = listen("open-new-dialog", () => setShowNew(true));
    return () => { un.then(f => f()); };
  }, []);

  /** 切换详情页：先锁主面板宽度 → setSize → 切换 open → 解锁 */
  const toggleDetail = async () => {
    const nextOpen = !detailOpen;
    const deltaSign = nextOpen ? +1 : -1;
    const delta = deltaSign * detailWidth;

    const lockW = mainRef.current?.getBoundingClientRect().width ?? null;
    if (lockW != null) setMainLockWidth(lockW);

    try {
      const win = Window.getCurrent();
      const size = await win.innerSize();
      const factor = await win.scaleFactor();
      const curW = size.width / factor;
      const curH = size.height / factor;
      const targetW = Math.max(400, Math.min(curW + delta, 2400));
      if (Math.abs(targetW - curW) > 1) {
        await win.setSize(new LogicalSize(targetW, curH));
      }
    } catch { /* ignore */ }

    setDetailOpen(nextOpen);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => setMainLockWidth(null));
    });
  };

  /**
   * 拖动分割线（改变 detailWidth）时：不再同步改变窗口宽度。
   * 主面板 flex-1 自动让出宽度，达到"两侧此消彼长，窗口宽度保持不变"的效果。
   */
  const [containerW, setContainerW] = useState<number>(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setContainerW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const selected = useMemo(() => {
    if (selectedPid == null) return null;
    return processes.find(p => p.pid === selectedPid) ?? null;
  }, [processes, selectedPid]);

  useEffect(() => {
    if (selectedPid != null && !processes.some(p => p.pid === selectedPid)) {
      setSelectedPid(null);
    }
  }, [processes, selectedPid]);

  useEffect(() => {
    if (selectedPid == null && processes.length > 0) {
      setSelectedPid(processes[0].pid);
    }
  }, [processes, selectedPid]);

  return (
    <div className="relative w-full h-full flex app-shell rounded-xl overflow-hidden tech-border">
      <div
        ref={mainRef}
        className={`${mainLockWidth != null ? "shrink-0" : "flex-1"} min-w-0 flex flex-col h-full`}
        style={mainLockWidth != null ? { width: mainLockWidth } : undefined}
      >
        <TitleBar />
        <Toolbar
          onNew={() => setShowNew(true)}
          onRefresh={refresh}
          loading={loading}
          detailOpen={detailOpen}
          onToggleDetail={toggleDetail}
          onOpenSettings={() => setShowSettings(true)}
          onLaunched={refresh}
        />
        <div className="flex-1 overflow-hidden min-w-0">
          <ProcessList
            processes={processes}
            selectedPid={selectedPid}
            onSelect={(pid) => { setSelectedPid(pid); if (!detailOpen) toggleDetail(); }}
            onAfterAction={refresh}
          />
        </div>
        <StatBar processes={processes} onAfterAction={refresh} />
      </div>

      {/* Splitter：放在主面板和详情面板之间 */}
      {detailOpen && (
        <Splitter
          width={detailWidth}
          containerWidth={containerW}
          onChange={setDetailWidth}
        />
      )}

      <SideDetailPanel
        process={selected}
        open={detailOpen}
        width={detailWidth}
        onClose={toggleDetail}
      />

      {showNew && (
        <ErrorBoundary label="NewProcessDialog">
          <NewProcessDialog
            onClose={() => setShowNew(false)}
            onLaunched={() => { setShowNew(false); refresh(); }}
          />
        </ErrorBoundary>
      )}

      {showSettings && (
        <ErrorBoundary label="SettingsDialog">
          <SettingsDialog onClose={() => setShowSettings(false)} />
        </ErrorBoundary>
      )}
    </div>
  );
}
