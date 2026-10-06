import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatTokens } from "@/features/accounts/usage";
import { missionReview } from "@/features/missions/ipc";
import { useMissionsStore } from "@/features/missions/store";
import { MissionEfficiencyCard } from "@/features/missions/MissionTimingsPanel";
import { MissionStallAlerts, MissionStartupTime } from "@/features/missions/StallAlertsView";
import { formatDuration, getTimings, type MissionTimings } from "@/features/missions/timings";
import { TabCostList } from "@/features/missions/TabCostList";
import { estimateOf, formatCompactNumber, formatUsd, getTokens, tabsOfAgent, type CostEstimate, type MissionTokens } from "@/features/missions/tokens";
import type { MissionReview } from "@/features/missions/types";
import { useAgentActivity } from "@/features/terminal/activity";
import { Pet, powerTier, usePetStatus } from "@/shared/brand/Pet";

import { type FailureKey, failureActionKey, failureKey, failureLabelKey } from "@/features/missions/failureClass";
import { type RateWindow, botStats, clock, missionSeconds, rankKey, recentMissions, scoreDigits, trophies } from "./botStats";
import { useBotPanelStore } from "./botPanelStore";
import { LiveArcade } from "./LiveArcade";
import { LiveArcadeGrid, LiveSelector } from "./LiveArcadeGrid";
import "./bot-panel.css";

type View = "status" | "missions" | "tokens" | "trophies" | "live";
const VIEWS: View[] = ["status", "missions", "tokens", "trophies", "live"];
const EMPTY_ARCADE_TASKS: never[] = [];

const STATUS_GLYPH: Record<string, string> = { running: "▶", done: "✔", failed: "✖", cancelled: "■", draft: "○" };
const STATUS_COLOR: Record<string, string> = {
  running: "var(--hq-green)", done: "var(--hq-cyan)", failed: "var(--hq-pink)", cancelled: "var(--hq-dim)", draft: "var(--hq-dim)",
};

/** Una barra de bloques, como la vida de un personaje: `value` de 0 a 1. */
function Meter({ value, color, busy = false, blocks = 16 }: { value: number; color?: string; busy?: boolean; blocks?: number }) {
  const lit = Math.round(Math.max(0, Math.min(1, value)) * blocks);
  return (
    <div className={`ags-hq__meter ${busy ? "ags-hq__meter--busy" : ""}`} style={{ ["--meter" as string]: color }} aria-hidden>
      {Array.from({ length: blocks }, (_, i) => <i key={i} className={i < lit ? "on" : ""} />)}
    </div>
  );
}

const rate = (r: number | null) => (r === null ? "--" : `${r}%`);

function Card({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="ags-hq__card">
      <div className="ags-hq__card-label">{label}</div>
      <div className="ags-hq__card-value" style={{ ["--c" as string]: color }}>{value}</div>
      {sub ? <div className="ags-hq__card-sub">{sub}</div> : null}
    </div>
  );
}

/**
 * El QG del bot: lo que el bot "hizo" por vos, en una pantalla de fliperama. Se abre con un
 * clic en el bot. Teclado: ← → cambian de pestaña, ↑ ↓ eligen misión, Esc cierra.
 */
