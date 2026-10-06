import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { fitViewport, INITIAL_VIEWPORT, viewportReducer, zoomPercent } from "@/features/canvas/design/viewport";
import type { Task, TaskStatus } from "@/features/runs/types";
import { useTaskActivity, type TaskActivity } from "@/shared/bus";

const NODE_W = 196;
const NODE_H = 74;
const GAP_X = 20;
const GAP_Y = 44;
const PAD = 12;

const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: "border-gray-300 dark:border-white/15",
  ready: "border-amber-400",
  running: "border-emerald-500",
  done: "border-blue-500",
  failed: "border-red-500",
  cancelled: "border-gray-300 dark:border-white/15",
  handed_off: "border-violet-400",
  skipped: "border-gray-300 dark:border-white/15",
};

const STATUS_DOT: Record<TaskStatus, string> = {
  pending: "bg-gray-400",
  ready: "bg-amber-400",
  running: "bg-emerald-500 animate-pulse",
  done: "bg-blue-500",
  failed: "bg-red-500",
  cancelled: "bg-gray-300 dark:bg-white/20",
  handed_off: "bg-violet-400",
  skipped: "bg-gray-300 dark:bg-white/20",
};

export interface Placed {
  task: Task;
  x: number;
  y: number;
}

/**
 * En qué fila va cada tarea: el lead arriba; cada worker, una fila debajo de la más baja de
 * sus dependencias (las que no tienen, en la primera fila de workers). Un ciclo (que el plan
 * no debería permitir) corta en la fila donde se detecta, en vez de colgar el layout.
 */
