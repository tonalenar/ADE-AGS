import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type ConnectionLineComponentProps, type EdgeProps } from "@xyflow/react";
import { Button, CloseIcon } from "neogestify-ui-components";

import { canvasActions, useActiveBoardKey } from "./store";

/**
 * As cordas do canvas: o fio entre dois terminais, no estilo de um editor de nós.
 *
 * - Cada corda tem uma cor estável (derivada do id), grossa o suficiente para ler e com um halo
 *   da própria cor.
 * - Arrastando uma corda nova (ou a ponta de uma existente), ela é BRANCA. Perto de uma alça
 *   (`CORD_MAGNET`, que vira o `connectionRadius` do React Flow) aparece um RAIO em zigue-zague
 *   entre a ponta e a alça: é o ímã. Bem perto (`CORD_SNAP`) a ponta gruda na alça.
 * - Puxando a ponta de uma corda conectada, o raio continua preso à alça de origem até sair do
 *   alcance — aí ele ARREBENTA com faíscas. Soltar no vazio desconecta.
 */

/** Distância (px do canvas) em que o ímã pega uma alça: também o raio de conexão do React Flow. */
export const CORD_MAGNET = 110;
/** Mais perto que isto a ponta da corda gruda na alça. */
export const CORD_SNAP = 34;

export const CORD_COLORS = ["#ffd60a", "#ff375f", "#30d158", "#ff9f0a", "#bf5af2", "#64d2ff"] as const;

/** A cor de uma corda: estável pelo id, para não trocar de cor a cada render. */
export function cordColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CORD_COLORS[h % CORD_COLORS.length];
}

/**
 * Os pontos de um raio entre `a` e `b`: uma polilinha com desvios perpendiculares que somem nas
 * pontas. `strength` (0..1) aumenta a amplitude; `rand` é injetável para testar.
 */
export function lightningPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
  strength: number,
  rand: () => number = Math.random,
): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const n = Math.max(5, Math.round(len / 9));
  const nx = -dy / len;
  const ny = dx / len;
  const amp = 6 + 12 * Math.min(1, Math.max(0, strength));
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const off = i === 0 || i === n ? 0 : (rand() - 0.5) * amp * Math.sin(Math.PI * f);
    pts.push(`${(a.x + dx * f + nx * off).toFixed(1)},${(a.y + dy * f + ny * off).toFixed(1)}`);
  }
  return pts.join(" ");
}

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Re-renderiza a cada quadro enquanto `on`: o raio treme mesmo com o mouse parado. */
function useFrameTick(on: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!on || reducedMotion()) return;
    let raf = 0;
    const loop = () => { setTick((t) => (t + 1) % 1_000_000); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [on]);
  return tick;
}

/** Acende a borda de um nó com a cor da corda (ao conectar ou ao chegar uma mensagem). */
export function flashNode(nodeId: string, color: string) {
  if (typeof document === "undefined") return;
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
  if (!el) return;
  el.style.setProperty("--cord-color", color);
  el.classList.remove("ade-cord-flash");
  void el.offsetWidth; // reinicia a animação
  el.classList.add("ade-cord-flash");
  window.setTimeout(() => el.classList.remove("ade-cord-flash"), 1200);
}

interface Spark { x: number; y: number; dx: number; dy: number; t0: number }

