import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  X, Rocket, FolderOpen, Pin, Trash2, Plus,
  Clock, Hash, ChevronDown, History as HistoryIcon, FileCode2,
} from "lucide-react";
import {
  type ProjectPreset, type LaunchHistory, type LaunchMode,
  listProjects, listHistory, launchProcess, togglePin, removeHistory,
  upsertProject,
} from "../lib/ipc";

interface Props {
  onClose: () => void;
  onLaunched: () => void;
}

const QUICK_ARGS = ["-server", "-log", "-port="];

/** Frecency 评分：次数 × 时间衰减；置顶巨额加成 */
function score(h: LaunchHistory): number {
  const ageDays = (Date.now() / 1000 - h.last_used_at) / 86400;
  const recency = ageDays <= 1 ? 1.0 : ageDays <= 3 ? 0.7 : ageDays <= 7 ? 0.5 : ageDays <= 30 ? 0.3 : 0.1;
  return h.launch_count * recency + (h.pinned ? 10000 : 0);
}

function fmtAgo(ts: number): string {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return `${s | 0}s ago`;
  if (s < 3600) return `${(s / 60) | 0}m ago`;
  if (s < 86400) return `${(s / 3600) | 0}h ago`;
  return `${(s / 86400) | 0}d ago`;
}

export function NewProcessDialog({ onClose, onLaunched }: Props) {
  const [projects, setProjects] = useState<ProjectPreset[]>([]);
  const [history, setHistory] = useState<LaunchHistory[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  // Mode 保留内部字段用于历史项还原；UI 已隐藏，默认 Editor
  const [mode, setMode] = useState<LaunchMode>("Editor");
  const [extraArgs, setExtraArgs] = useState("");
  const [workingDir, setWorkingDir] = useState("");
  const [label, setLabel] = useState("");
  const [saveTpl, setSaveTpl] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [launching, setLaunching] = useState(false);

  // History 下拉：fixed 浮层位置（跟随输入框位置计算，不受 body overflow 影响）
  const historyAnchorRef = useRef<HTMLDivElement | null>(null);
  const [histPos, setHistPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const updateHistPos = () => {
    const el = historyAnchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setHistPos({ left: r.left, top: r.bottom + 4, width: r.width });
  };
  useEffect(() => {
    if (!showHistory) return;
    updateHistPos();
    const onScroll = () => updateHistPos();
    window.addEventListener("resize", updateHistPos);
    // 捕获阶段监听所有滚动（包含对话框 body 自身的滚动）
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", updateHistPos);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [showHistory]);

  // Arguments textarea 自动增长（4~12 行）
  const argsRef = useRef<HTMLTextAreaElement | null>(null);
  const autoGrowArgs = () => {
    const el = argsRef.current;
    if (!el) return;
    el.style.height = "0px";
    const lh = 14;                         // 行高 = inline style line-height
    const min = lh * 4 + 12;               // padding 约 12px
    const max = lh * 12 + 12;
    const next = Math.min(max, Math.max(min, el.scrollHeight));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  };
  useEffect(() => { autoGrowArgs(); }, [extraArgs]);

  // 加载项目和历史
  useEffect(() => {
    (async () => {
      const ps = await listProjects();
      setProjects(ps);
      if (ps.length && !projectId) setProjectId(ps[0].id);
      const hs = await listHistory();
      setHistory(hs);
    })();
  }, []); // eslint-disable-line

  // 项目变化 -> 应用 working_dir；Arguments 保持不动
  useEffect(() => {
    const p = projects.find(x => x.id === projectId);
    if (!p) return;
    setWorkingDir(p.working_dir ?? "");
  }, [projectId, projects]);

  // 当前项目（用于展示 uproject 路径等只读信息）
  const currentProject = useMemo(
    () => projects.find(p => p.id === projectId) ?? null,
    [projects, projectId]
  );

  // 历史按权重排序（仅展示当前项目相关，全部历史可切换）
  const sortedHistory = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
    return [...history]
      .filter(h => !projectId || h.project_id === projectId)
      .filter(h => {
        if (!q) return true;
        const hay = [
          h.label ?? "",
          h.mode,
          h.map ?? "",
          String(h.port ?? ""),
          h.extra_args ?? "",
        ].join(" ").toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => score(b) - score(a));
  }, [history, projectId, historyQuery]);

  const applyHistory = (h: LaunchHistory) => {
    setProjectId(h.project_id);
    setMode(h.mode);
    setExtraArgs(h.extra_args);
    setWorkingDir(h.working_dir);
    setLabel(h.label ?? "");
    setShowHistory(false);
  };

  const pickUproject = async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Unreal Project", extensions: ["uproject"] }],
    });
    if (typeof picked !== "string") return;
    // 简单 upsert：用文件名作为 name
    const name = picked.split(/[\\/]/).pop()?.replace(".uproject", "") ?? "Project";
    const id = `proj_${name.toLowerCase()}_${Date.now().toString(36)}`;
    const dir = picked.substring(0, picked.lastIndexOf(picked.includes("\\") ? "\\" : "/"));
    const preset: ProjectPreset = {
      id, name,
      uproject_path: picked,
      working_dir: dir,
      default_args: "",
      default_map: "",
      default_port: 7777,
      log_dir: `${dir}/Saved/Logs`,
      icon_color: "#00E5FF",
      tags: [],
    };
    await upsertProject(preset);
    const ps = await listProjects();
    setProjects(ps);
    setProjectId(id);
  };

  const handleLaunch = async () => {
    if (!projectId) return alert("Please select a project");
    setLaunching(true);
    try {
      // 持久化用户在对话框里改过的 working_dir 到项目预设
      const cur = projects.find(p => p.id === projectId);
      if (cur && cur.working_dir !== workingDir) {
        await upsertProject({
          ...cur,
          working_dir: workingDir || null,
        });
      }
      const r = await launchProcess({
        project_id: projectId,
        mode,
        map: "",
        port: 0,
        extra_args: extraArgs,
        env: {},
        log_file: "",
        working_dir: workingDir,
        label: label || null,
        save_as_template: saveTpl,
      });
      if (r.replaced_pids?.length) {
        console.info(`[launch] replaced ${r.replaced_pids.length} stale DS instance(s):`, r.replaced_pids);
      }
      onLaunched();
    } catch (e) {
      alert(`Launch failed: ${e}`);
    } finally {
      setLaunching(false);
    }
  };

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
        className="glass tech-border rounded-xl shadow-panel w-[560px] max-h-[90%] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <Rocket size={16} className="text-accent-cyan" />
            <span className="text-sm font-semibold">Launch UE Process</span>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded hover:bg-white/5 flex items-center justify-center">
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {/* Project */}
          <Field label="Project">
            <div className="flex gap-2">
              <select
                value={projectId}
                onChange={e => setProjectId(e.target.value)}
                className="flex-1 h-8 px-2 text-xs rounded-md bg-black/30 border border-border-subtle
                           focus:border-accent-cyan/60"
              >
                {projects.length === 0 && <option value="">(no project, click + to add)</option>}
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button
                onClick={pickUproject}
                className="h-8 px-2 rounded-md bg-accent-cyan/10 hover:bg-accent-cyan/20
                           border border-accent-cyan/30 text-accent-cyan flex items-center gap-1 text-xs"
                title="Add .uproject"
              >
                <Plus size={12} /> Add
              </button>
            </div>
          </Field>

          {/* History dropdown */}
          <Field label={`History (${sortedHistory.length}${historyQuery ? ` / ${history.filter(h => !projectId || h.project_id === projectId).length}` : ""})`}>
            <div ref={historyAnchorRef}>
              <div className="flex items-center w-full h-8 rounded-md
                              bg-black/30 border border-border-subtle
                              focus-within:border-accent-cyan/60 transition">
                <HistoryIcon size={12} className="ml-2.5 text-text-dim shrink-0" />
                <input
                  type="text"
                  value={historyQuery}
                  onChange={e => { setHistoryQuery(e.target.value); setShowHistory(true); }}
                  onFocus={() => setShowHistory(true)}
                  placeholder={
                    history.length === 0
                      ? "No history yet"
                      : "Search history… (label / mode / args)"
                  }
                  className="flex-1 px-2 text-xs bg-transparent placeholder:text-text-dim outline-none min-w-0"
                />
                {historyQuery && (
                  <button
                    onClick={() => setHistoryQuery("")}
                    className="w-6 h-6 flex items-center justify-center rounded text-text-dim hover:text-accent-red"
                    title="Clear"
                  >
                    <X size={11} />
                  </button>
                )}
                <button
                  onClick={() => setShowHistory(v => !v)}
                  className="w-7 h-full flex items-center justify-center text-text-secondary hover:text-accent-cyan"
                >
                  <ChevronDown size={12} className={`transition ${showHistory ? "rotate-180" : ""}`} />
                </button>
              </div>
            </div>
          </Field>

          {showHistory && histPos && createPortal(
            <>
              {/* 点击遮罩关闭（透明，不阻挡视觉） */}
              <div
                className="fixed inset-0 z-[60]"
                onClick={() => setShowHistory(false)}
              />
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.12 }}
                style={{
                  position: "fixed",
                  left: histPos.left,
                  top: histPos.top,
                  width: histPos.width,
                }}
                className="z-[61] max-h-72 overflow-y-auto
                           glass tech-border rounded-md shadow-panel"
              >
                {sortedHistory.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-text-dim text-center">
                    {history.length === 0
                      ? "No launches yet — run something to start building history."
                      : `No matches for "${historyQuery}"`}
                  </div>
                ) : sortedHistory.map(h => (
                  <HistoryItem
                    key={h.id}
                    h={h}
                    projectName={projects.find(p => p.id === h.project_id)?.name ?? "?"}
                    onApply={() => { applyHistory(h); setHistoryQuery(""); }}
                    onPin={async () => { await togglePin(h.id); setHistory(await listHistory()); }}
                    onDel={async () => { await removeHistory(h.id); setHistory(await listHistory()); }}
                  />
                ))}
              </motion.div>
            </>,
            document.body
          )}

          {/* Name — 位于 Arguments 之上 */}
          <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
            <Field label="★ Name (shown on main list & history)">
              <Input value={label} onChange={setLabel} placeholder="e.g. DS 100p · Editor debug · 压测" />
            </Field>
            <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer pb-2">
              <input
                type="checkbox"
                checked={saveTpl}
                onChange={e => setSaveTpl(e.target.checked)}
                className="accent-accent-cyan"
              />
              Pin
            </label>
          </div>

          {/* Arguments */}
          <Field label="Arguments">
            <textarea
              ref={argsRef}
              value={extraArgs}
              onChange={e => setExtraArgs(e.target.value)}
              rows={4}
              spellCheck={false}
              wrap="soft"
              className="w-full px-2.5 py-1.5 font-mono rounded-md
                         bg-black/30 border border-border-subtle focus:border-accent-cyan/60
                         resize-none outline-none transition-[height] duration-75"
              style={{
                fontSize: 10,
                lineHeight: "14px",
                fontWeight: 400,
                minHeight: 4 * 14 + 12,
              }}
            />
            <div className="flex gap-1 mt-1.5 flex-wrap">
              {QUICK_ARGS.map(q => (
                <button
                  key={q}
                  onClick={() => {
                    setExtraArgs(a => a ? `${a} ${q}` : q);
                    // 追加 -port= 后把光标聚焦到末尾，便于直接输入端口号
                    requestAnimationFrame(() => {
                      const el = argsRef.current;
                      if (!el) return;
                      el.focus();
                      const pos = el.value.length;
                      el.setSelectionRange(pos, pos);
                    });
                  }}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-accent-cyan/20
                             text-text-dim hover:text-accent-cyan font-mono transition"
                >
                  + {q}
                </button>
              ))}
            </div>
          </Field>

          {/* Working dir */}
          <Field label="Working Directory">
            <PathInput value={workingDir} onChange={setWorkingDir} directory placeholder="Project root" />
          </Field>

          {/* uproject path (read-only) */}
          <Field label=".uproject">
            <div className="flex items-center gap-2 h-8 px-2.5 rounded-md bg-black/20
                            border border-border-subtle text-[11px] font-mono text-text-secondary">
              <FileCode2 size={12} className="text-accent-cyan shrink-0" />
              <span className="truncate" title={currentProject?.uproject_path ?? ""}>
                {currentProject?.uproject_path || "(no project selected)"}
              </span>
            </div>
          </Field>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle">
          <button
            onClick={onClose}
            className="h-8 px-4 text-xs rounded-md hover:bg-white/5 text-text-secondary transition"
          >
            Cancel
          </button>
          <button
            onClick={handleLaunch}
            disabled={launching || !projectId}
            className="h-8 px-4 text-xs rounded-md flex items-center gap-1.5
                       bg-gradient-to-r from-accent-cyan/30 to-accent-purple/30
                       hover:from-accent-cyan/50 hover:to-accent-purple/50
                       border border-accent-cyan/50 text-accent-cyan
                       hover:shadow-glow disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <Rocket size={12} /> {launching ? "Launching..." : "Launch"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/* ───────── helpers ───────── */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1">{label}</div>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder, type = "text" }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full h-8 px-2 text-xs rounded-md
                 bg-black/30 border border-border-subtle focus:border-accent-cyan/60
                 placeholder:text-text-dim transition"
    />
  );
}

