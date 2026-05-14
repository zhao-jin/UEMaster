import { Window } from "@tauri-apps/api/window";
import { Minus, X, Hexagon } from "lucide-react";
import { hideWindow } from "../lib/ipc";

export function TitleBar() {
  const win = Window.getCurrent();

  return (
    <div className="drag-region h-10 flex items-center justify-between px-3 border-b border-border-subtle">
      <div className="flex items-center gap-2 no-drag select-none">
        <Hexagon size={16} className="text-accent-purple animate-pulse-glow" />
        <span className="text-sm font-semibold tracking-wide">
          UE <span className="text-accent-purple">Master</span>
        </span>
        <span className="text-[10px] text-text-dim font-mono ml-1">v0.1</span>
        <span
          className="text-[10px] text-text-dim/70 italic ml-2"
          title="UEMaster by miles"
        >
          by&nbsp;miles
        </span>
      </div>
      <div className="flex items-center gap-1 no-drag">
        <button
          onClick={() => win.minimize()}
          className="w-8 h-7 flex items-center justify-center rounded hover:bg-white/5 transition"
          title="Minimize"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={() => hideWindow()}
          className="w-8 h-7 flex items-center justify-center rounded hover:bg-accent-red/20 hover:text-accent-red transition"
          title="Hide to tray (Alt+`)"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
