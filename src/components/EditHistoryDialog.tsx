import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  X, FolderOpen, Pin, Trash2, Save, Rocket, FileCode2,
} from "lucide-react";
import {
  type ProjectPreset, type LaunchHistory, type LaunchMode,
  type HistoryUpdate,
  listProjects, updateHistory, removeHistory,
} from "../lib/ipc";

interface Props {
  /** 要编辑的原始历史条目 */
  history: LaunchHistory;
  onClose: () => void;
  /** 编辑/删除成功后的回调，用于让父组件刷新 */
  onUpdated: () => void;
}

const QUICK_ARGS = ["-server", "-log", "-port="];

/**
 * 编辑已存在的 LaunchHistory 按钮参数。
 * - 复用 NewProcessDialog 的 UI 风格（Project / Arguments / Working dir / Name / Pin）
 * - 调用后端 update_history（不修改 launch_count / last_used_at / created_at / env）
 * - 提供 Delete 按钮（带二次确认）
 */
export function EditHistoryDialog({ history: h, onClose, onUpdated }: Props) {
  const [projects, setProjects] = useState<ProjectPreset[]>([]);
  const [projectId, setProjectId] = useState<string>(h.project_id);
  const [mode, setMode] = useState<LaunchMode>(h.mode);
  const [extraArgs, setExtraArgs] = useState(h.extra_args);
  const [workingDir, setWorkingDir] = useState(h.working_dir);
  const [label, setLabel] = useState(h.label ?? "");
  const [pinned, setPinned] = useState(h.pinned);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const MODE_OPTIONS: LaunchMode[] = ["Editor", "PIE", "Game", "DedicatedServer", "Client"];

  // Arguments 自动增长
  const argsRef = useRef<HTMLTextAreaElement | null>(null);
  const autoGrowArgs = () => {
    const el = argsRef.current;
    if (!el) return;
    el.style.height = "0px";
    const lh = 14;
    const min = lh * 4 + 12;
    const max = lh * 12 + 12;
    const next = Math.min(max, Math.max(min, el.scrollHeight));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  };
  useEffect(() => { autoGrowArgs(); }, [extraArgs]);

  useEffect(() => {
    (async () => {
      const ps = await listProjects();
      setProjects(ps);
    })();
  }, []);

  // 切换 project 时同步 working_dir（用户仍可继续编辑）
  useEffect(() => {
    const p = projects.find(x => x.id === projectId);
    if (!p) return;
    // 仅当当前 working_dir 仍为该项目的预设值或为空时同步，避免覆盖用户已改过的值
    if (!workingDir || projects.some(x => x.id === projectId && x.working_dir === workingDir)) {
      setWorkingDir(p.working_dir ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projects]);

  const currentProject = useMemo(
    () => projects.find(p => p.id === projectId) ?? null,
    [projects, projectId]
  );

  const pickUproject = async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Unreal Project", extensions: ["uproject"] }],
    });
    if (typeof picked !== "string") return;
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
    const { upsertProject } = await import("../lib/ipc");
    await upsertProject(preset);
    const ps = await listProjects();
    setProjects(ps);
    setProjectId(id);
  };

  const pickWorkingDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setWorkingDir(picked);
  };

  const handleSave = async () => {
    if (!projectId) { alert("Please select a project"); return; }
    if (!label.trim()) { alert("Name cannot be empty"); return; }
    setSaving(true);
    try {
      const patch: HistoryUpdate = {
        id: h.id,
        project_id: projectId,
        mode,
        map: h.map,
        port: h.port,
        extra_args: extraArgs,
        log_file: h.log_file,
        working_dir: workingDir,
        label: label.trim(),
        pinned,
      };
      await updateHistory(patch);
      onUpdated();
      onClose();
    } catch (e) {
      alert(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete this quick-launch button?\n\n"${h.label ?? "(no name)"}"\n\nThis cannot be undone.`)) return;
    setDeleting(true);
    try {
      await removeHistory(h.id);
      onUpdated();
      onClose();
    } catch (e) {
      alert(`Delete failed: ${e}`);
    } finally {
      setDeleting(false);
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
            <span className="text-sm font-semibold">Edit Quick Launch</span>
            <span className="text-[10px] text-text-dim font-mono ml-2">
              {h.launch_count}× launched · last {h.last_used_at ? new Date(h.last_used_at * 1000).toLocaleString() : "—"}
            </span>
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
                {projects.length === 0 && <option value="">(no project)</option>}
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button
                onClick={pickUproject}
                className="h-8 px-2 rounded-md bg-accent-cyan/10 hover:bg-accent-cyan/20
                           border border-accent-cyan/30 text-accent-cyan text-xs"
                title="Add .uproject"
              >
                + Add
              </button>
            </div>
          </Field>

          {/* Mode */}
          <Field label="Mode">
            <select
              value={mode}
              onChange={e => setMode(e.target.value as LaunchMode)}
              className="w-full h-8 px-2 text-xs rounded-md bg-black/30 border border-border-subtle
                         focus:border-accent-cyan/60"
            >
              {MODE_OPTIONS.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>

          {/* Name + Pin */}
          <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
            <Field label="★ Name (shown on main list & history)">
              <Input value={label} onChange={setLabel} placeholder="e.g. DS 100p · Editor debug" />
            </Field>
            <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer pb-2">
              <input
                type="checkbox"
                checked={pinned}
                onChange={e => setPinned(e.target.checked)}
                className="accent-accent-cyan"
              />
              <Pin size={11} className={pinned ? "text-accent-cyan fill-accent-cyan" : "text-text-dim"} />
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
            <div className="flex gap-1">
              <Input value={workingDir} onChange={setWorkingDir} placeholder="Project root" />
              <button
                onClick={pickWorkingDir}
                className="h-8 px-2 rounded-md bg-black/30 border border-border-subtle
                           hover:border-accent-cyan/40 text-text-secondary"
                title="Pick directory"
              >
                <FolderOpen size={12} />
              </button>
            </div>
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

          {/* Meta (read-only) */}
          <div className="grid grid-cols-2 gap-2 pt-1 text-[10px] text-text-dim font-mono">
            <div className="px-2 py-1 rounded bg-black/20 border border-border-subtle/50">
              <div className="uppercase tracking-wider mb-0.5">Port</div>
              <div className="text-text-secondary">{h.port || "—"}</div>
            </div>
            <div className="px-2 py-1 rounded bg-black/20 border border-border-subtle/50">
              <div className="uppercase tracking-wider mb-0.5">Launched</div>
              <div className="text-text-secondary">{h.launch_count}×</div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border-subtle">
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="h-8 px-3 text-xs rounded-md flex items-center gap-1.5
                       bg-accent-red/10 hover:bg-accent-red/25
                       border border-accent-red/40 text-accent-red
                       disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <Trash2 size={12} /> {deleting ? "Deleting..." : "Delete"}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="h-8 px-4 text-xs rounded-md hover:bg-white/5 text-text-secondary transition"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !projectId}
              className="h-8 px-4 text-xs rounded-md flex items-center gap-1.5
                         bg-gradient-to-r from-accent-cyan/30 to-accent-purple/30
                         hover:from-accent-cyan/50 hover:to-accent-purple/50
                         border border-accent-cyan/50 text-accent-cyan
                         hover:shadow-glow disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <Save size={12} /> {saving ? "Saving..." : "Save"}
            </button>
          </div>
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
