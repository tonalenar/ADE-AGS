import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import type { ConversationCard } from "./chatModel";
import type { FolderDiff } from "./ChatSidebar";
import { threadKey } from "./structured/model";
import { readWorkingDiffStat } from "./workingDiffRead";

/** Quanto esperar depois do último "a conversa cresceu" de uma pasta para reler o `--numstat` dela. */
const DIFF_DEBOUNCE_MS = 3000;

/**
 * O `+/−` não commitado de cada pasta com conversa aberta, lido via `git diff --numstat` quando
 * um agente dela trabalha. Preserva a referência de `diffs[cwd]` quando os totais não mudam.
 */
export function useFolderDiffs(cards: ConversationCard[]): Record<string, FolderDiff> {
  const [diffs, setDiffs] = useState<Record<string, FolderDiff>>({});
  const cwds = useMemo(() => [...new Set(cards.map((c) => c.cwd))].sort().join("\n"), [cards]);
  const tabCwd = useRef(new Map<string, string>());
  tabCwd.current = new Map(cards.map((c) => [c.tabId, c.cwd]));
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    let alive = true;
    const load = (cwd: string) => {
      readWorkingDiffStat(cwd)
        .then((stat) => {
          if (!alive) return;
          const total: FolderDiff = stat && typeof stat.added === "number" && typeof stat.removed === "number"
            ? { added: stat.added, removed: stat.removed }
            : { added: 0, removed: 0 };
          setDiffs((prev) => {
            const current = prev[cwd];
            if (current && current.added === total.added && current.removed === total.removed) return prev;
            return { ...prev, [cwd]: total };
          });
        })
        .catch(() => undefined);
    };
    const list = cwds ? cwds.split("\n") : [];
    list.forEach(load);
    const off = listen<{ tabId: string }>("cc-conversation-grew", (e) => {
      const cwd = tabCwd.current.get(e.payload.tabId);
      if (!cwd) return;
      const prev = timers.current.get(cwd);
      if (prev) window.clearTimeout(prev);
      timers.current.set(cwd, window.setTimeout(() => load(cwd), DIFF_DEBOUNCE_MS));
    });
    // A conversa por protocolo não tem transcript: o diff relê quando o turno dela acaba.
    const offThread = listen<{ threadId: string; type: string; phase?: string }>("cc-chat-thread", (e) => {
      if (e.payload.type !== "phase" || e.payload.phase !== "idle") return;
      const cwd = tabCwd.current.get(threadKey(e.payload.threadId));
      if (cwd) load(cwd);
    });
    const pending = timers.current;
    return () => {
      alive = false;
      off.then((fn) => fn()).catch(() => undefined);
      offThread.then((fn) => fn()).catch(() => undefined);
      pending.forEach((id) => window.clearTimeout(id));
      pending.clear();
    };
  }, [cwds]);

  return diffs;
}
