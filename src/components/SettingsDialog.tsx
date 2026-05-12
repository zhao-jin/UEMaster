import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { X, Settings as SettingsIcon, Check, Keyboard } from "lucide-react";
import { getSettings, updateSettings, type Settings } from "../lib/ipc";

interface Props {
  onClose: () => void;
}

const REFRESH_PRESETS = [1, 2, 5, 10, 30];
const HOTKEY_PRESETS = ["Alt+Backquote", "Alt+KeyQ", "Ctrl+Alt+KeyU", "Ctrl+Shift+KeyU"];

/** 把内部规范名（KeyQ / Digit5 / Backquote）转成显示用的友好名（Q / 5 / `） */
function prettyAccel(accel: string): string {
  if (!accel) return "";
  return accel
    .split("+")
    .map(t => {
      const m1 = /^Key([A-Z])$/.exec(t);
      if (m1) return m1[1];
      const m2 = /^Digit(\d)$/.exec(t);
      if (m2) return m2[1];
      const map: Record<string, string> = {
        Backquote: "`", Backslash: "\\", BracketLeft: "[", BracketRight: "]",
        Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'",
        Minus: "-", Equal: "=",
      };
      return map[t] ?? t;
    })
    .join("+");
}

/**
 * 把浏览器 KeyboardEvent 转成 Tauri global-shortcut accelerator 字符串。
 * 优先使用 e.code（不受输入法/键盘布局影响），fallback 用 e.key。
 * 例：Alt+Q → "Alt+KeyQ"，Alt+` → "Alt+Backquote"，Ctrl+Shift+5 → "Ctrl+Shift+Digit5"。
 * 未按下任何修饰键时返回 null，避免误注册裸字母键。
 */
function eventToAccel(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");

  // 忽略单纯的修饰键
  const k = e.key;
  if (["Control", "Alt", "Shift", "Meta", "OS", "Process", "Dead", "Unidentified"].includes(k)) {
    return null;
  }

  // 优先 e.code（W3C 物理键）：KeyA / Digit5 / Backquote / F1 / Space / ArrowUp...
  // 这些值正好就是 global-hotkey 解析器期望的 token
  let main: string | null = null;
  const code = e.code;
  if (code) {
    if (/^Key[A-Z]$/.test(code)) main = code;             // KeyA..KeyZ
    else if (/^Digit\d$/.test(code)) main = code;          // Digit0..Digit9
    else if (/^Numpad\d$/.test(code)) main = code;
    else if (/^F\d{1,2}$/.test(code)) main = code;         // F1..F24
    else if (
      [
        "Backquote", "Backslash", "BracketLeft", "BracketRight",
        "Comma", "Period", "Slash", "Semicolon", "Quote", "Minus", "Equal",
        "Space", "Tab", "Enter", "Escape", "Backspace",
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        "Home", "End", "PageUp", "PageDown", "Insert", "Delete",
        "CapsLock", "PrintScreen", "ScrollLock", "Pause",
        "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide",
        "NumpadDecimal", "NumpadEnter", "NumpadEqual",
      ].includes(code)
    ) {
      main = code;
    }
  }

  // fallback：e.key 单字符 → 大写
  if (!main) {
    if (k.length === 1) {
      const c = k.toUpperCase();
      if (/[A-Z]/.test(c)) main = `Key${c}`;
      else if (/[0-9]/.test(c)) main = `Digit${c}`;
      else main = c; // 让 Rust 端 normalize_accel 兜底
    } else {
      main = k;
    }
  }

  if (parts.length === 0) return null; // 必须带至少一个修饰键
  return parts.concat(main).join("+");
}

