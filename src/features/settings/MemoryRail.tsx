import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { MemoryPanel } from "@/features/memory/MemoryPanel";
import { usePendingMemoryStore } from "@/features/memory/pendingStore";
import type { MemoryPendingCounts } from "@/features/memory/types";

const STORAGE_KEY = "ags.settings.memoryRail";
const REFRESH_MS = 30_000;

/** Sugestões pendentes do workspace e de todas as missões. Pura. */
export function pendingTotal(counts: MemoryPendingCounts): number {
  return counts.workspace + Object.values(counts.byMission).reduce((sum, n) => sum + n, 0);
}

/** O número do balão: vazio sem pendências, "99+" acima de 99. Pura. */
export function badgeText(total: number): string {
  return total <= 0 ? "" : total > 99 ? "99+" : String(total);
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "open";
  } catch {
    return false;
  }
}

function rememberOpen(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, open ? "open" : "closed");
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
}

function LayersIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden>
      <path d="M8 2.2 13.6 5 8 7.8 2.4 5 8 2.2Z" />
      <path d="m2.4 8 5.6 2.8L13.6 8M2.4 11l5.6 2.8L13.6 11" />
    </svg>
  );
}

function ChevronIcon({ flip }: { flip?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 ${flip ? "rotate-180" : ""}`} aria-hidden>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}

/**
 * O painel de memória da tela de Ajustes, recolhido por padrão: sobra a tela inteira para o
 * ajuste que se está fazendo. Fechado vira um botão com um balão com o total de sugestões
 * pendentes; aberto, o painel de sempre com um botão para recolher. A escolha fica guardada.
 */
export function MemoryRail({ workspaceId, workspaceName, onOpenMemory }: {
  workspaceId: string;
  workspaceName: string;
  onOpenMemory?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(readOpen);
  const counts = usePendingMemoryStore((s) => s.counts);
  const total = pendingTotal(counts);

  // O balão precisa dos números mesmo com o painel fechado (aberto, o painel já os carrega).
  useEffect(() => {
    const load = () => { usePendingMemoryStore.getState().load(workspaceId).catch(() => undefined); };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [workspaceId]);

  const toggle = (next: boolean) => {
    setOpen(next);
    rememberOpen(next);
  };

  if (!open) {
    const label = total > 0 ? t("settings.memoryRail.badge", { count: total }) : t("settings.memoryRail.expand");
    return (
      <aside className="hidden shrink-0 p-3 pl-0 @5xl:block">
        <button
          type="button"
          onClick={() => toggle(true)}
          title={t("settings.memoryRail.expand")}
          aria-label={label}
          aria-expanded={false}
          className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-600 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-900 dark:border-white/10 dark:bg-surface-raised dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <LayersIcon />
          {total > 0 && (
            <span
              data-testid="memory-rail-badge"
              className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10.5px] font-semibold leading-none text-white shadow-[0_0_0_2px_var(--color-surface-deep,#0d0d0f)]"
            >
              {badgeText(total)}
            </span>
          )}
        </button>
      </aside>
    );
  }

  return (
    <aside className="hidden w-[392px] shrink-0 flex-col p-3 pl-0 @5xl:flex">
      <div className="mb-1.5 flex justify-end">
        <button
          type="button"
          onClick={() => toggle(false)}
          title={t("settings.memoryRail.collapse")}
          aria-label={t("settings.memoryRail.collapse")}
          aria-expanded
          className="flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] text-gray-500 transition-colors hover:bg-black/5 hover:text-gray-900 dark:text-white/45 dark:hover:bg-white/10 dark:hover:text-white"
        >
          {t("settings.memoryRail.collapse")}
          <ChevronIcon />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <MemoryPanel workspaceId={workspaceId} workspaceName={workspaceName} onOpenMemory={onOpenMemory} />
      </div>
    </aside>
  );
}