/** A corda sendo arrastada (nova ou reconectando): branca, com o raio do ímã. */
export function CordConnectionLine({ fromX, fromY, toX, toY, toHandle, pointer, fromPosition, toPosition }: ConnectionLineComponentProps) {
  const near = !!toHandle;
  const dist = near ? Math.hypot(toX - pointer.x, toY - pointer.y) : Infinity;
  const snapped = near && dist < CORD_SNAP;
  // Sem alça perto, a ponta segue o cursor; perto, segue o cursor até grudar.
  const end = snapped ? { x: toX, y: toY } : pointer;
  const [path] = getBezierPath({ sourceX: fromX, sourceY: fromY, targetX: end.x, targetY: end.y, sourcePosition: fromPosition, targetPosition: toPosition });

  // Quando o ímã solta (saiu do alcance), o raio arrebenta: faíscas na última alça.
  const last = useRef<{ x: number; y: number } | null>(null);
  const [sparks, setSparks] = useState<Spark[]>([]);
  useEffect(() => {
    if (near) { last.current = { x: toX, y: toY }; return; }
    const at = last.current;
    last.current = null;
    if (!at || reducedMotion()) return;
    const now = performance.now();
    setSparks(Array.from({ length: 9 }, () => {
      const ang = Math.random() * Math.PI * 2;
      const r = 10 + Math.random() * 22;
      return { x: at.x, y: at.y, dx: Math.cos(ang) * r, dy: Math.sin(ang) * r, t0: now };
    }));
  }, [near, toX, toY]);
  const tick = useFrameTick(near || sparks.length > 0);
  useEffect(() => {
    if (sparks.length && performance.now() - sparks[0].t0 > 340) setSparks([]);
  }, [tick, sparks]);

  const strength = near ? Math.max(0, 1 - dist / CORD_MAGNET) : 0;
  const color = toHandle ? "var(--cord-magnet, #64d2ff)" : "#ffffff";
  const now = performance.now();
  return (
    <g className="ade-cord-drag" data-tick={tick}>
      <path d={path} fill="none" stroke={near ? color : "#ffffff"} strokeWidth={7} strokeOpacity={0.12 + strength * 0.3} className="ade-cord-glow" />
      <path d={path} fill="none" stroke="#ffffff" strokeWidth={3} strokeLinecap="round" />
      {near && !snapped && (
        <>
          <polyline points={lightningPoints(pointer, { x: toX, y: toY }, 0.35 + strength * 0.65)} fill="none"
            stroke={color} strokeWidth={5} strokeOpacity={0.25 + 0.4 * strength} className="ade-cord-glow" />
          <polyline points={lightningPoints(pointer, { x: toX, y: toY }, 0.35 + strength * 0.65)} fill="none"
            stroke={color} strokeWidth={1.2 + strength} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={pointer.x} cy={pointer.y} r={2.6} fill={color} />
        </>
      )}
      {near && <circle cx={toX} cy={toY} r={9} fill="none" stroke={color} strokeWidth={2} strokeOpacity={0.9} />}
      {sparks.map((s, i) => {
        const t = Math.min(1, (now - s.t0) / 320);
        return <line key={i} x1={s.x + s.dx * t * 0.4} y1={s.y + s.dy * t * 0.4} x2={s.x + s.dx * t} y2={s.y + s.dy * t}
          stroke="#64d2ff" strokeWidth={1.6} strokeLinecap="round" strokeOpacity={1 - t} />;
      })}
    </g>
  );
}

/** Uma corda conectada. Selecionada fica azul; com o mouse em cima ou selecionada mostra o ✕. */
export function CordEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }: EdgeProps) {
  const { t } = useTranslation();
  const key = useActiveBoardKey();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const color = (data?.color as string | undefined) ?? cordColor(id);
  const hovered = !!data?.hovered;
  const born = data?.born as number | undefined;
  const fresh = born !== undefined && Date.now() - born < 400;
  const showCut = (selected || hovered) && key;
  return (
    <>
      <path d={path} fill="none" stroke={color} strokeWidth={selected || hovered ? 9 : 7} strokeOpacity={0.3}
        className="ade-cord-glow" pointerEvents="none" />
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={20}
        className={fresh ? "ade-cord-born" : undefined}
        style={{
          stroke: selected ? "var(--color-accent-500)" : color,
          strokeWidth: selected || hovered ? 4 : 3,
          strokeLinecap: "round",
          ["--cord-color" as string]: color,
        }}
      />
      {showCut && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan absolute pointer-events-auto"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            <Button variant="custom"
              onClick={() => canvasActions.disconnect(key, id)}
              aria-label={t("canvas.disconnect")}
              title={t("canvas.disconnect")}
              className="cc-t flex items-center justify-center w-6 h-6 rounded-full
                bg-white dark:bg-surface-raised shadow-[0_0_0_0.5px_rgba(0,0,0,0.12),0_4px_12px_rgba(0,0,0,0.35)]
                dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.12),0_4px_12px_rgba(0,0,0,0.5)]
                text-gray-500 dark:text-gray-300 hover:text-red-500 dark:hover:text-red-400"
            >
              <CloseIcon className="w-3 h-3" />
            </Button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