export function SettingsDialog({ onClose }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [refreshSecs, setRefreshSecs] = useState<number>(5);
  const [hotkey, setHotkey] = useState<string>("Alt+Backquote");
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedHint, setSavedHint] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const recordBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await getSettings();
        setSettings(s);
        setRefreshSecs(s.refresh_interval_secs || 5);
        setHotkey(s.hotkey || "Alt+Backquote");
      } catch (e) {
        console.error("getSettings failed", e);
      }
    })();
  }, []);

  // 录制热键：focus 录制框时拦截全局键盘事件
  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const accel = eventToAccel(e);
      if (accel) {
        setHotkey(accel);
        setRecording(false);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording]);

  const handleSave = async () => {
    setSaving(true);
    setErr(null);
    try {
      const v = Math.max(1, Math.min(3600, Math.floor(refreshSecs) || 5));
      const next = await updateSettings({
        refresh_interval_secs: v,
        hotkey: hotkey.trim(),
      });
      setSettings(next);
      setRefreshSecs(next.refresh_interval_secs);
      setHotkey(next.hotkey);
      setSavedHint(true);
      setTimeout(() => setSavedHint(false), 1200);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    settings != null &&
    (settings.refresh_interval_secs !== refreshSecs ||
      (settings.hotkey || "") !== hotkey.trim());

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        onClick={e => e.stopPropagation()}
        className="glass tech-border rounded-xl shadow-panel w-[520px] max-h-[90%] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <SettingsIcon size={16} className="text-accent-cyan" />
            <span className="text-sm font-semibold">Settings</span>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded hover:bg-white/5 flex items-center justify-center">
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Refresh interval */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1.5">
              Process Refresh Interval
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={3600}
                value={refreshSecs}
                onChange={e => setRefreshSecs(parseInt(e.target.value || "0", 10))}
                className="w-20 h-8 px-2 text-xs rounded-md bg-black/30 border border-border-subtle
                           focus:border-accent-cyan/60 outline-none text-right font-mono"
              />
              <span className="text-xs text-text-dim">seconds</span>
              <div className="flex-1" />
              <div className="flex items-center gap-1">
                {REFRESH_PRESETS.map(s => (
                  <button
                    key={s}
                    onClick={() => setRefreshSecs(s)}
                    className={`text-[10px] px-1.5 py-0.5 rounded font-mono transition
                                ${refreshSecs === s
                                  ? "bg-accent-cyan/20 border border-accent-cyan/50 text-accent-cyan"
                                  : "bg-white/5 hover:bg-accent-cyan/10 text-text-dim hover:text-accent-cyan border border-transparent"}`}
                  >
                    {s}s
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-2 text-[11px] text-text-dim leading-relaxed">
              How often UEMaster scans system processes for CPU / memory / I/O.
              Larger values save CPU; smaller values give more responsive charts.
              Default: <span className="font-mono text-text-secondary">5s</span>.
            </div>
          </section>

          {/* Global hotkey */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1.5">
              Global Hotkey (toggle window)
            </div>
            <div className="flex items-center gap-2">
              <div
                ref={recordBoxRef}
                tabIndex={0}
                onClick={() => setRecording(true)}
                onBlur={() => setRecording(false)}
                className={`flex-1 h-8 px-2.5 rounded-md flex items-center gap-2 text-xs font-mono
                            border outline-none transition cursor-text
                            ${recording
                              ? "border-accent-cyan/70 bg-accent-cyan/10 text-accent-cyan ring-2 ring-accent-cyan/30"
                              : "border-border-subtle bg-black/30 text-text-secondary hover:border-accent-cyan/40"}`}
              >
                <Keyboard size={12} className="text-text-dim shrink-0" />
                {recording ? (
                  <span className="text-accent-cyan animate-pulse">Press key combination…</span>
                ) : (
                  <span>{hotkey ? prettyAccel(hotkey) : "(none)"}</span>
                )}
              </div>
              <button
                onClick={() => setRecording(true)}
                className="h-8 px-3 text-[11px] rounded-md
                           bg-accent-cyan/10 hover:bg-accent-cyan/20
                           border border-accent-cyan/30 text-accent-cyan transition"
              >
                Record
              </button>
            </div>
            <div className="flex items-center gap-1 mt-1.5 flex-wrap">
              {HOTKEY_PRESETS.map(k => (
                <button
                  key={k}
                  onClick={() => setHotkey(k)}
                  className={`text-[10px] px-1.5 py-0.5 rounded font-mono transition
                              ${hotkey === k
                                ? "bg-accent-cyan/20 border border-accent-cyan/50 text-accent-cyan"
                                : "bg-white/5 hover:bg-accent-cyan/10 text-text-dim hover:text-accent-cyan border border-transparent"}`}
                >
                  {prettyAccel(k)}
                </button>
              ))}
            </div>
            <div className="mt-2 text-[11px] text-text-dim leading-relaxed">
              Click the box and press a key combination (must include Ctrl / Alt / Shift / Super).
              Default: <span className="font-mono text-text-secondary">Alt+`</span>.
            </div>
          </section>

          {settings && (
            <section className="text-[11px] text-text-dim space-y-1 border-t border-border-subtle/50 pt-3">
              <div>
                <span className="text-text-dim">Start minimized:</span>{" "}
                <span className="font-mono text-text-secondary">{String(settings.start_minimized)}</span>
              </div>
            </section>
          )}

          {err && (
            <div className="text-[11px] text-accent-red bg-accent-red/10 border border-accent-red/30 rounded px-2 py-1.5">
              {err}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle">
          {savedHint && (
            <span className="text-[11px] text-accent-green flex items-center gap-1 mr-2">
              <Check size={12} /> Saved
            </span>
          )}
          <button
            onClick={onClose}
            className="h-8 px-4 text-xs rounded-md hover:bg-white/5 text-text-secondary transition"
          >
            Close
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="h-8 px-4 text-xs rounded-md flex items-center gap-1.5
                       bg-gradient-to-r from-accent-cyan/30 to-accent-purple/30
                       hover:from-accent-cyan/50 hover:to-accent-purple/50
                       border border-accent-cyan/50 text-accent-cyan
                       hover:shadow-glow disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