export function layoutRows(tasks: Task[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rows = new Map<string, number>();
  const visiting = new Set<string>();
  const rowOf = (task: Task): number => {
    const known = rows.get(task.id);
    if (known !== undefined) return known;
    if (task.role === "lead") return rows.set(task.id, 0).get(task.id)!;
    if (visiting.has(task.id)) return 1;
    visiting.add(task.id);
    const deps = task.dependsOn.map((d) => byId.get(d)).filter((d): d is Task => !!d && d.role !== "lead");
    const row = deps.length === 0 ? 1 : Math.max(...deps.map(rowOf)) + 1;
    visiting.delete(task.id);
    rows.set(task.id, row);
    return row;
  };
  tasks.forEach(rowOf);
  return rows;
}

/** Dónde va cada nodo y el tamaño del lienzo. Pura: la prueban los tests sin DOM. */
export function layoutMap(tasks: Task[]): { placed: Placed[]; width: number; height: number } {
  const rows = layoutRows(tasks);
  const byRow = new Map<number, Task[]>();
  for (const task of tasks) {
    const row = rows.get(task.id) ?? 1;
    byRow.set(row, [...(byRow.get(row) ?? []), task]);
  }
  const widest = Math.max(1, ...[...byRow.values()].map((r) => r.length));
  const width = PAD * 2 + widest * NODE_W + (widest - 1) * GAP_X;
  const placed: Placed[] = [];
  for (const [row, list] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    const rowWidth = list.length * NODE_W + (list.length - 1) * GAP_X;
    const start = (width - rowWidth) / 2;
    list.forEach((task, i) => placed.push({ task, x: start + i * (NODE_W + GAP_X), y: PAD + row * (NODE_H + GAP_Y) }));
  }
  const lastRow = Math.max(0, ...rows.values());
  return { placed, width, height: PAD * 2 + (lastRow + 1) * NODE_H + lastRow * GAP_Y };
}

/** El encuadre que muestra todo el mapa en el área visible (sin ampliar más de 1:1). Pura. */
export function fitMap(width: number, height: number, viewW: number, viewH: number) {
  const v = fitViewport([{ x: 0, y: 0, w: width, h: height }], viewW, viewH, 12);
  return v.zoom > 1 ? { zoom: 1, x: (viewW - width) / 2, y: (viewH - height) / 2 } : v;
}

/**
 * El mapa de una misión: quién reparte, quién depende de quién, en qué está cada agente y
 * con qué cuenta. Se arma con las tareas que ya muestra el detalle (que se refrescan por
 * `cc-task-changed`) y la actividad en vivo del bus (`task.activity`).
 */
export function MissionMap({ tasks, accountLabel }: {
  tasks: Task[];
  accountLabel: (accountId: string | null, autoAccount: boolean) => string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const activity = useTaskActivity(useMemo(() => tasks.map((task) => task.id), [tasks]));

  const { placed, width, height } = useMemo(() => layoutMap(tasks), [tasks]);

  const at = new Map(placed.map((p) => [p.task.id, p]));
  const lead = tasks.find((task) => task.role === "lead");
  const edges: { from: Placed; to: Placed; kind: "dep" | "lead" }[] = [];
  for (const p of placed) {
    if (p.task.role === "lead") continue;
    const deps = p.task.dependsOn.map((d) => at.get(d)).filter((d): d is Placed => !!d);
    for (const d of deps) edges.push({ from: d, to: p, kind: "dep" });
    if (deps.length === 0 && lead && at.get(lead.id)) edges.push({ from: at.get(lead.id)!, to: p, kind: "lead" });
  }

  if (tasks.length === 0) return null;

  return (
    <section className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="self-start text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/60"
      >
        {open ? "▾" : "▸"} {t("missions.map.title")}
      </button>
      {open && (
        <MapViewport width={width} height={height} resetKey={tasks.length}>
          <svg className="absolute inset-0 pointer-events-none" width={width} height={height}>
            {edges.map(({ from, to, kind }) => {
              const x1 = from.x + NODE_W / 2;
              const y1 = from.y + NODE_H;
              const x2 = to.x + NODE_W / 2;
              const y2 = to.y;
              const mid = (y1 + y2) / 2;
              return (
                <path
                  key={`${from.task.id}-${to.task.id}`}
                  d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
                  fill="none"
                  className={kind === "dep" ? "stroke-gray-400 dark:stroke-white/30" : "stroke-gray-300 dark:stroke-white/15"}
                  strokeWidth={1.5}
                  strokeDasharray={kind === "lead" ? "4 4" : undefined}
                />
              );
            })}
          </svg>
          {placed.map(({ task, x, y }) => (
            <Node key={task.id} task={task} x={x} y={y} activity={activity[task.id]} account={accountLabel(task.accountId, task.autoAccount ?? true)} />
          ))}
        </MapViewport>
      )}
    </section>
  );
}

/**
 * Zoom (rueda y botones), pan (arrastrar el fondo) y «ajustar»: la lógica es la del canvas de
 * diseño (`viewportReducer`). Se encuadra solo al abrir y cuando cambia el tamaño del plan.
 */
function MapViewport({ width, height, resetKey, children }: {
  width: number;
  height: number;
  resetKey: number;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [vp, dispatch] = useReducer(viewportReducer, INITIAL_VIEWPORT);
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const fit = () => {
    const el = surface.current;
    if (el) dispatch({ type: "set", viewport: fitMap(width, height, el.clientWidth, el.clientHeight) });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fit, [width, height, resetKey]);

  // La rueda no puede ser pasiva (preventDefault): evita que la página de al lado se desplace.
  useEffect(() => {
    const el = surface.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      dispatch({ type: "zoomBy", factor: e.deltaY < 0 ? 1.1 : 1 / 1.1, cx: e.clientX - r.left, cy: e.clientY - r.top });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const centerZoom = (factor: number) => {
    const el = surface.current;
    if (el) dispatch({ type: "zoomBy", factor, cx: el.clientWidth / 2, cy: el.clientHeight / 2 });
  };
  const btn = "cc-t w-7 h-7 flex items-center justify-center text-[13px] text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white";

  return (
    <div
      ref={surface}
      data-testid="mission-map-surface"
      className="relative h-72 overflow-hidden rounded-lg border border-gray-200 dark:border-white/8 bg-gray-50/60 dark:bg-black/15 cursor-grab active:cursor-grabbing select-none touch-none"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        drag.current = { x: e.clientX, y: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        dispatch({ type: "pan", dx: e.clientX - drag.current.x, dy: e.clientY - drag.current.y });
        drag.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
    >
      <div className="absolute left-0 top-0 origin-top-left" style={{ width, height, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` }}>
        {children}
      </div>
      <div className="absolute right-2 bottom-2 flex items-center rounded-full border shadow bg-white/95 dark:bg-gray-900/95 border-gray-200 dark:border-white/10">
        <button type="button" className={btn} onClick={() => centerZoom(1 / 1.2)} aria-label={t("missions.map.zoomOut")}>−</button>
        <button type="button" className={`${btn} w-12 text-[11px] font-semibold tabular-nums`} onClick={fit} title={t("missions.map.fit")}>{zoomPercent(vp)}</button>
        <button type="button" className={btn} onClick={() => centerZoom(1.2)} aria-label={t("missions.map.zoomIn")}>+</button>
      </div>
    </div>
  );
}

function Node({ task, x, y, activity, account }: {
  task: Task;
  x: number;
  y: number;
  activity?: TaskActivity;
  account: string;
}) {
  const { t } = useTranslation();
  const live = task.status === "running" && activity && activity.kind !== "finished" ? activity.label : null;
  const agent = task.model ? `${task.agentId} · ${task.model}` : task.agentId;
  const role = task.role === "lead" ? t("missions.map.lead") : task.functionalRole ?? task.planKey ?? "";
  return (
    <div
      className={`absolute flex flex-col gap-0.5 px-2.5 py-1.5 rounded-lg border-2 bg-white dark:bg-gray-900 shadow-sm ${STATUS_COLOR[task.status]}`}
      style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
      title={[task.title, task.error].filter(Boolean).join("\n")}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[task.status]}`} />
        <span className="truncate text-[11.5px] font-semibold text-gray-800 dark:text-gray-100">{task.planKey ?? task.title}</span>
        {task.handoff && <span className="shrink-0 text-[10px] text-violet-500" title={t("missions.map.rerouted")}>↻</span>}
      </div>
      <span className="truncate text-[10px] text-gray-500 dark:text-white/45">{[role, agent].filter(Boolean).join(" · ")}</span>
      <span className="truncate text-[10px] text-gray-400 dark:text-white/35">
        {live ? <span className="text-emerald-600 dark:text-emerald-400">{live}</span> : account}
      </span>
    </div>
  );
}
