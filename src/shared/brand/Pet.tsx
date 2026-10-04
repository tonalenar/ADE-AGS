import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

import { formatTokens } from "@/features/accounts/usage";

import { MASCOT_BODY, MASCOT_FILL, type MascotState } from "./Mascot";
import "./pet.css";
import { useMascotState } from "./useMascotState";
import { useAgentActivity } from "@/features/terminal/activity";
import { openBotPanel } from "@/features/bot/botPanelStore";

/** Lo que el backend sabe del pet (ver `pet.rs`). */
export interface PetStatus {
  xp: number;
  level: number;
  intoLevel: number;
  toNext: number;
  progress: number;
}

export const EMPTY_PET: PetStatus = { xp: 0, level: 1, intoLevel: 0, toNext: 0, progress: 0 };

/**
 * La forma del pet según su nivel. Cada etapa suma algo a la anterior:
 *
 * 1. niveles 1–2: el robot de siempre, con una chispa suelta;
 * 2. niveles 3–4: ojos azules, una corona de llamas amarillas y un aura cálida;
 * 3. niveles 5–6: llamas altas y grietas de energía, con aura naranja;
 * 4. niveles 7+: el cuerpo se enciende en rojo, la corona es de espinas azules, lo rodean
 *    rayos y el aura es roja.
 */
export function stageFor(level: number): 1 | 2 | 3 | 4 {
  if (level >= 7) return 4;
  if (level >= 5) return 3;
  if (level >= 3) return 2;
  return 1;
}

/**
 * La fase de poder según cuántos agentes escriben a la vez, como las transformaciones de un
 * super saiyajin: 1–2 = fase 1 (dorado), 3–4 = fase 2 (rayos), 5–6 = fase 3 (llamas altas,
 * aura naranja), 7 o más = fase 4 (azul). Sin nadie trabajando, 0.
 */
export function powerTier(busy: number): 0 | 1 | 2 | 3 | 4 {
  if (busy >= 7) return 4;
  if (busy >= 5) return 3;
  if (busy >= 3) return 2;
  return busy >= 1 ? 1 : 0;
}

/** La etapa mínima que toma el pet en cada fase (si su nivel ya es mayor, manda el nivel). */
const TIER_STAGE: Record<0 | 1 | 2 | 3 | 4, 1 | 2 | 3 | 4> = { 0: 1, 1: 2, 2: 2, 3: 3, 4: 4 };

interface Look {
  aura: string | null;
  eyes: string;
  body?: string;
  shade?: string;
  /** Llama: base del color, punta y brillo. */
  flame: [string, string] | null;
  spark: string;
}

const LOOKS: Record<1 | 2 | 3 | 4, Look> = {
  1: { aura: null, eyes: "var(--mascot-glow)", flame: null, spark: "var(--mascot-glow)" },
  2: { aura: "#facc15", eyes: "#7dd3fc", flame: ["#f59e0b", "#fde047"], spark: "#fde047" },
  3: { aura: "#f97316", eyes: "#7dd3fc", flame: ["#ef4444", "#fb923c"], spark: "#fdba74" },
  4: { aura: "#ef4444", eyes: "#bae6fd", body: "#b91c1c", shade: "#7f1d1d", flame: ["#2563eb", "#7dd3fc"], spark: "#93c5fd" },
};

/** Fase 4: el pet se pone azul, cuerpo incluido. */
const BLUE_LOOK: Look = {
  aura: "#38bdf8", eyes: "#e0f2fe", body: "#1d4ed8", shade: "#1e3a8a",
  flame: ["#2563eb", "#7dd3fc"], spark: "#bae6fd",
};

