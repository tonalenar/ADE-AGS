import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { parseUnifiedDiff, type FileDiff } from "./diffModel";
import { scmWorkingDiff } from "./ipc";

/** Quanto esperar depois do último aviso de "a conversa cresceu" para reler o diff. */
const DIFF_DEBOUNCE_MS = 1500;

export interface WorkingDiff {
  files: FileDiff[];
  truncated: boolean;
  /** Já houve uma resposta. */
  loaded: boolean;
  /** A pasta é um repositório git. */
  repo: boolean;
}

/**
 * O `git diff` de verdade da pasta da conversa, relido quando o agente trabalha (o Diff e o Resumo
 * mostram o mesmo número porque leem daqui).
 */
export function useWorkingDiff(cwd: string | null, tabId: string | null): { state: WorkingDiff; load: () => void } {
  const [state, setState] = useState<WorkingDiff>({ files: [], truncated: false, loaded: false, repo: true });
  const timer = useRef<number | null>(null);

  const load = useCallback(() => {
    if (!cwd) return;
    scmWorkingDiff(cwd)
      .then((diff) => setState({ files: diff ? parseUnifiedDiff(diff.text) : [], truncated: diff?.truncated ?? false, loaded: true, repo: diff !== null }))
      .catch(() => setState((s) => ({ ...s, loaded: true })));
  }, [cwd]);

  useEffect(() => {
    load();
    if (!tabId) return;
    const off = listen<{ tabId: string }>("cc-conversation-grew", (e) => {
      if (e.payload.tabId !== tabId) return;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(load, DIFF_DEBOUNCE_MS);
    });
    return () => {
      off.then((fn) => fn()).catch(() => undefined);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [load, tabId]);

  return { state, load };
}
