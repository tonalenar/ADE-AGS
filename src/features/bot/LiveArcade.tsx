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

import { deriveArcadeScene, failureCount, retryCount, type ArcadeStageId, type ArcadeTask } from "./liveArcadeModel";

const WIDTH = 960;
const HEIGHT = 480;
const FLOOR_Y: Record<ArcadeStageId, number> = {
  delivery: 110,
  review: 175,
  tests: 240,
  work: 305,
  opening: 370,
};
const STAGE_ORDER: ArcadeStageId[] = ["delivery", "review", "tests", "work", "opening"];
const DIM = "#77799b";

type AgentKind = "claude" | "codex" | "antigravity";
interface Hero { kind: AgentKind; working: boolean }
interface Point { x: number; y: number }

function agentKind(id: string): AgentKind | null {
  const value = id.toLowerCase();
  if (value.includes("claude")) return "claude";
  if (value.includes("codex")) return "codex";
  if (value.includes("antigravity") || value === "agy") return "antigravity";
  return null;
}

function taskForArcade(task: Task): ArcadeTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    role: task.functionalRole ?? task.planKey ?? task.role,
    dependsOn: task.dependsOn,
    attempt: task.attempt,
    checks: task.structuredHandoff?.tests.map((test) => test.status),
  };
}

function pixel(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, size = 4) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), size, size);
}

function drawLadder(ctx: CanvasRenderingContext2D, from: Point, to: Point, color: string) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 3) return;
  const nx = (-dy / length) * 4;
  const ny = (dx / length) * 4;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(from.x + nx, from.y + ny);
  ctx.lineTo(to.x + nx, to.y + ny);
  ctx.moveTo(from.x - nx, from.y - ny);
  ctx.lineTo(to.x - nx, to.y - ny);
  const rungs = Math.max(1, Math.floor(length / 8));
  for (let i = 1; i < rungs; i += 1) {
    const at = i / rungs;
    const x = from.x + dx * at;
    const y = from.y + dy * at;
    ctx.moveTo(x + nx, y + ny);
    ctx.lineTo(x - nx, y - ny);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - dx / length * 7 - nx, to.y - dy / length * 7 - ny);
  ctx.lineTo(to.x - dx / length * 7 + nx, to.y - dy / length * 7 + ny);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawHero(ctx: CanvasRenderingContext2D, x: number, floor: number, hero: Hero, frame: number) {
  const colors: Record<AgentKind, string> = { claude: "#ff9b55", codex: "#62d8ff", antigravity: "#c18aff" };
  const color = colors[hero.kind];
  const y = floor - 31;
  const step = hero.working && frame % 2 === 0 ? 4 : 0;
  pixel(ctx, x + 5, y, "#ffe0b8", 8);
  pixel(ctx, x + 3, y + 3, color, 12);
  pixel(ctx, x + 1, y + 4, color, 4);
  pixel(ctx, x + 13, y + 4, color, 4);
  pixel(ctx, x + 5, y + 12, "#161225", 4);
  pixel(ctx, x + 11, y + 12, "#161225", 4);
  if (hero.working) {
    pixel(ctx, x + 4 + step, y + 16, color, 4);
    pixel(ctx, x + 12 - step, y + 16, color, 4);
  } else {
    pixel(ctx, x + 4, y + 16, color, 4);
    pixel(ctx, x + 12, y + 16, color, 4);
    ctx.fillStyle = "#abb1d8";
    ctx.font = '10px "Press Start 2P", monospace';
    ctx.fillText("Z", x + 15, y - 1);
  }
}

function taskColor(status: string): string {
  if (status === "done") return "#55e6b1";
  if (status === "running") return "#b6ff58";
  if (status === "failed") return "#ff6b8d";
  if (status === "ready") return "#ffbc62";
  if (status === "cancelled" || status === "skipped") return "#77799b";
  return "#aab0d0";
}

