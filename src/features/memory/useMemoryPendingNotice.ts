import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { showBotToast } from "@/shared/brand/botToastStore";

import * as memoryIpc from "./ipc";
import { grownOwners, newAgentProposals, pendingKeyOf, suggesterName } from "./pendingNotice";
import { usePendingMemoryStore } from "./pendingStore";
import type { MemoryPendingCounts } from "./types";

const pendingOwners = (counts: MemoryPendingCounts): (string | null)[] => [
  ...(counts.workspace > 0 ? [null] : []),
  ...Object.entries(counts.byMission).filter(([, count]) => count > 0).map(([missionId]) => missionId),
];

export function useMemoryPendingNotice(workspaceId: string): void {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const seenRef = useRef<Set<string>>(new Set());
  const readyRef = useRef(false);
  const lastCountsRef = useRef<MemoryPendingCounts | null>(null);

  useEffect(() => {
    if (!workspaceId) return;

    const seen = seenRef.current;
    seen.clear();
    readyRef.current = false;
    lastCountsRef.current = null;
    let active = true;

    const loadBaseline = async () => {
      try {
        const counts = await usePendingMemoryStore.getState().load(workspaceId);
        if (!active) return;
        const owners = pendingOwners(counts);
        const pages = await Promise.all(owners.map((owner) => memoryIpc.listMemory(workspaceId, owner)));
        if (!active) return;
        for (const page of pages) {
          for (const entry of page.items) {
            if (entry.pendingRevision !== null) seen.add(pendingKeyOf(entry));
          }
        }
        lastCountsRef.current = counts;
        readyRef.current = true;
      } catch {
        // A próxima mudança de memória poderá tentar novamente carregar as contagens.
      }
    };

    void loadBaseline();

    const listenPromise = listen("cc-memory-changed", async () => {
      const previousCounts = usePendingMemoryStore.getState().counts;
      const hadPreviousCounts = lastCountsRef.current !== null;
      let nextCounts: MemoryPendingCounts;
      try {
        nextCounts = await usePendingMemoryStore.getState().load(workspaceId);
      } catch {
        return;
      }
      if (!active || !readyRef.current || !hadPreviousCounts) return;
      lastCountsRef.current = nextCounts;

      for (const owner of grownOwners(previousCounts, nextCounts)) {
        try {
          const page = await memoryIpc.listMemory(workspaceId, owner);
          for (const entry of newAgentProposals(page.items, seen)) {
            seen.add(pendingKeyOf(entry));
            showBotToast({
              title: t("missions.memoryNotice.title"),
              text: t("missions.memoryNotice.body", { name: suggesterName(entry), key: entry.key }),
              ms: 9000,
              actionLabel: t("missions.memoryNotice.open"),
              onAction: () => navigate("/missions", {
                state: { focusMission: owner, memoryTab: owner ? "mission" : "workspace" },
              }),
            });
          }
          for (const entry of page.items) {
            if (entry.pendingRevision !== null) seen.add(pendingKeyOf(entry));
          }
        } catch {
          // Ignora falhas de leitura; outro evento fará uma nova tentativa.
        }
      }
    });

    listenPromise.catch(() => undefined);
    return () => {
      active = false;
      readyRef.current = false;
      listenPromise.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [navigate, t, workspaceId]);
}