/** Las llamas de la corona: columna y alto, anclados a la antena (y = 1) y crecen hacia arriba. */
const TONGUES: Record<2 | 3 | 4, Array<{ x: number; h: number }>> = {
  2: [{ x: 6, h: 3 }, { x: 7, h: 4 }, { x: 8, h: 5 }, { x: 9, h: 3 }],
  3: [{ x: 5, h: 3 }, { x: 6, h: 5 }, { x: 7, h: 8 }, { x: 8, h: 7 }, { x: 9, h: 5 }, { x: 10, h: 3 }],
  4: [{ x: 4, h: 4 }, { x: 6, h: 7 }, { x: 7, h: 9 }, { x: 8, h: 9 }, { x: 9, h: 7 }, { x: 11, h: 4 }],
};

/** Cuántas partículas flotan: crecen con el nivel, hasta un tope que no distraiga. */
export function sparkCount(level: number): number {
  return Math.min(10, Math.floor(level / 1.3));
}

/** Posición de la partícula `i`, repartida sin azar (el pet tiene que verse igual en cada render). */
export function sparkAt(i: number): { x: number; y: number; delay: number; duration: number } {
  return {
    x: -3 + ((i * 37) % 22),
    y: 4 + ((i * 53) % 9),
    delay: (i * 0.37) % 2.6,
    duration: 2.2 + (i % 4) * 0.45,
  };
}

/**
 * El pet: el robot del ADE AGS que evoluciona con los tokens que gastan tus agentes.
 * Flota, parpadea, y según su nivel gana aura, llamas, energía y rayos; cuando la frota
 * trabaja, cruza el cuerpo con un trazo veloz; cuando sube de nivel, estalla en un anillo.
 */
