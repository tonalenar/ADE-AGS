import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatDuration, getTimings, shareOf, type MissionTimings } from "./timings";

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
    return <p className="text-[11.5px] text-gray-400 dark:text-white/35">{t("missions.timings.empty")}</p>;
  }
  const { summary } = data;

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12px] text-gray-600 dark:text-gray-300">
        {t("missions.timings.total", { time: formatDuration(summary.wallMs) })}
      </div>

      <div className="flex flex-col gap-1.5">
        {summary.byKind.map((k) => (
          <div key={k.kind} className="flex items-center gap-2 text-[11.5px]">
            <span className="w-28 shrink-0 text-gray-600 dark:text-gray-300">{t(`missions.timings.kind.${k.kind}`)}</span>
            <div className="flex-1 h-1.5 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
              <div className="h-full rounded-full bg-accent-500" style={{ width: `${shareOf(k.totalMs, summary.wallMs)}%` }} />
            </div>
            <span className="w-32 shrink-0 text-right tabular-nums text-gray-500 dark:text-gray-400">
              {k.count}× · {formatDuration(k.totalMs)}
            </span>
          </div>
        ))}
      </div>

      <div>
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-widest text-gray-400 dark:text-white/35">
          {t("missions.timings.slowest")}
        </div>
        {summary.slowest.map((s) => (
          <div key={s.id} className="flex items-center gap-2 py-0.5 text-[11.5px]">
            <span className="w-28 shrink-0 text-gray-500 dark:text-gray-400">{t(`missions.timings.kind.${s.kind}`)}</span>
            <span className="flex-1 min-w-0 truncate text-gray-700 dark:text-gray-200">
              {s.actor}
              {s.target ? ` → ${s.target}` : ""}
              {s.detail ? ` · ${s.detail}` : ""}
            </span>
            <span className="shrink-0 tabular-nums text-gray-600 dark:text-gray-300">{formatDuration(s.endedMs - s.startedMs)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
