import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { beamY } from "./liveArcadeScene";
import { activeSourceKey, formatActive } from "@/features/missions/timings";
import { formatUsd, estimateOf, type MissionTokens } from "@/features/missions/tokens";
import { useMissionIndex } from "@/features/missions/groups";
import type { MissionTimings } from "@/features/missions/timings";
import type { Delivery, MissionReview, MissionSummary } from "@/features/missions/types";
import { useRunsStore } from "@/features/runs/store";
import type { Task } from "@/features/runs/types";
import { sustainedTabIds } from "@/features/terminal/activity";
import { useTabsStore } from "@/features/tabs/store";

import { getPendingCounts } from "@/features/memory/ipc";

import { PlatformLogo } from "./PlatformLogo";
import { useArcadeSignals } from "./arcadeSignals";
import { drawArcade, ROLE_COLOR, type Placed, type Pose } from "./liveArcadeDraw";
import { deriveArcadeScene, deriveBarrels, deriveBoss, deriveHeroes, deriveTower, deriveTrophy, failureCount, newlyDone, retryCount, roleOf, type ArcadeTask, type ArcadeTabInput, type ArcadeTaskStatus } from "./liveArcadeModel";
import { ARCADE_H, ARCADE_W, BOLT_MS, FRAME_MS, TOWER_DROP_X, bossFoot, boltAt, heroLift, shotDue, heroTargets, placeBarrels, patrolOffset, stepMotion, taskSlots, type Motion } from "./liveArcadeScene";

const WALK_SPEED = 50;
const RUN_SPEED = 110;

function taskForArcade(task: Task): ArcadeTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    role: task.functionalRole ?? task.planKey ?? task.role,
    dependsOn: task.dependsOn,
    attempt: task.attempt,
    checks: task.structuredHandoff?.tests.map((test) => test.status),
    sessionId: task.sessionId,
    aliases: [task.planKey, task.functionalRole].filter((value): value is string => !!value),
    endedAt: task.endedAt,
  };
}

/**
 * Tempo ativo "ao vivo": a leitura do app chega a cada tanto; entre elas o relógio avança 1 s por
 * segundo enquanto a missão roda e algum herói trabalha (o mesmo critério do contador real). Nunca
 * volta atrás ao chegar uma leitura nova: o valor mostrado só sobe.
 */
function useLiveActiveMs(baseMs: number | null, running: boolean, working: boolean): number | null {
  const [, setTick] = useState(0);
  const extra = useRef(0);
  const shown = useRef<number | null>(null);
  useEffect(() => { extra.current = 0; }, [baseMs]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      if (working) extra.current += 1000;
      setTick((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running, working]);
  if (baseMs === null && extra.current === 0) return null;
  const value = (baseMs ?? 0) + extra.current;
  shown.current = shown.current === null ? value : Math.max(shown.current, value);
  return shown.current;
}

function useSustainedTabs() {
  const [ids, setIds] = useState<string[]>(() => sustainedTabIds());
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: number | undefined;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      const next = sustainedTabIds();
      setIds((current) => current.length === next.length && current.every((id, i) => id === next[i]) ? current : next);
    };
    const start = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      refresh();
      timer = window.setInterval(refresh, motion.matches ? 1000 : 125);
    };
    document.addEventListener("visibilitychange", start);
    motion.addEventListener("change", start);
    start();
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", start);
      motion.removeEventListener("change", start);
    };
  }, []);
  return ids;
}

