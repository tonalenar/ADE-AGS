import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { useTabsStore } from "@/features/tabs/store";
import { activeTabIds } from "@/features/terminal/activity";

import { becameIdle, changeSummary, entryState, type EntryState } from "./model";
import { discardAll, finishComparison, keepEntry } from "./start";
import { loadComparisons, openDiff, refreshStatus, useCompareStore } from "./store";

const DOT: Record<EntryState, string> = {
  starting: "bg-amber-400",
  working: "bg-accent-500 animate-pulse",
  idle: "bg-green-500",
  closed: "bg-gray-400",
};

const material = "border border-black/[0.08] dark:border-white/[0.08] bg-white/90 dark:bg-surface-raised/85 backdrop-blur-md shadow-lg";
const small = "cc-t h-6 px-1.5 rounded-md text-[11px] font-medium disabled:opacity-40";

/** As atividades mudam a cada saída do terminal; a barra olha uma vez por segundo. */
function useActiveTabs(): ReadonlySet<string> {
  const [active, setActive] = useState<ReadonlySet<string>>(() => new Set(activeTabIds()));
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = activeTabIds();
      setActive((cur) => (cur.size === next.length && next.every((id) => cur.has(id)) ? cur : new Set(next)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return active;
}

/**
 * O cabeçalho do grupo de uma comparação, por cima do canvas dela: o estado de cada terminal
 * (iniciando, trabalhando, parado), o que cada um mudou quando para, e as ações "Ver diff",
 * "Manter este", "Descartar todos" e, depois de manter um, "Encerrar".
 */
export function ComparisonBar({ comparisonId }: { comparisonId: string }) {
  const { t } = useTranslation();
  const cmp = useCompareStore((s) => s.comparisons.find((c) => c.id === comparisonId));
  const loaded = useCompareStore((s) => s.loaded);
  const statuses = useCompareStore((s) => s.statuses[comparisonId]);
  const pending = useCompareStore((s) => s.pending);
  const tabs = useTabsStore((s) => s.tabs);
  const activateTab = useTabsStore((s) => s.activateTab);
  const active = useActiveTabs();
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!loaded) void loadComparisons(); }, [loaded]);
  useEffect(() => { void refreshStatus(comparisonId); }, [comparisonId]);

  const states = useMemo(() => {
    const out: Record<string, EntryState> = {};
    for (const e of cmp?.entries ?? []) {
      const tabOpen = !!e.tabId && tabs.some((tab) => tab.id === e.tabId);
      out[e.pick] = entryState({ tabOpen, pending: !!e.tabId && !!pending[e.tabId], active: !!e.tabId && active.has(e.tabId) });
    }
    return out;
  }, [cmp, tabs, pending, active]);

  // Quando alguém para, mede de novo o que mudou (git diff contra a base).
  const prev = useRef(states);
  useEffect(() => {
    if (becameIdle(prev.current, states)) void refreshStatus(comparisonId);
    prev.current = states;
  }, [states, comparisonId]);

  if (!cmp) return null;
  const run = (fn: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };
  const others = cmp.entries.filter((e) => e.pick !== cmp.kept);

  return (
    <section aria-label={t("compare.groupTitle", { title: cmp.title })}
      className={`pointer-events-auto absolute left-3 top-3 w-[min(440px,calc(100%-24px))] rounded-xl ${material} text-[12px] text-gray-700 dark:text-gray-200`}>
      <header className="flex items-center gap-2 px-3 py-2 border-b border-black/[0.06] dark:border-white/[0.06]">
        <span className="font-semibold truncate flex-1" title={cmp.title}>{t("compare.groupTitle", { title: cmp.title })}</span>
        {!cmp.isolated && <span className="text-[10.5px] text-amber-700 dark:text-amber-300">{t("compare.sharedBadge")}</span>}
        <Button variant="custom" className={`${small} text-gray-500`} onClick={() => void refreshStatus(comparisonId)} title={t("compare.bar.refresh")}>
          {t("compare.bar.refresh")}
        </Button>
        <Button variant="custom" className={`${small} text-gray-500`} onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
          {collapsed ? t("compare.bar.expand") : t("compare.bar.collapse")}
        </Button>
      </header>
      {!collapsed && (
        <>
          <ul className="flex flex-col py-1">
            {cmp.entries.map((entry) => {
              const state = states[entry.pick] ?? "closed";
              const summary = cmp.isolated && state !== "working" && state !== "starting" ? changeSummary(statuses?.[entry.pick], t) : null;
              return (
                <li key={entry.pick} className="flex items-center gap-2 px-3 py-1">
                  <span aria-hidden className={`w-2 h-2 rounded-full shrink-0 ${DOT[state]}`} />
                  <button type="button" className="min-w-0 flex-1 text-left truncate hover:underline disabled:no-underline" disabled={state === "closed"}
                    onClick={() => entry.tabId && activateTab(entry.tabId)} title={entry.branch ?? entry.cwd}>
                    <span className="font-medium">{entry.label}</span>
                    <span className="text-gray-400"> · {t(`compare.state.${state}`)}</span>
                    {summary && <span className="text-gray-500 dark:text-gray-400"> · {summary}</span>}
                  </button>
                  {cmp.kept === entry.pick && <span className="text-[10.5px] font-semibold text-green-700 dark:text-green-300">{t("compare.bar.kept")}</span>}
                  {cmp.isolated && (
                    <Button variant="custom" className={`${small} text-accent-600 dark:text-accent-300 hover:bg-accent-500/10`} onClick={() => openDiff(cmp.id, entry.pick)}>
                      {t("compare.bar.diff")}
                    </Button>
                  )}
                  {cmp.isolated && !cmp.kept && (
                    <Button variant="custom" disabled={busy} className={`${small} text-green-700 dark:text-green-300 hover:bg-green-500/10`} onClick={run(() => keepEntry(cmp, entry.pick))}>
                      {t("compare.bar.keep")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          <footer className="flex items-center justify-end gap-1.5 px-3 py-2 border-t border-black/[0.06] dark:border-white/[0.06]">
            {cmp.kept && others.length === 0 && (
              <Button variant="custom" disabled={busy} className={`${small} bg-accent-500/15 text-accent-600 dark:text-accent-300`} onClick={run(() => finishComparison(cmp))}>
                {t("compare.bar.finish")}
              </Button>
            )}
            {others.length > 0 && (
              <Button variant="custom" disabled={busy} className={`${small} text-red-600 dark:text-red-400 hover:bg-red-500/10`} onClick={run(() => discardAll(cmp))}>
                {cmp.isolated ? t("compare.bar.discardAll") : t("compare.bar.close")}
              </Button>
            )}
          </footer>
        </>
      )}
    </section>
  );
}