export function Pet({ level, state = "idle", size = 96, className = "", still = false }: {
  level: number;
  state?: MascotState;
  size?: number;
  className?: string;
  /** Sin animación (para los lugares chicos donde algo moviéndose todo el tiempo cansa). */
  still?: boolean;
}) {
  const gid = useId().replace(/:/g, "");
  const busy = useAgentActivity((a) => a.count);
  const tier = state === "working" && !still ? powerTier(busy) : 0;
  const stage = tier > 0 ? (Math.max(stageFor(level), TIER_STAGE[tier]) as 1 | 2 | 3 | 4) : stageFor(level);
  const look = tier === 4 ? BLUE_LOOK : LOOKS[stage];

  // El estallido de subir de nivel: solo si el nivel SUBE mientras el pet está a la vista.
  const previous = useRef(level);
  const [burst, setBurst] = useState(0);
  useEffect(() => {
    if (level > previous.current) {
      setBurst((n) => n + 1);
      const timer = window.setTimeout(() => setBurst(0), 1200);
      previous.current = level;
      return () => window.clearTimeout(timer);
    }
    previous.current = level;
  }, [level]);

  const style = {
    ...(look.body ? { "--mascot-body": look.body, "--mascot-shade": look.shade } : null),
  } as React.CSSProperties;
  const tongues = stage >= 2 ? TONGUES[stage as 2 | 3 | 4] : [];
  const sparks = sparkCount(level);

  return (
    <svg
      viewBox="-6 -12 28 30"
      width={size}
      height={(size * 30) / 28}
      shapeRendering="crispEdges"
      style={style}
      className={`ags-pet ags-pet--tier-${tier} ${still ? "ags-pet--still" : `ags-mascot ags-mascot--${state}`} ${burst ? "ags-pet--levelup" : ""} ${className}`}
      aria-hidden
    >
      <defs>
        {look.aura && (
          <radialGradient id={`aura-${gid}`}>
            <stop offset="0%" stopColor={look.aura} stopOpacity="0.55" />
            <stop offset="60%" stopColor={look.aura} stopOpacity="0.18" />
            <stop offset="100%" stopColor={look.aura} stopOpacity="0" />
          </radialGradient>
        )}
        <linearGradient id={`dash-${gid}`} x1="1" x2="0">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {look.aura && <circle className="ags-pet__aura" cx="8" cy="7" r="12" fill={`url(#aura-${gid})`} />}

      {burst > 0 && <circle key={burst} className="ags-pet__burst" cx="8" cy="7" r="7" fill="none" stroke={look.aura ?? "var(--mascot-glow)"} strokeWidth="0.6" />}

      {/* Trabajando: anillos de energía que salen del cuerpo. */}
      {state === "working" && (
        <g fill="none" stroke={look.aura ?? "var(--mascot-glow)"} strokeWidth="0.5">
          <circle className="ags-pet__pulse" cx="8" cy="7" r="6" />
          <circle className="ags-pet__pulse ags-pet__pulse--2" cx="8" cy="7" r="6" />
        </g>
      )}

      {/* Trabajando: tres chispas orbitan el cuerpo y una burbuja de "escribiendo…" late arriba. */}
      {state === "working" && (
        <g>
          <g className="ags-pet__orbit">
            <rect x="7.5" y="-3.2" width="1" height="1" fill={look.spark} />
            <rect x="7.5" y="-3.2" width="1" height="1" fill={look.spark} transform="rotate(120 8 7)" />
            <rect x="7.5" y="-3.2" width="1" height="1" fill={look.spark} transform="rotate(240 8 7)" />
          </g>
          <g className="ags-pet__typing" fill={look.aura ?? "var(--mascot-glow)"}>
            <rect x="13" y="-2" width="1" height="1" />
            <rect x="15" y="-2" width="1" height="1" style={{ animationDelay: "0.2s" }} />
            <rect x="17" y="-2" width="1" height="1" style={{ animationDelay: "0.4s" }} />
          </g>
        </g>
      )}

      <ellipse className="ags-mascot__shadow" cx="8" cy="15.2" rx="3.6" ry="0.55" fill="var(--mascot-shadow)" />

      {Array.from({ length: sparks }, (_, i) => {
        const s = sparkAt(i);
        return (
          <rect key={i} className="ags-pet__spark" x={s.x} y={s.y} width="0.7" height="0.7" fill={look.spark}
            style={{ animationDelay: `${s.delay}s`, animationDuration: `${s.duration}s` }} />
        );
      })}

      <g className="ags-mascot__bot">
        {/* La corona va detrás del cuerpo: nace de la antena. */}
        {look.flame && tongues.map((t, i) => (
          <g key={i}>
            <rect className="ags-pet__tongue" x={t.x} y={1 - t.h} width="1" height={t.h} fill={look.flame![0]}
              style={{ animationDelay: `${(i * 0.13) % 0.9}s` }} />
            <rect className="ags-pet__tongue" x={t.x} y={1 - t.h} width="1" height={Math.max(1, t.h - 2)} fill={look.flame![1]}
              style={{ animationDelay: `${(i * 0.13 + 0.07) % 0.9}s` }} />
          </g>
        ))}

        {MASCOT_BODY.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={MASCOT_FILL[r.c]}
            className={r.c === "f" ? "ags-mascot__flame" : undefined} />
        ))}

        {/* Grietas de energía: del nivel 5 en adelante. */}
        {stage >= 3 && (
          <g fill="none" stroke={stage === 4 ? "#93c5fd" : "#fde047"} strokeWidth="0.45" strokeLinecap="square">
            <path className="ags-pet__crack" d="M4 4 L5 6 L4 7 L5 9" />
            <path className="ags-pet__crack" style={{ animationDelay: "0.6s" }} d="M12 4 L11 6 L12 7 L11 9" />
          </g>
        )}

        <g className="ags-mascot__eyes" fill={look.eyes}>
          <rect x="5" y="6" width="2" height="2" />
          <rect x="9" y="6" width="2" height="2" />
        </g>
        {/* Cejas enojadas desde la etapa 2: el pet "se pone serio". */}
        {stage >= 2 && (
          <g fill="var(--mascot-visor)">
            <rect x="4.5" y="5.2" width="3" height="0.8" transform="rotate(14 6 5.6)" />
            <rect x="8.5" y="5.2" width="3" height="0.8" transform="rotate(-14 10 5.6)" />
          </g>
        )}
      </g>

      {/* Rayos alrededor: solo en la última etapa. */}
      {(stage === 4 || tier >= 2) && (
        <g fill="none" stroke={tier === 4 ? "#7dd3fc" : tier >= 2 && stage < 4 ? "#fde047" : "#e0f2fe"} strokeWidth="0.5" strokeLinejoin="miter">
          <path className="ags-pet__zap" d="M-3 1 L-1 4 L-2 5 L1 9 L0 10" />
          <path className="ags-pet__zap" style={{ animationDelay: "0.9s" }} d="M19 2 L17 5 L18 6 L15 10 L16 11" />
        </g>
      )}

      {/* El trazo veloz del trabajo. */}
      {state === "working" && (
        <g>
          <rect className="ags-pet__dash" x="14" y="7" width="9" height="1.2" fill={`url(#dash-${gid})`} />
          <rect className="ags-pet__dash ags-pet__dash--2" x="15" y="9.4" width="6" height="0.7" fill={`url(#dash-${gid})`} />
          <rect className="ags-pet__dash" style={{ animationDelay: "0.4s" }} x="14" y="4.6" width="7" height="0.7" fill={`url(#dash-${gid})`} />
        </g>
      )}
    </svg>
  );
}

