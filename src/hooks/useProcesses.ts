import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { listProcesses, type UeProcess } from "../lib/ipc";

export function useProcesses() {
  const [processes, setProcesses] = useState<UeProcess[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listProcesses();
      setProcesses(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // 后端定时推送
    const un = listen<UeProcess[]>("processes-updated", (e) => {
      setProcesses(e.payload);
    });
    return () => { un.then(f => f()); };
  }, [refresh]);

  return { processes, refresh, loading };
}
