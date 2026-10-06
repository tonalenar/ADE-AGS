import { useTranslation } from "react-i18next";

import { formatCompactNumber, formatUsd, tabCostUsd, tabTotalTokens, type TabTokens } from "./tokens";

/** Gasto de cada aba/terminal de um agente. Sem medição = cinza "não medido", nunca 0. */
export function TabCostList({ agentId, tabs, className = "" }: { agentId: string; tabs: TabTokens[]; className?: string }) {
  const { t } = useTranslation();
  if (tabs.length === 0) return null;
  return (
    <ul className={`flex flex-col gap-0.5 ${className}`} data-testid={`tab-costs-${agentId}`}>
      {tabs.map((tab) => {
        const tokens = tabTotalTokens(tab);
        const cost = tabCostUsd(tab);
        return (
          <li key={tab.tabId} className="flex items-center gap-2 text-[11px]" data-measured={tab.measured}>
            <span className="min-w-0 flex-1 truncate text-gray-500 dark:text-gray-400" title={tab.label}>
              {tab.label} {(tab.kind || tab.source) && <span className="text-[10px] text-gray-400 dark:text-white/35">· {[tab.kind && t(`missions.tokens.tabKind.${tab.kind}`), tab.source && t(`missions.tokens.tabSource.${tab.source}`)].filter(Boolean).join(" · ")}</span>}
            </span>
            {tab.measured ? (
              <>
                <span className="tabular-nums text-gray-600 dark:text-gray-300">{tokens === null ? "—" : formatCompactNumber(tokens)}</span>
                <span className="w-20 shrink-0 text-right tabular-nums text-gray-500 dark:text-gray-400">{formatUsd(cost)}</span>
              </>
            ) : (
              <span className="text-gray-400 dark:text-white/35">{t("missions.tokens.unmeasured")}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
