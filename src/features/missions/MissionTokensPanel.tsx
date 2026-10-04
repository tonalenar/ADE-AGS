import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { estimateOf, formatCompactNumber, formatUsd, getTokens, tokenRows, type MissionTokens, type TokenRow } from "./tokens";

/** Cada quanto se relê enquanto a missão roda: os tokens medidos não geram evento próprio. */
const REFRESH_MS = 60_000;

function formatCost(costUsd: number | null): string {
  return costUsd === null ? "—" : `US$ ${costUsd.toFixed(2)}`;
}

function TokenCell({ value }: { value: number | null }) {
  const { t } = useTranslation();
  return (
    <span className="tabular-nums text-gray-600 dark:text-gray-300">
      {value === null ? t("missions.tokens.unmeasured") : formatCompactNumber(value)}
    </span>
  );
}

function TokenTableRow({ row }: { row: TokenRow }) {
  const { t } = useTranslation();
  return (
    <div
      className={`flex items-center gap-2 py-1 text-[11.5px] ${row.isTotal ? "font-semibold text-gray-700 dark:text-gray-200" : ""}`}
    >
      <span className="w-28 shrink-0 truncate text-gray-600 dark:text-gray-300">
        {row.isTotal ? t("missions.tokens.total") : row.agentId}
      </span>
      <span className="flex-1 min-w-0 flex items-center gap-3 justify-end text-right">
        <TokenCell value={row.input} />
        <TokenCell value={row.output} />
        <TokenCell value={row.cacheWrite} />
        <TokenCell value={row.cacheRead} />
        <span className="w-20 shrink-0 tabular-nums text-gray-500 dark:text-gray-400">{formatCost(row.costUsd)}</span>
      </span>
      <span className="w-24 shrink-0 text-right text-[10.5px] text-gray-400 dark:text-white/35">
        {row.cacheReadSharePct !== null ? t("missions.tokens.cacheReadShare", { pct: row.cacheReadSharePct }) : ""}
      </span>
    </div>
  );
}

/**
 * Quantos tokens a missão gastou em terminais, por agente, a partir dos transcripts medidos
 * (hoje só Claude Code). Agentes sem leitor voltam `measured: false` e nunca mostram 0.
 */
export function MissionTokensPanel({ missionId }: { missionId: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<MissionTokens | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => getTokens(missionId).then((d) => alive && setData(d)).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [missionId]);

  if (!data || data.agents.length === 0) {
    return <p className="text-[11.5px] text-gray-400 dark:text-white/35">{t("missions.tokens.empty")}</p>;
  }

  const rows = tokenRows(data);
  const estimate = estimateOf(data);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-widest text-gray-400 dark:text-white/35">
        <span className="w-28 shrink-0">{t("missions.tokens.header.agent")}</span>
        <span className="flex-1 min-w-0 flex items-center gap-3 justify-end text-right">
          <span className="text-gray-400 dark:text-white/35">{t("missions.tokens.header.input")}</span>
          <span className="text-gray-400 dark:text-white/35">{t("missions.tokens.header.output")}</span>
          <span className="text-gray-400 dark:text-white/35">{t("missions.tokens.header.cacheWrite")}</span>
          <span className="text-gray-400 dark:text-white/35">{t("missions.tokens.header.cacheRead")}</span>
          <span className="w-20 shrink-0">{t("missions.tokens.header.cost")}</span>
        </span>
        <span className="w-24 shrink-0" />
      </div>
      <div className="flex flex-col divide-y divide-gray-100 dark:divide-white/5">
        {rows.map((row) => (
          <TokenTableRow key={row.agentId} row={row} />
        ))}
      </div>
      {estimate && (
        <div className="mt-1 flex flex-col gap-0.5 text-[11.5px] text-gray-600 dark:text-gray-300">
          <span>
            {t("missions.tokens.estimate")}: <b className="tabular-nums">{formatUsd(estimate.costUsd)}</b>
          </span>
          <span>
            {t("missions.tokens.saved")}: <b className="tabular-nums text-emerald-600 dark:text-emerald-400">{formatUsd(estimate.savedUsd)}</b>
          </span>
          <span className="text-[10.5px] text-gray-400 dark:text-white/35">{t("missions.tokens.estimateNote")}</span>
          {estimate.unpricedModels.length > 0 && (
            <span className="text-[10.5px] text-amber-600 dark:text-amber-400">
              {t("missions.tokens.unpriced", { models: estimate.unpricedModels.join(", ") })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