function PathInput({ value, onChange, placeholder, directory }: {
  value: string; onChange: (v: string) => void; placeholder?: string; directory?: boolean;
}) {
  const pick = async () => {
    const r = await openDialog({ directory, multiple: false });
    if (typeof r === "string") onChange(r);
  };
  return (
    <div className="flex gap-1">
      <Input value={value} onChange={onChange} placeholder={placeholder} />
      <button
        onClick={pick}
        className="h-8 px-2 rounded-md bg-black/30 border border-border-subtle
                   hover:border-accent-cyan/40 text-text-secondary"
      >
        <FolderOpen size={12} />
      </button>
    </div>
  );
}

function HistoryItem({ h, projectName, onApply, onPin, onDel }: {
  h: LaunchHistory; projectName: string;
  onApply: () => void; onPin: () => void; onDel: () => void;
}) {
  const summary = h.label || `${h.mode}${h.map ? ` · ${h.map}` : ""}${h.port ? ` :${h.port}` : ""}`;
  return (
    <div
      onClick={onApply}
      className="group flex items-center gap-2 px-3 py-2 text-xs cursor-pointer
                 hover:bg-accent-cyan/10 border-b border-border-subtle/50 last:border-0"
    >
      {h.pinned && <Pin size={10} className="text-accent-cyan fill-accent-cyan" />}
      <div className="flex-1 min-w-0">
        <div className="truncate text-text-primary">
          <span className="text-accent-cyan">{projectName}</span>
          <span className="ml-2 text-text-secondary">{summary}</span>
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-[10px] text-text-dim">
          <span className="flex items-center gap-1"><Clock size={9} /> {fmtAgo(h.last_used_at)}</span>
          <span className="flex items-center gap-1"><Hash size={9} /> {h.launch_count}×</span>
        </div>
      </div>
      <div className="opacity-0 group-hover:opacity-100 flex gap-1 transition">
        <button
          onClick={e => { e.stopPropagation(); onPin(); }}
          className="w-6 h-6 rounded hover:bg-accent-cyan/20 flex items-center justify-center text-text-dim hover:text-accent-cyan"
          title={h.pinned ? "Unpin" : "Pin"}
        >
          <Pin size={10} className={h.pinned ? "fill-accent-cyan text-accent-cyan" : ""} />
        </button>
        <button
          onClick={e => { e.stopPropagation(); if (confirm("Delete this history entry?")) onDel(); }}
          className="w-6 h-6 rounded hover:bg-accent-red/20 flex items-center justify-center text-text-dim hover:text-accent-red"
          title="Delete"
        >
          <Trash2 size={10} />
        </button>
      </div>
    </div>
  );
}