export function LiveArcade({
  mission,
  tasks,
  timings,
  review,
  tokens,
}: {
  mission: MissionSummary;
  tasks: Task[];
  timings: MissionTimings | null;
  review: MissionReview | null;
  tokens: MissionTokens | null;
}) {
  const { t, i18n } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const motionRef = useRef(new Map<string, Motion>());
  /** tarefa concluída → terminal que carrega o bloco até a torre. */
  const carryRef = useRef(new Map<string, string>());
  const statusRef = useRef<Map<string, ArcadeTaskStatus> | null>(null);
  /** Tiros em voo e quando cada herói atirou pela última vez; o GLITCH pisca quando um tiro chega. */
  const boltsRef = useRef<Array<{ id: string; from: { x: number; y: number }; at: number; color: string }>>([]);
  const lastShotRef = useRef(new Map<string, number>());
  const hitUntilRef = useRef(0);
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const tabs = useTabsStore((state) => state.tabs);
  const runtimeTasks = useRunsStore((state) => state.tasks);
  const missionIndex = useMissionIndex();
  const activeTabs = useSustainedTabs();
  const approvals = useRunsStore((state) => state.approvals);
  const workspaceId = useTabsStore((state) => state.workspaceId);
  const [pendingMemories, setPendingMemories] = useState<number | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    const read = () => getPendingCounts(workspaceId)
      .then((counts) => alive && setPendingMemories(counts.byMission[mission.id] ?? 0)).catch(() => undefined);
    read();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") read(); }, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [workspaceId, mission.id]);
  const missionTasks = useMemo(() => {
    const activeRunTasks = mission.activeRunId
      ? runtimeTasks.filter((task) => task.runId === mission.activeRunId)
      : [];
    return activeRunTasks.length ? activeRunTasks : tasks;
  }, [runtimeTasks, mission.activeRunId, tasks]);
  const sceneTasks = useMemo(() => missionTasks.map(taskForArcade), [missionTasks]);
  const scene = useMemo(() => deriveArcadeScene({
    missionStatus: mission.status,
    tasks: sceneTasks,
    timings: timings?.spans.map((span) => ({ kind: span.kind, detail: span.detail })) ?? null,
    reviews: review?.deliveries.map((delivery: Delivery) => ({ review: delivery.review })) ?? null,
  }), [mission.status, sceneTasks, timings, review]);
  const approvalTaskIds = useMemo(
    () => (mission.activeRunId ? approvals.map((approval) => approval.taskId) : null),
    [approvals, mission.activeRunId],
  );
  const barrels = useMemo(() => deriveBarrels({
    scene,
    approvalTaskIds,
    pendingMemories,
    timings: timings?.spans ?? null,
  }), [scene, approvalTaskIds, pendingMemories, timings]);
  const trophy = useMemo(() => deriveTrophy(review), [review]);
  const worked = useArcadeSignals((state) => state.worked);
  const deliveriesByTab = useArcadeSignals((state) => state.deliveries);
  const missionTabs = useMemo<ArcadeTabInput[]>(() => tabs
    .filter((tab) => missionIndex[tab.id] === mission.id)
    .map((tab) => ({ id: tab.id, title: tab.title, agentId: tab.agentId, sessionId: tab.sessionId ?? null })),
  [tabs, missionIndex, mission.id]);
  const signals = useMemo(() => ({
    workedTabIds: Object.keys(worked),
    deliveredTabIds: missionTabs.filter((tab) => (deliveriesByTab[tab.id]?.length ?? 0) > 0).map((tab) => tab.id),
    missionStatus: mission.status,
  }), [worked, deliveriesByTab, missionTabs, mission.status]);
  const heroes = useMemo(() => deriveHeroes({ tabs: missionTabs, scene, sustainedTabIds: activeTabs, approvalTaskIds, barrels, signals }),
    [missionTabs, scene, activeTabs, approvalTaskIds, barrels, signals]);
  /** Uma entrega final real = um bloco na torre (quando a missão não tem tarefas). */
  const deliveries = useMemo(() => missionTabs.flatMap((tab) =>
    (deliveriesByTab[tab.id] ?? []).map((at) => ({ id: "d:" + tab.id + ":" + at, tabId: tab.id, role: roleOf(tab.title) }))),
  [missionTabs, deliveriesByTab]);
  const towerNow = useMemo(() => deriveTower({ scene, trophy, deliveries }), [scene, trophy, deliveries]);
  const plannedTasks = useMemo(() => scene.tasks.filter((task) => task.status !== "cancelled" && task.status !== "skipped").length, [scene]);
  const boss = useMemo(
    () => deriveBoss({ missionStatus: mission.status, plannedTasks, tower: towerNow, teamSize: heroes.length }),
    [mission.status, plannedTasks, towerNow, heroes.length],
  );
  const loreLines = useMemo(() => [t("botPanel.live.lore1"), t("botPanel.live.lore2"), t("botPanel.live.lore3")], [t]);
  const seenDeliveries = useRef<Set<string> | null>(null);
  // Entrega nova: o herói leva o bloco até a torre. O que já existia ao abrir entra direto.
  useEffect(() => {
    const seen = seenDeliveries.current;
    if (seen && !reducedMotion) {
      for (const item of deliveries) if (!seen.has(item.id) && heroes.some((hero) => hero.tabId === item.tabId)) carryRef.current.set(item.id, item.tabId);
    }
    seenDeliveries.current = new Set(deliveries.map((item) => item.id));
  }, [deliveries]); // eslint-disable-line react-hooks/exhaustive-deps
  // Entrega nova (running -> done): o herói da tarefa leva o bloco até a torre. Sem herói ou sem animação, o bloco entra direto.
  useEffect(() => {
    if (!reducedMotion) {
      for (const id of newlyDone(statusRef.current, sceneTasks)) {
        const hero = heroes.find((item) => item.taskId === id);
        if (hero) carryRef.current.set(id, hero.tabId);
      }
    }
    statusRef.current = new Map(sceneTasks.map((task) => [task.id, task.status]));
  }, [sceneTasks]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(motion.matches);
    motion.addEventListener("change", update);
    return () => motion.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const slots = taskSlots(scene);
    const targets = heroTargets(heroes, slots);
    const motions = motionRef.current;
    for (const id of [...motions.keys()]) if (!heroes.some((hero) => hero.tabId === id)) motions.delete(id);
    let raf: number | undefined;
    let last: number | null = null;
    let frame = 0;
    const draw = (dt: number, now: number) => {
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(bounds.width * ratio);
      canvas.height = Math.round((bounds.width * ARCADE_H / ARCADE_W) * ratio);
      const scale = bounds.width / ARCADE_W;
      context.setTransform(scale * ratio, 0, 0, scale * ratio, 0, 0);
      const carrying = carryRef.current;
      const rolling = placeBarrels(barrels, slots, now, !reducedMotion);
      const carrier = new Map([...carrying].map(([taskId, tabId]) => [tabId, taskId]));
      const placed: Placed[] = heroes.map((hero, index) => {
        const carried = carrier.get(hero.tabId);
        const target = carried ? { x: TOWER_DROP_X, level: 0 } : targets.get(hero.tabId) ?? { x: 190, level: 0 };
        // Sem animação (prefers-reduced-motion) a posição já é a final.
        const from = motions.get(hero.tabId) ?? (reducedMotion ? target : { x: 190, level: 0 });
        const next = reducedMotion ? target : stepMotion(from, target, dt, hero.state === "running" ? RUN_SPEED : WALK_SPEED);
        motions.set(hero.tabId, next);
        const atTarget = next.level === target.level && next.x === target.x;
        if (carried && atTarget) carrying.delete(carried);
        const climbing = next.level !== Math.round(next.level);
        const patrol = !reducedMotion && atTarget && hero.state === "running";
        const moving = !atTarget || patrol;
        let pose: Pose = "stand";
        if (climbing) pose = "climb";
        else if (moving) pose = frame % 2 === 0 ? "walkA" : "walkB";
        else if (hero.state === "sleeping") pose = "sleep";
        const carryRole = carried && !atTarget ? hero.role : undefined;
        // Nunca congelado: quem espera ("!") treme, quem dorme respira e, com o GLITCH derrotado, todos comemoram.
        const shake = !reducedMotion && hero.state === "stopped" && atTarget ? (frame % 2 === 0 ? -1 : 1) : 0;
        const breath = !reducedMotion && hero.state === "sleeping" && atTarget ? (Math.sin(now / 500 + index) > 0 ? 1 : 0) : 0;
        const cheer = !reducedMotion && boss.defeated && atTarget && !climbing ? Math.round(Math.abs(Math.sin(now / 220 + index)) * 10) : 0;
        const drawnX = next.x + (patrol ? patrolOffset(now, index) : 0) + shake;
        return { hero, x: drawnX, level: next.level, pose, lift: reducedMotion ? 0 : heroLift(next.level, drawnX, rolling) + cheer - breath, carrying: carryRole };
      });
      // Quem corre atira no GLITCH: o tiro sai do herói, voa em arco e, ao chegar, o inimigo pisca.
      const foot = bossFoot(now, boss.defeated);
      const target = { x: foot.x, y: foot.y - 22 };
      if (!reducedMotion && !boss.defeated) {
        for (const [index, item] of placed.entries()) {
          if (item.hero.state !== "running") continue;
          if (!shotDue(lastShotRef.current.get(item.hero.tabId), now, index)) continue;
          lastShotRef.current.set(item.hero.tabId, now);
          boltsRef.current.push({ id: item.hero.tabId + ":" + Math.round(now), from: { x: item.x, y: beamY(item.level, item.x) - item.lift - 22 }, at: now, color: ROLE_COLOR[item.hero.role] });
        }
      }
      const flying: Array<{ x: number; y: number; color: string }> = [];
      boltsRef.current = boltsRef.current.filter((bolt) => {
        const progress = (now - bolt.at) / BOLT_MS;
        if (progress >= 1) { hitUntilRef.current = now + 160; return false; }
        flying.push({ ...boltAt(bolt.from, target, progress), color: bolt.color });
        return true;
      });
      const loreLine = loreLines[Math.floor(now / 7000) % loreLines.length];
      // Carregadores que sumiram (terminal fechado) não deixam o bloco preso no caminho.
      for (const [taskId, tabId] of carrying) if (!heroes.some((hero) => hero.tabId === tabId)) carrying.delete(taskId);
      const tower = deriveTower({ scene, trophy, carrying: new Set(carrying.keys()), deliveries });
      drawArcade(context, {
        scene,
        title: mission.title,
        labels: {
          arcade: t("botPanel.live.arcadeTitle"),
          team: t("botPanel.live.teamShort"),
          trophy: t("botPanel.live.trophy." + (trophy.step ?? "unknown")),
          tower: t("botPanel.live.tower", { done: tower.done, total: tower.planned }),
          stage: (stage) => t("botPanel.live.stage." + stage),
          status: (status) => t("botPanel.live.status." + status),
        },
        heroes: placed,
        boss: {
          boss, x: foot.x, y: foot.y, hit: now < hitUntilRef.current, lore: loreLine,
          label: boss.defeated ? t("botPanel.live.bossDefeated") : t("botPanel.live.boss", { done: boss.done, total: boss.total }),
        },
        bolts: flying,
        barrels: rolling,
        trophy,
        tower,
        frame,
      });
      frame += 1;
    };
    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);
      if (last !== null && ts - last < FRAME_MS) return;
      const dt = last === null ? 0 : Math.min(ts - last, 250);
      last = ts;
      draw(dt, ts);
    };
    const stop = () => {
      if (raf !== undefined) cancelAnimationFrame(raf);
      raf = undefined;
    };
    const start = () => {
      stop();
      if (document.visibilityState !== "visible") return;
      last = null;
      draw(0, performance.now());
      // Parado para quem prefere menos movimento; sem heróis também não há o que animar.
      if (!reducedMotion && heroes.length > 0) raf = requestAnimationFrame(tick);
    };
    const observer = new ResizeObserver(() => { if (document.visibilityState === "visible") draw(0, performance.now()); });
    observer.observe(canvas);
    document.addEventListener("visibilitychange", start);
    start();
    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", start);
    };
  }, [scene, heroes, mission.title, reducedMotion, t, barrels, trophy, deliveries, boss, loreLines]);

  const measured = tokens?.agents.filter((agent) => agent.measured) ?? [];
  const tokenValues = measured.flatMap((agent) => [agent.input, agent.output]).filter((value): value is number => value !== null);
  const totalTokens = tokenValues.length ? tokenValues.reduce((sum, value) => sum + value, 0) : null;
  const tokenFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language, { notation: "compact", maximumFractionDigits: 1 }),
    [i18n.language, i18n.resolvedLanguage],
  );
  const estimate = estimateOf(tokens);
  const budget = mission.budgetUsd === null ? null : formatUsd(mission.spentUsd) + " / " + formatUsd(mission.budgetUsd);
  const lives = sceneTasks.length
    ? t("botPanel.live.livesValue", { retries: retryCount(sceneTasks), failures: failureCount(sceneTasks) })
    : null;
  // Fonte unificada (Etapa 14): a mesma da lista e de `ags mission efficiency`; sem dado, cinza.
  const baseActiveMs = timings?.active.ms ?? (mission.activeSeconds === null ? null : mission.activeSeconds * 1000);
  const activeMs = useLiveActiveMs(baseActiveMs, mission.status === "running", heroes.some((hero) => hero.state === "running"));
  const activeSource = timings?.active.source ?? mission.activeSource ?? null;
  const activeValue = formatActive(activeMs);
  const activeKey = activeSourceKey(activeSource);
  const activeTitle = activeKey ? t(activeKey) : undefined;
  const metrics = [
    { key: "tokens", value: totalTokens === null ? null : tokenFormatter.format(totalTokens) },
    { key: "activeTime", value: activeValue, title: activeTitle },
    { key: "cost", value: estimate ? formatUsd(estimate.costUsd) : null },
    { key: "cache", value: estimate ? formatUsd(estimate.savedUsd) : null },
    { key: "budget", value: budget },
    { key: "lives", value: lives },
  ];
  const stateLabel = (state: string) => t(state === "running" ? "botPanel.live.running" : state === "stopped" ? "botPanel.live.waiting" : "botPanel.live.sleeping");

  return (
    <div className="ags-live">
      <canvas
        ref={canvasRef}
        className="ags-live__canvas"
        role="img"
        aria-label={t("botPanel.live.canvasLabel", { title: mission.title })}
        aria-describedby={"ags-live-description-" + mission.id}
      />
      <div className="ags-live__hud">
        {metrics.map(({ key, value, title }: { key: string; value: string | null; title?: string }) => (
          <div className={"ags-live__metric " + (value === null ? "ags-live__metric--unknown" : "")} key={key} title={title}>
            <span>{t("botPanel.live.metric." + key)}</span>
            <b>{value ?? t("botPanel.live.notMeasured")}</b>
          </div>
        ))}
      </div>
      <div className="ags-live__agents" aria-label={t("botPanel.live.agents")}>
        {heroes.length === 0 ? <span className="ags-live__unknown">{t("botPanel.live.noAgents")}</span> : heroes.map((hero) => (
          <span className={"ags-live__agent ags-live__agent--" + hero.kind + " ags-live__agent--" + hero.role} key={hero.tabId}>
            <PlatformLogo kind={hero.kind} />
            {hero.name} · {t("botPanel.live.agent." + hero.kind)}
            <b>{stateLabel(hero.state)}</b>
          </span>
        ))}
      </div>
      <span id={"ags-live-description-" + mission.id} className="ags-live__sr-only">
        {scene.stages.map((stage) =>
          t("botPanel.live.stage." + stage.id) + ": " + t("botPanel.live.status." + stage.status)
        ).join(". ")}
        {" " + scene.tasks.map((task) =>
          task.title + ": " + t("botPanel.live.taskStatus." + task.status)
        ).join(". ")}
        {" " + heroes.map((hero) => hero.name + ": " + stateLabel(hero.state)).join(". ")}
        {" " + barrels.map((barrel) => t("botPanel.live.barrel." + barrel.kind) + (barrel.detail ? " (" + barrel.detail + ")" : "")).join(". ")}
        {" " + t("botPanel.live.tower", { done: towerNow.done, total: towerNow.planned }) + ". " + t("botPanel.live.towerUnmeasured")}
        {" " + t("botPanel.live.trophy." + (trophy.step ?? "unknown"))}
        {" " + t("botPanel.live.score", { retries: retryCount(sceneTasks), failures: failureCount(sceneTasks) })}
      </span>
    </div>
  );
}
