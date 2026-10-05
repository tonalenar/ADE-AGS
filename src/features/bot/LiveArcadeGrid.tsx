import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { missionReview } from "@/features/missions/ipc";
import { useMissionsStore } from "@/features/missions/store";
import { getTimings, type MissionTimings } from "@/features/missions/timings";
import { getTokens, type MissionTokens } from "@/features/missions/tokens";
import type { MissionReview, MissionSummary } from "@/features/missions/types";

import { LiveArcade } from "./LiveArcade";

const NO_TASKS: never[] = [];

/** Um fliperama que busca os próprios dados: usado na grade, onde cada missão é independente. */
function MissionArcade({ mission }: { mission: MissionSummary }) {
  const detail = useMissionsStore((s) => s.details[mission.id]);
  const loadDetail = useMissionsStore((s) => s.loadDetail);
  const [timings, setTimings] = useState<MissionTimings | null>(null);
  const [tokens, setTokens] = useState<MissionTokens | null>(null);
  const [review, setReview] = useState<MissionReview | null>(null);
  useEffect(() => {
    let alive = true;
    if (!detail) loadDetail(mission.id).catch(() => undefined);
    getTimings(mission.id).then((x) => alive && setTimings(x)).catch(() => undefined);
    getTokens(mission.id).then((x) => alive && setTokens(x)).catch(() => undefined);
    missionReview(mission.id).then((x) => alive && setReview(x)).catch(() => undefined);
    return () => { alive = false; };
  }, [mission.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return <LiveArcade mission={mission} tasks={detail?.tasks ?? NO_TASKS} timings={timings} review={review} tokens={tokens} />;
}

/** Seletor TODAS | missão: só aparece com mais de uma missão em execução. */
export function LiveSelector({ running, value, onChange }: { running: MissionSummary[]; value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="ags-live__selector" role="tablist" aria-label={t("botPanel.live.selector")}>
      {[{ id: "all", title: t("botPanel.live.all") }, ...running.map((m) => ({ id: m.id, title: m.title }))].map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          className={value === item.id ? "on" : ""}
          onClick={() => onChange(item.id)}
        >
          {item.title.length > 24 ? item.title.slice(0, 21) + "..." : item.title}
        </button>
      ))}
    </div>
  );
}

/** Visão unificada: um fliperama por missão em execução, lado a lado. Clicar abre a individual. */
export function LiveArcadeGrid({ running, onOpen }: { running: MissionSummary[]; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="ags-live__grid">
      {running.map((mission) => (
        <div
          key={mission.id}
          className="ags-live__cell"
          role="button"
          tabIndex={0}
          aria-label={t("botPanel.live.openOne", { title: mission.title })}
          onClick={() => onOpen(mission.id)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(mission.id); } }}
        >
          <MissionArcade mission={mission} />
        </div>
      ))}
    </div>
  );
}
