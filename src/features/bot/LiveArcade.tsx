import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatUsd, estimateOf, type MissionTokens } from "@/features/missions/tokens";
import { useMissionIndex } from "@/features/missions/groups";
import type { MissionTimings } from "@/features/missions/timings";
import type { Delivery, MissionReview, MissionSummary } from "@/features/missions/types";
import { useRunsStore } from "@/features/runs/store";
import type { Task } from "@/features/runs/types";
import { sustainedTabIds } from "@/features/terminal/activity";
import { useTabsStore } from "@/features/tabs/store";

import { getPendingCounts } from "@/features/memory/ipc";

import { drawArcade, type Placed, type Pose } from "./liveArcadeDraw";
import { deriveArcadeScene, deriveBarrels, deriveHeroes, deriveTower, deriveTrophy, failureCount, newlyDone, retryCount, type ArcadeTask, type ArcadeTabInput, type ArcadeTaskStatus } from "./liveArcadeModel";
import { ARCADE_H, ARCADE_W, FRAME_MS, TOWER_DROP_X, heroLift, heroTargets, placeBarrels, patrolOffset, stepMotion, taskSlots, type Motion } from "./liveArcadeScene";

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
  const towerNow = useMemo(() => deriveTower({ scene, trophy }), [scene, trophy]);
  const missionTabs = useMemo<ArcadeTabInput[]>(() => tabs
    .filter((tab) => missionIndex[tab.id] === mission.id)
    .map((tab) => ({ id: tab.id, title: tab.title, agentId: tab.agentId, sessionId: tab.sessionId ?? null })),
  [tabs, missionIndex, mission.id]);
  const heroes = useMemo(() => deriveHeroes({ tabs: missionTabs, scene, sustainedTabIds: activeTabs, approvalTaskIds, barrels }),
    [missionTabs, scene, activeTabs, approvalTaskIds, barrels]);
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
        return { hero, x: next.x + (patrol ? patrolOffset(now, index) : 0), level: next.level, pose, lift: reducedMotion ? 0 : heroLift(next.level, next.x, rolling), carrying: carryRole };
      });
      // Carregadores que sumiram (terminal fechado) não deixam o bloco preso no caminho.
      for (const [taskId, tabId] of carrying) if (!heroes.some((hero) => hero.tabId === tabId)) carrying.delete(taskId);
      const tower = deriveTower({ scene, trophy, carrying: new Set(carrying.keys()) });
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
  }, [scene, heroes, mission.title, reducedMotion, t, barrels, trophy]);

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
  const metrics = [
    { key: "tokens", value: totalTokens === null ? null : tokenFormatter.format(totalTokens) },
    { key: "activeTime", value: mission.activeSeconds === null ? null : mission.activeSeconds + "s" },
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
        {metrics.map(({ key, value }) => (
          <div className={"ags-live__metric " + (value === null ? "ags-live__metric--unknown" : "")} key={key}>
            <span>{t("botPanel.live.metric." + key)}</span>
            <b>{value ?? t("botPanel.live.notMeasured")}</b>
          </div>
        ))}
      </div>
      <div className="ags-live__agents" aria-label={t("botPanel.live.agents")}>
        {heroes.length === 0 ? <span className="ags-live__unknown">{t("botPanel.live.noAgents")}</span> : heroes.map((hero) => (
          <span className={"ags-live__agent ags-live__agent--" + hero.kind + " ags-live__agent--" + hero.role} key={hero.tabId}>
            <i aria-hidden="true" />
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
