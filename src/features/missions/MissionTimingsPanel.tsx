import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { maxFixRound } from "@/features/runs/fixRounds";

import { activeSourceKey, formatActive, formatDuration, getMissionEfficiency, getTimings, shareOf, testStatsView, type MissionEfficiency, type MissionTimings } from "./timings";

/** Cada quanto se relê o cronómetro mientras se mira: los spans se graban sin evento. */
const REFRESH_MS = 15_000;

/**
 * Dónde se fue el tiempo de la misión: el total medido, lo que ocupó cada tipo de etapa y las
 * más lentas. Es lo que separa "demoró mucho" de saber qué demoró.
 */
export function MissionTimingsPanel({ missionId }: { missionId: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<MissionTimings | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => getTimings(missionId).then((d) => alive && setData(d)).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [missionId]);

  if (!data || data.spans.length === 0) {
    return <div className="flex flex-col gap-3"><MissionEfficiencyCard missionId={missionId} /><p className="text-[11.5px] text-gray-400 dark:text-white/35">{t("missions.timings.empty")}</p></div>;
  }
  const { summary } = data;
  const corrections = maxFixRound(data.spans);

  return (
    <div className="flex flex-col gap-3">
      <MissionEfficiencyCard missionId={missionId} />
      <div className="text-[12px] text-gray-600 dark:text-gray-300">
        {t("missions.timings.total", { time: formatDuration(summary.wallMs) })}
      </div>
      {corrections != null && (
        <div className="text-[12px] text-amber-700 dark:text-amber-300">
          {t("missions.timings.fixRounds", { n: corrections })}
        </div>
      )}
      <div className="text-[10.5px] text-gray-400 dark:text-white/35">{t("missions.timings.turnDetail")}</div>

      <div className="flex flex-col gap-1.5">
        {summary.byKind.map((k) => (
          <div key={k.kind} className="flex items-center gap-2 text-[11.5px]">
            <span className="w-44 shrink-0 truncate text-gray-600 dark:text-gray-300" title={kindLabel(t, k.kind)}>{kindLabel(t, k.kind)}</span>
            <div className="flex-1 h-1.5 rounded-full bg-gray-200 dark:bg-surface-overlay overflow-hidden">
              <div className="h-full rounded-full bg-accent-500" style={{ width: `${shareOf(k.totalMs, summary.wallMs)}%` }} />
            </div>
            <span className="w-32 shrink-0 text-right font-mono tabular-nums text-gray-500 dark:text-gray-400">
              {k.count}× · {formatDuration(k.totalMs)}
            </span>
          </div>
        ))}
      </div>

      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-gray-500 dark:text-white/45">
          {t("missions.timings.slowest")}
        </div>
        {summary.slowest.map((s) => (
          <div key={s.id} className="flex items-center gap-2 py-0.5 text-[11.5px]">
            <span className="w-44 shrink-0 truncate text-gray-500 dark:text-gray-400" title={kindLabel(t, s.kind)}>{kindLabel(t, s.kind)}</span>
            <span className="flex-1 min-w-0 truncate text-gray-700 dark:text-gray-200">
              {s.actor}
              {s.target ? ` → ${s.target}` : ""}
              {s.detail ? ` · ${s.detail}` : ""}
            </span>
            <span className="shrink-0 font-mono tabular-nums text-gray-600 dark:text-gray-300">{formatDuration(s.endedMs - s.startedMs)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Métricas desta missão e o histórico recente do workspace, disponível também no QG. */
export function MissionEfficiencyCard({ missionId, compact = false }: { missionId: string; compact?: boolean }) {
  const { t } = useTranslation();
  const [data, setData] = useState<MissionEfficiency | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => getMissionEfficiency(missionId).then((value) => alive && setData(value)).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [missionId]);

  if (!data) return null;

  const value = (ms: number | null) => ms === null ? t("missions.efficiency.unmeasured") : formatDuration(ms);
  const activeText = formatActive(data.activeMs) ?? t("missions.efficiency.unmeasured");
  const sourceKey = activeSourceKey(data.activeSource);
  const testView = testStatsView(data.testMetrics, data.wallMs);
  const cost = (usd: number | null) => usd === null ? t("missions.efficiency.unmeasured") : `$${usd.toFixed(3)}`;
  const gain = (percent: number | null) => percent === null
    ? t("missions.efficiency.unmeasured")
    : `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
  const shell = compact
    ? "ags-hq__detail"
    : "rounded-xl bg-gray-50 dark:bg-surface p-4 ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.07]";
  const label = compact ? "ags-hq__dim" : "text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-white/40";
  const metric = compact ? "text-gray-100" : "text-gray-800 dark:text-gray-100";

  return (
    <section className={shell} aria-label={t("missions.efficiency.title")}>
      <h3 className={compact ? "mb-2 text-[11px] font-semibold text-gray-100" : "mb-2 text-[11px] font-semibold text-gray-700 dark:text-gray-200"}>
        {t("missions.efficiency.title")}
      </h3>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        <Metric label={t("missions.efficiency.active")} value={activeText} labelClass={label} valueClass={metric} />
        <Metric label={t("missions.efficiency.wall")} value={value(data.wallMs)} labelClass={label} valueClass={metric} />
        <Metric label={t("missions.efficiency.cost")} value={cost(data.costEstimate)} labelClass={label} valueClass={metric} />
        <Metric label={t("missions.efficiency.agents")} value={String(data.agents)} labelClass={label} valueClass={metric} />
        <Metric label={t("missions.timings.firstDelegation")} value={value(data.firstDelegationMs ?? null)} labelClass={label} valueClass={data.firstDelegationMs == null ? (compact ? "text-gray-500" : "text-gray-400") : metric} />
      </div>

      {testView ? (
        <p className={compact ? "mt-2 text-[10px] text-gray-300" : "mt-2 text-[10.5px] text-gray-600 dark:text-gray-300"}>
          {t("missions.efficiency.tests", { time: testView.time, share: testView.share ?? 0, runs: testView.runs })}
          {" · "}
          {t("missions.efficiency.testsSkipped", { cache: testView.skipped, affected: testView.affected })}
        </p>
      ) : null}

      {data.firstDelegationSource ? <p className={compact ? "mt-2 text-[10px] text-gray-400" : "mt-2 text-[10.5px] text-gray-500 dark:text-gray-400"}>{t(`missions.timings.delegationSource.${data.firstDelegationSource}`)}</p> : null}

      <p className={compact ? "mt-2 text-[10px] text-gray-400" : "mt-2 text-[10.5px] text-gray-500 dark:text-gray-400"}>
        {sourceKey ? t(sourceKey) : null}
        {data.turnMs !== null ? `${sourceKey ? " · " : ""}${t("missions.efficiency.turnDetail", { time: value(data.turnMs) })}` : null}
      </p>

      {data.historySize === 0 || data.byAgentBand.length === 0 ? (
        <p className={compact ? "mt-2 text-[10px] text-gray-400" : "mt-2 text-[10.5px] text-gray-500 dark:text-gray-400"}>
          {t("missions.efficiency.historyEmpty")}
        </p>
      ) : (
        <>
          <p className={compact ? "mt-2 text-[10px] text-gray-400" : "mt-2 text-[10.5px] text-gray-500 dark:text-gray-400"}>
            {t("missions.efficiency.historySample", { sample: data.historySize, limit: data.historyLimit })}
          </p>
          <div className={compact ? "mt-2 text-[10px] text-gray-200" : "mt-2 text-[10.5px] text-gray-600 dark:text-gray-300"}>
            {t("missions.efficiency.currentGain", { time: gain(data.timeGainPercent), cost: gain(data.costGainPercent) })}
          </div>
          <div className="mt-2 flex flex-col gap-1">
            <div className="grid grid-cols-[2.5rem_2rem_1fr_1fr_1fr] gap-1 text-[8px] font-semibold uppercase tracking-wide text-gray-400 dark:text-white/35">
              <span>{t("missions.efficiency.band")}</span>
              <span>{t("missions.efficiency.sample")}</span>
              <span>{t("missions.efficiency.medianWall")}</span>
              <span>{t("missions.efficiency.timeGain")}</span>
              <span>{t("missions.efficiency.costGain")}</span>
            </div>
            {data.byAgentBand.map((band) => (
              <div key={band.band} className="grid grid-cols-[2.5rem_2rem_1fr_1fr_1fr] items-center gap-1 text-[9.5px] tabular-nums">
                <span className={compact ? "text-gray-300" : "text-gray-600 dark:text-gray-300"}>{band.band}</span>
                <span className={compact ? "text-gray-500" : "text-gray-400 dark:text-gray-500"}>{band.sampleSize}</span>
                <span className={compact ? "text-gray-300" : "text-gray-600 dark:text-gray-300"}>{value(band.medianWallMs)}</span>
                <span className={compact ? "text-gray-300" : "text-gray-600 dark:text-gray-300"}>{gain(band.timeGainPercent)}</span>
                <span className={compact ? "text-gray-300" : "text-gray-600 dark:text-gray-300"}>{gain(band.costGainPercent)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, labelClass, valueClass }: { label: string; value: string; labelClass: string; valueClass: string }) {
  return <div className="min-w-0"><div className={labelClass}>{label}</div><div className={`truncate text-[11px] font-semibold tabular-nums ${valueClass}`}>{value}</div></div>;
}

/** O nome de um tipo de medição. Um tipo novo sem tradução aparece legível ("Start all working"), nunca como a chave crua. */
function kindLabel(t: (key: string, opts?: Record<string, unknown>) => string, kind: string): string {
  const human = kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return t(`missions.timings.kind.${kind}`, { defaultValue: human });
}