export function BotPanel() {
  const { t } = useTranslation();
  const open = useBotPanelStore((s) => s.open);
  const setOpen = useBotPanelStore((s) => s.setOpen);
  const pet = usePetStatus();
  const busy = useAgentActivity((a) => a.count);
  const missions = useMissionsStore((s) => s.missions);
  const missionDetails = useMissionsStore((s) => s.details);
  const loadMissionDetail = useMissionsStore((s) => s.loadDetail);
  const [view, setView] = useState<View>("status");
  const [selected, setSelected] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [timings, setTimings] = useState<MissionTimings | null>(null);
  const [tokens, setTokens] = useState<MissionTokens | null>(null);
  const [liveFilter, setLiveFilter] = useState("all");
  const [liveReview, setLiveReview] = useState<MissionReview | null>(null);
  // Costo estimado y ahorro de cada misión de la lista (se leen de a una, en segundo plano).
  const [estimates, setEstimates] = useState<Record<string, CostEstimate | null>>({});

  const recent = useMemo(() => recentMissions(missions), [missions]);
  const stats = useMemo(() => botStats(missions, now), [missions, now]);
  const windowSub = (w: RateWindow) => t("botPanel.card.windowSub", { done: w.done, failed: w.failed, cancelled: w.cancelled });
  const tier = powerTier(busy);
  const runningMissions = useMemo(() => missions.filter((m) => m.status === "running"), [missions]);
  const unified = view === "live" && runningMissions.length > 1 && liveFilter === "all";
  const liveOne = view === "live" && liveFilter !== "all" ? recent.find((m) => m.id === liveFilter) : undefined;
  const current = liveOne ?? recent[Math.min(selected, recent.length - 1)];
  const currentDetail = current ? missionDetails[current.id] : undefined;
  const currentId = current?.id;
  const hasCurrentDetail = Boolean(currentDetail);

  useEffect(() => {
    if (!open || view !== "live" || !currentId || hasCurrentDetail) return;
    loadMissionDetail(currentId).catch(() => undefined);
  }, [open, view, currentId, hasCurrentDetail, loadMissionDetail]);

  useEffect(() => {
    if (!open || view !== "live" || !currentId) return;
    let alive = true;
    setLiveReview(null);
    missionReview(currentId).then((data) => alive && setLiveReview(data)).catch(() => undefined);
    return () => { alive = false; };
  }, [open, view, currentId]);

  // El reloj corre mientras el panel está abierto: las misiones en curso suman tiempo en vivo.
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  // Los detalles de la misión elegida: tiempos y tokens medidos.
  useEffect(() => {
    if (!open || !current) return;
    let alive = true;
    setTimings(null);
    setTokens(null);
    getTimings(current.id).then((x) => alive && setTimings(x)).catch(() => undefined);
    getTokens(current.id).then((x) => alive && setTokens(x)).catch(() => undefined);
    return () => { alive = false; };
  }, [open, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      for (const m of recent) {
        if (!alive) return;
        if (m.status === "draft" || !m.startedAt) continue;
        try {
          const est = estimateOf(await getTokens(m.id));
          if (alive) setEstimates((prev) => ({ ...prev, [m.id]: est }));
        } catch {
          /* medir nunca rompe el panel */
        }
      }
    })();
    return () => { alive = false; };
  }, [open, recent.map((m) => m.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); return; }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const step = e.key === "ArrowRight" ? 1 : -1;
        setView((v) => VIEWS[(VIEWS.indexOf(v) + step + VIEWS.length) % VIEWS.length]);
        e.preventDefault();
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && recent.length > 0) {
        const step = e.key === "ArrowDown" ? 1 : -1;
        setSelected((i) => (i + step + recent.length) % recent.length);
        e.preventDefault();
      } else if (["1", "2", "3", "4", "5"].includes(e.key)) {
        setView(VIEWS[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, recent.length, setOpen]);

  if (!open) return null;

  const trophyList = trophies(stats, pet.xp, pet.level, busy);
  const unlocked = trophyList.filter((x) => x.unlocked).length;
  const measured = tokens?.agents.filter((a) => a.measured) ?? [];
  const sum = (key: "input" | "output" | "cacheRead" | "cacheWrite") => measured.reduce((acc, a) => acc + (a[key] ?? 0), 0);
  const wall = timings?.summary.wallMs ?? 0;
  const estimated = Object.values(estimates).reduce((a, e) => a + (e?.costUsd ?? 0), 0);
  const savedTotal = Object.values(estimates).reduce((a, e) => a + (e?.savedUsd ?? 0), 0);
  const spentTotal = stats.spentUsd + estimated;
  const currentEstimate = current ? estimates[current.id] ?? estimateOf(tokens) : null;

  return (
    <div className="ags-hq ags-hq__backdrop" role="dialog" aria-modal="true" aria-label={t("botPanel.title")} onClick={() => setOpen(false)}>
      <div className="ags-hq__screen" onClick={(e) => e.stopPropagation()}>
        <div className="ags-hq__bar">
          <span className="ags-hq__title">AGS·BOT // {t("botPanel.title")}</span>
          <span className="ags-hq__blink">_</span>
          <span className="ags-hq__score">HI-SCORE {scoreDigits(pet.xp, 9)}</span>
          <button type="button" className="ags-hq__close" onClick={() => setOpen(false)}>ESC</button>
        </div>

        <div className="ags-hq__body">
          <aside className="ags-hq__hero">
            <Pet level={pet.level} state={busy > 0 ? "working" : "idle"} size={150} />
            <div className="ags-hq__level">LV {pet.level}</div>
            <div className="ags-hq__rank">{t(rankKey(pet.level))}</div>
            <div className="ags-hq__stat">
              <div className="ags-hq__stat-row"><span>EXP</span><b>{formatTokens(pet.xp)}</b></div>
              <Meter value={pet.progress} color="var(--hq-yellow)" />
              <div className="ags-hq__stat-row" style={{ marginTop: 4 }}>
                <span>{t("botPanel.next")}</span><b>{pet.toNext > 0 ? formatTokens(pet.toNext) : "MAX"}</b>
              </div>
            </div>
            <div className="ags-hq__stat">
              <div className="ags-hq__stat-row"><span>PWR</span><b>{tier > 0 ? t("botPanel.phase", { n: tier }) : t("botPanel.resting")}</b></div>
              <Meter value={tier / 4} color={tier >= 4 ? "var(--hq-cyan)" : "var(--hq-orange)"} busy={busy > 0} />
              <div className="ags-hq__stat-row" style={{ marginTop: 4 }}>
                <span>{t("botPanel.agentsNow")}</span><b>{busy}</b>
              </div>
            </div>
            <div className="ags-hq__stat">
              <div className="ags-hq__stat-row"><span>{t("botPanel.trophiesShort")}</span><b>{unlocked}/{trophyList.length}</b></div>
              <Meter value={unlocked / trophyList.length} color="var(--hq-pink)" />
            </div>
          </aside>

          <section className="ags-hq__main">
            <div className="ags-hq__tabs" role="tablist">
              {VIEWS.map((v, i) => (
                <button key={v} type="button" role="tab" aria-selected={view === v} className="ags-hq__tab" onClick={() => setView(v)}>
                  {i + 1}·{t(`botPanel.tab.${v}`)}
                </button>
              ))}
            </div>

            <div className="ags-hq__view">
              {view === "status" && (
                <div className="ags-hq__grid">
                  <Card label={t("botPanel.card.done")} value={scoreDigits(stats.done, 3)} color="var(--hq-cyan)" />
                  <Card label={t("botPanel.card.running")} value={scoreDigits(stats.running, 3)} color="var(--hq-green)" />
                  <Card label={t("botPanel.card.time")} value={clock(stats.missionSeconds)} color="var(--hq-yellow)" />
                  <Card label={t("botPanel.card.longest")} value={clock(stats.longestSeconds)} color="var(--hq-orange)" />
                  <Card label={t("botPanel.card.spent")} value={`$${spentTotal.toFixed(2)}`} color="var(--hq-pink)" />
                  <Card label={t("botPanel.card.saved")} value={`$${savedTotal.toFixed(2)}`} color="var(--hq-green)" />
                  <Card label={t("botPanel.card.success")} value={rate(stats.successRate)} color="var(--hq-green)" sub={t("botPanel.card.successSub", { done: stats.done, failed: stats.failed })} />
                  <Card label={t("botPanel.card.success7")} value={rate(stats.windows.d7.successRate)} color="var(--hq-green)" sub={windowSub(stats.windows.d7)} />
                  <Card label={t("botPanel.card.success30")} value={rate(stats.windows.d30.successRate)} color="var(--hq-green)" sub={windowSub(stats.windows.d30)} />
                  <Card label={t("botPanel.card.cancelled")} value={scoreDigits(stats.cancelled, 3)} color="var(--hq-yellow)" />
                  {stats.testCount > 0 && <Card label={t("botPanel.card.tests")} value={scoreDigits(stats.testCount, 3)} sub={t("botPanel.card.testsSub")} />}
                  <Card label={t("botPanel.card.failed")} value={scoreDigits(stats.failed, 3)} color="var(--hq-pink)" />
                  <Card label={t("botPanel.card.total")} value={scoreDigits(stats.total, 3)} />
                  {Object.entries(stats.failuresByClass).map(([k, n]) => (
                    <Card key={k} label={t("botPanel.card.failCause", { cause: t(failureLabelKey(k as FailureKey)) })} value={scoreDigits(n ?? 0, 3)} color="var(--hq-pink)" />
                  ))}
                </div>
              )}

              {view === "missions" && (
                recent.length === 0 ? <p className="ags-hq__dim">{t("botPanel.empty")}</p> : (
                  <>
                    <div className="ags-hq__list" role="listbox">
                      {recent.map((m, i) => (
                        <button key={m.id} type="button" role="option" aria-selected={i === selected} className="ags-hq__item" onClick={() => setSelected(i)}>
                          <span style={{ color: STATUS_COLOR[m.status] }}>{STATUS_GLYPH[m.status] ?? "?"}</span>
                          <span className="ags-hq__item-title">{m.title}</span>
                          <span className="ags-hq__dim">{clock(missionSeconds(m, now))}</span>
                          <span className="ags-hq__dim">${((m.spentUsd ?? 0) + (estimates[m.id]?.costUsd ?? 0)).toFixed(2)}</span>
                        </button>
                      ))}
                    </div>
                    {current && (
                      <div className="ags-hq__detail">
                        <div style={{ color: "var(--hq-yellow)", marginBottom: 8 }}>{t("botPanel.timeline")} · {current.title}</div>
                        {failureKey(current) && (
                          <p style={{ color: "var(--hq-pink)", marginBottom: 8 }}>
                            {t(failureLabelKey(failureKey(current)!))} → {t(failureActionKey(current), { defaultValue: t("missions.failure.action.unknown") })}
                          </p>
                        )}
                        {!timings || timings.summary.byKind.length === 0 ? <p className="ags-hq__dim">{t("botPanel.noTimings")}</p> : (
                          timings.summary.byKind.map((k) => (
                            <div key={k.kind} className="ags-hq__row">
                              <span>{t(`botPanel.kind.${k.kind}`, { defaultValue: k.kind })}</span>
                              <Meter value={wall > 0 ? k.totalMs / wall : 0} color="var(--hq-cyan)" blocks={20} />
                              <span className="ags-hq__dim">{formatDuration(k.totalMs)}</span>
                            </div>
                          ))
                        )}
                        <MissionStallAlerts missionId={current.id} compact />
                        <MissionStartupTime missionId={current.id} compact />
                        <MissionEfficiencyCard missionId={current.id} compact />
                      </div>
                    )}
                  </>
                )
              )}

              {view === "tokens" && (
                <>
                  <div className="ags-hq__grid">
                    <Card label={t("botPanel.card.xp")} value={formatTokens(pet.xp)} color="var(--hq-yellow)" />
                    <Card label={t("botPanel.card.input")} value={measured.length ? formatCompactNumber(sum("input")) : "--"} color="var(--hq-cyan)" />
                    <Card label={t("botPanel.card.output")} value={measured.length ? formatCompactNumber(sum("output")) : "--"} color="var(--hq-green)" />
                    <Card label={t("botPanel.card.cacheRead")} value={measured.length ? formatCompactNumber(sum("cacheRead")) : "--"} color="var(--hq-orange)" />
                    <Card label={t("botPanel.card.estimate")} value={currentEstimate ? formatUsd(currentEstimate.costUsd) : "--"} color="var(--hq-pink)" />
                    <Card label={t("botPanel.card.saved")} value={currentEstimate ? formatUsd(currentEstimate.savedUsd) : "--"} color="var(--hq-green)" />
                  </div>
                  <p className="ags-hq__dim" style={{ marginTop: 12 }}>
                    {current ? t("botPanel.tokensOf", { title: current.title }) : t("botPanel.empty")}
                  </p>
                  {currentEstimate && <p className="ags-hq__dim">{t("botPanel.estimateNote")}</p>}
                  {currentEstimate && currentEstimate.unpricedModels.length > 0 && (
                    <p className="ags-hq__dim">{t("botPanel.unpriced", { models: currentEstimate.unpricedModels.join(", ") })}</p>
                  )}
                  {tokens?.agents.filter((a) => tabsOfAgent(tokens, a.agentId).length > 0).map((a) => (
                    <div key={a.agentId} style={{ marginTop: 10 }}>
                      <p className="ags-hq__dim">{a.agentId} · {t("missions.tokens.perTab")}</p>
                      <TabCostList agentId={a.agentId} tabs={tabsOfAgent(tokens, a.agentId)} />
                    </div>
                  ))}
                  {tokens && tokens.agents.filter((a) => !a.measured).length > 0 && (
                    <p className="ags-hq__dim">{t("botPanel.unmeasured", { agents: tokens.agents.filter((a) => !a.measured).map((a) => a.agentId).join(", ") })}</p>
                  )}
                </>
              )}

              {view === "trophies" && (
                <div className="ags-hq__trophies">
                  {trophyList.map((tr) => (
                    <div key={tr.id} className={`ags-hq__trophy ${tr.unlocked ? "" : "locked"}`}>
                      <div className="ags-hq__badge">{tr.unlocked ? tr.glyph : "?"}</div>
                      <div>
                        <div className="ags-hq__trophy-name">{t(`botPanel.trophy.${tr.id}.name`)}</div>
                        <div className="ags-hq__trophy-desc">{t(`botPanel.trophy.${tr.id}.desc`)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {view === "live" && runningMissions.length > 1 && (
                <LiveSelector running={runningMissions} value={liveFilter} onChange={setLiveFilter} />
              )}
              {unified && <LiveArcadeGrid running={runningMissions} onOpen={setLiveFilter} />}
              {view === "live" && !unified && (
                current
                  ? <LiveArcade key={current.id} mission={current} tasks={currentDetail?.tasks ?? EMPTY_ARCADE_TASKS} timings={timings} review={liveReview} tokens={tokens} />
                  : <p className="ags-hq__dim">{t("botPanel.live.empty")}</p>
              )}
            </div>
          </section>
        </div>

        <div className="ags-hq__foot">
          <span><b>← →</b> {t("botPanel.keys.menu")}</span>
          <span><b>↑ ↓</b> {t("botPanel.keys.select")}</span>
          <span><b>1-5</b> {t("botPanel.keys.jump")}</span>
          <span><b>ESC</b> {t("botPanel.keys.exit")}</span>
        </div>
      </div>
    </div>
  );
}