/** El estado del pet: se pide al abrir y se actualiza cuando el backend suma XP. */
export function usePetStatus(): PetStatus {
  const [pet, setPet] = useState<PetStatus>(EMPTY_PET);
  useEffect(() => {
    let alive = true;
    invoke<PetStatus>("pet_status").then((s) => alive && setPet(s)).catch(() => undefined);
    const off = listen<PetStatus>("cc-pet-changed", (e) => setPet(e.payload));
    return () => {
      alive = false;
      off.then((fn) => fn());
    };
  }, []);
  return pet;
}

/** El pet con su nivel y sus tokens, como en el panel lateral de la referencia. */
export function PetCard({ pet, className = "" }: { pet: PetStatus; className?: string }) {
  const { state } = useMascotState();
  const { t } = useTranslation();
  const busy = useAgentActivity((a) => a.count);

  const stage = stageFor(pet.level);
  const accent = LOOKS[stage].aura ?? "var(--mascot-glow)";

  // Un clic abre el QG del bot (ver `features/bot/BotPanel.tsx`): todo lo que "hizo" por vos.
  return (
    <div role="button" tabIndex={0} title={t("botPanel.open")} aria-label={t("botPanel.open")}
      onClick={openBotPanel}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openBotPanel(); } }}
      className={`cursor-pointer flex items-center gap-2 pl-1 pr-3.5 py-1 rounded-2xl border border-gray-200 dark:border-white/10
      bg-white/92 dark:bg-surface-raised/92 shadow-md backdrop-blur hover:border-accent-400/60 transition-colors ${className}`}>
      <Pet level={pet.level} state={state} size={96} />
      <div className="min-w-[88px]">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12px] font-bold tracking-wider" style={{ color: accent }}>LV {pet.level}</span>
          <span className="text-[13px] font-semibold tabular-nums text-gray-800 dark:text-gray-100">{formatTokens(pet.xp)}</span>
        </div>
        <div className="mt-1 h-1 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden"
          role="progressbar" aria-valuenow={Math.round(pet.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full transition-[width] duration-700 ${state === "working" ? "ags-pet__bar--busy" : ""}`} style={{ width: `${Math.round(pet.progress * 100)}%`, background: accent }} />
        </div>
        <div className="mt-0.5 text-[10px] tabular-nums text-gray-400 dark:text-gray-500">
          {state === "working" && busy > 0 ? (
            <span className="ags-pet__busy">{t("pet.working", { n: busy })}</span>
          ) : pet.toNext > 0 ? `-${formatTokens(pet.toNext)} → ${pet.level + 1}` : "MAX"}
        </div>
      </div>
    </div>
  );
}