function drawArcade(
  ctx: CanvasRenderingContext2D,
  scene: ReturnType<typeof deriveArcadeScene>,
  heroes: Hero[],
  title: string,
  arcadeLabel: string,
  teamLabel: string,
  stageLabel: (stage: ArcadeStageId) => string,
  statusLabel: (status: string) => string,
  frame: number,
) {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = "#100d24";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  for (let i = 0; i < 38; i += 1) pixel(ctx, 18 + ((i * 71) % 910), 18 + ((i * 37) % 55), i % 3 ? "#343052" : "#66558a", 2);

  ctx.font = '10px "Press Start 2P", monospace';
  ctx.fillStyle = "#ffe15a";
  ctx.fillText(arcadeLabel, 24, 28);
  ctx.font = '8px "Press Start 2P", monospace';
  ctx.fillStyle = "#f4efff";
  const clippedTitle = title.length > 54 ? title.slice(0, 51) + "..." : title;
  ctx.fillText(clippedTitle, 24, 52);
  ctx.fillStyle = "#63dfff";
  ctx.fillText(scene.currentStage ? stageLabel(scene.currentStage) : "—", WIDTH - 265, 30);

  const pointByTask = new Map<string, Point>();
  const tasksByStage = new Map<ArcadeStageId, typeof scene.tasks>();
  for (const stage of ["work", "tests", "review"] as const) {
    const stageTasks = scene.tasks.filter((task) => task.stage === stage);
    tasksByStage.set(stage, stageTasks);
    const slot = 600 / Math.max(1, stageTasks.length);
    stageTasks.forEach((task, index) => pointByTask.set(task.id, {
      x: 190 + slot * (index + 0.5),
      y: FLOOR_Y[stage] - 10,
    }));
  }

  for (const dependency of scene.dependencies) {
    const from = pointByTask.get(dependency.from);
    const to = pointByTask.get(dependency.to);
    if (!from || !to) continue;
    const parent = scene.tasks.find((task) => task.id === dependency.from);
    drawLadder(ctx, from, to, parent?.status === "done" ? "#59d7ff" : "#77799b");
  }

  for (const stage of STAGE_ORDER) {
    const stageData = scene.stages.find((item) => item.id === stage);
    const y = FLOOR_Y[stage];
    ctx.fillStyle = "#de5d72";
    ctx.fillRect(158, y, 650, 8);
    for (let x = 158; x < 808; x += 28) {
      ctx.fillStyle = "#f5a25c";
      ctx.fillRect(x, y + 2, 14, 3);
    }
    ctx.font = '7px "Press Start 2P", monospace';
    ctx.fillStyle = stageData?.status === "unknown" ? DIM : "#fff0a0";
    ctx.fillText(stageLabel(stage), 18, y + 5);
    ctx.textAlign = "right";
    ctx.fillStyle = stageData?.status === "unknown" ? DIM : taskColor(stageData?.status ?? "");
    ctx.fillText(statusLabel(stageData?.status ?? "unknown"), WIDTH - 18, y + 5);
    ctx.textAlign = "left";
  }

  for (const stage of ["work", "tests", "review"] as const) {
    const tasks = tasksByStage.get(stage) ?? [];
    const slot = 600 / Math.max(1, tasks.length);
    const nodeWidth = Math.max(34, Math.min(92, slot - 8));
    tasks.forEach((task) => {
      const point = pointByTask.get(task.id);
      if (!point) return;
      const x = point.x - nodeWidth / 2;
      const y = FLOOR_Y[stage] - 37;
      ctx.fillStyle = "#211a39";
      ctx.fillRect(x, y, nodeWidth, 25);
      ctx.strokeStyle = taskColor(task.status);
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, nodeWidth, 25);
      ctx.font = '6px "Press Start 2P", monospace';
      ctx.fillStyle = "#f5efff";
      const taskTitle = task.title.length > 14 ? task.title.slice(0, 11) + "..." : task.title;
      ctx.textAlign = "center";
      ctx.fillText(taskTitle, point.x, y + 16, nodeWidth - 6);
      ctx.textAlign = "left";
    });
  }

  ctx.fillStyle = "#734b9d";
  ctx.fillRect(158, HEIGHT - 28, 650, 8);
  for (let x = 158; x < 808; x += 28) {
    ctx.fillStyle = "#b77ae3";
    ctx.fillRect(x, HEIGHT - 26, 14, 3);
  }
  heroes.forEach((hero, index) => drawHero(ctx, 175 + index * 42 + (hero.working ? (frame % 4) * 3 : 0), HEIGHT - 20, hero, frame));
  ctx.font = '6px "Press Start 2P", monospace';
  ctx.fillStyle = "#9799b9";
  ctx.fillText(teamLabel, 18, HEIGHT - 10);
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
  const frameRef = useRef(0);
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const tabs = useTabsStore((state) => state.tabs);
  const runtimeTasks = useRunsStore((state) => state.tasks);
  const missionIndex = useMissionIndex();
  const activeTabs = useSustainedTabs();
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
  const heroes = useMemo(() => {
    const kinds = new Set<AgentKind>();
    for (const task of missionTasks) {
      const kind = agentKind(task.agentId);
      if (kind) kinds.add(kind);
    }
    const activeKinds = new Set(activeTabs
      .filter((id) => missionIndex[id] === mission.id)
      .map((id) => agentKind(tabs.find((tab) => tab.id === id)?.agentId ?? ""))
      .filter((kind): kind is AgentKind => kind !== null));
    for (const kind of activeKinds) kinds.add(kind);
    return [...kinds].map((kind) => ({ kind, working: activeKinds.has(kind) }));
  }, [missionTasks, activeTabs, missionIndex, mission.id, tabs]);
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
    let timer: number | undefined;
    const draw = () => {
      if (document.visibilityState !== "visible") return;
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(bounds.width * ratio);
      canvas.height = Math.round((bounds.width * HEIGHT / WIDTH) * ratio);
      const scale = bounds.width / WIDTH;
      context.setTransform(scale * ratio, 0, 0, scale * ratio, 0, 0);
      drawArcade(
        context,
        scene,
        heroes,
        mission.title,
        t("botPanel.live.arcadeTitle"),
        t("botPanel.live.teamShort"),
        (stage) => t("botPanel.live.stage." + stage),
        (status) => t("botPanel.live.status." + status),
        reducedMotion ? 0 : frameRef.current,
      );
      frameRef.current += 1;
    };
    const start = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      draw();
      if (!reducedMotion && heroes.some((hero) => hero.working)) timer = window.setInterval(draw, 125);
    };
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    document.addEventListener("visibilitychange", start);
    start();
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", start);
    };
  }, [scene, heroes, mission.title, reducedMotion, t]);

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
          <span className={"ags-live__agent ags-live__agent--" + hero.kind} key={hero.kind}>
            <i aria-hidden="true" />
            {t("botPanel.live.agent." + hero.kind)}
            <b>{hero.working ? t("botPanel.live.running") : t("botPanel.live.sleeping")}</b>
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
        {" " + t("botPanel.live.score", { retries: retryCount(sceneTasks), failures: failureCount(sceneTasks) })}
      </span>
    </div>
  );
}
