/**
 * O mascote do ADE AGS: um robozinho em pixel art que flutua.
 *
 * O sprite é uma grade 16×16 escrita como texto, uma letra por pixel. Cada letra é um
 * papel (corpo, visor, olho…), não uma cor: as cores saem de variáveis CSS definidas em
 * App.css (`--mascot-*`), que trocam entre tema claro e escuro. Assim o mesmo desenho
 * serve para os dois temas e para o ícone do app (que fixa as cores no SVG de origem).
 *
 * A cabeça tem a silhueta de sempre (arredondada, com antena). Embaixo, quatro perninhas à la
 * Clawd com um vão no meio, coladas no corpo, e dois bracinhos curtos que só aparecem durante
 * uma animação (ver `MascotLimbs` e App.css). Os olhos
 * ficam à parte (ver `eyeShapes`), para piscar e para trocar de forma: o visor tem um fundo
 * escuro sob eles, então o bloco quadrado e o chevron `> <` (do Clawd) leem igual.
 *
 * `.` vazio · `g` brilho da antena · `b` corpo · `s` sombra do corpo · `v` visor.
 */
const SPRITE = [
  "................",
  ".......gg.......",
  ".......bb.......",
  "...bbbbbbbbbb...",
  "..bbbbbbbbbbbb..",
  "..bbvvvvvvvvbb..",
  ".bbvvvvvvvvvvbb.",
  ".bbvvvvvvvvvvbb.",
  "..bbvvvvvvvvbb..",
  "..bbbbbbbbbbbb..",
  "...ssssssssss...",
];

const FILL: Record<string, string> = {
  g: "var(--mascot-glow)",
  b: "var(--mascot-body)",
  s: "var(--mascot-shade)",
  v: "var(--mascot-visor)",
};

type Run = { x: number; y: number; w: number; c: string };

/** Junta pixels vizinhos da mesma letra numa linha só: 13 linhas viram ~40 retângulos
 *  em vez de ~150, e sem costura entre eles no zoom. */
function runs(rows: string[]): Run[] {
  const out: Run[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      let w = 1;
      while (row[x + w] === c) w++;
      if (c !== ".") out.push({ x, y, w, c });
      x += w;
    }
  });
  return out;
}

const BODY = runs(SPRITE);
/** Para quem desenha o mascote com outras camadas (o pet que evolui, ver `Pet.tsx`). */
export const MASCOT_BODY = BODY;
export const MASCOT_FILL = FILL;
/** A cabeça sozinha (linhas 1–10), para o logo. */
const HEAD = runs(SPRITE.slice(0, 11));

/** Perninhas (colunas do canto esquerdo de cada uma) e bracinhos, em unidades do sprite. As pernas
 *  nascem dentro da faixa de sombra do corpo (y 10.8, o corpo termina em 11), por isso não se
 *  descolam; os bracinhos são curtos (1×2) e encostam na lateral da cabeça. */
export const MASCOT_LEGS = { xs: [4, 6, 9, 11], top: 10.8, height: 2.2 } as const;
export const MASCOT_ARMS = { xs: [1, 14], top: 8, height: 2 } as const;

/** As quatro pernas e os dois bracinhos. Ficam atrás do corpo e dentro do grupo que flutua. Cada
 *  perna/bracinho é um grupo próprio com `transform-box: fill-box`, para girar/encolher a partir
 *  do quadril/ombro (a animação mora em App.css: ocioso parado, trabalhando digita, esperando
 *  levanta o braço e bate o pé). Os bracinhos ficam invisíveis até haver uma animação. */
export function MascotLimbs() {
  return (
    <>
      {MASCOT_LEGS.xs.map((x, i) => (
        <g key={x} className={`ags-leg ags-leg--${i}`}>
          <rect x={x} y={MASCOT_LEGS.top} width={1} height={MASCOT_LEGS.height} fill="var(--mascot-limb)" />
          <rect x={x} y={MASCOT_LEGS.top + MASCOT_LEGS.height - 0.5} width={1} height={0.5} fill="var(--mascot-limb-tip)" />
        </g>
      ))}
      {MASCOT_ARMS.xs.map((x, i) => (
        <g key={x} className={`ags-arm ags-arm--${i === 0 ? "l" : "r"}`}>
          <rect x={x} y={MASCOT_ARMS.top} width={1} height={1} fill="var(--mascot-limb)" />
          <rect x={x} y={MASCOT_ARMS.top + 1} width={1} height={1} fill="var(--mascot-limb-tip)" />
        </g>
      ))}
    </>
  );
}

/** Os olhos: blocos quadrados no dia a dia, chevron `> <` quando o pet está sério (fase 2+),
 *  um traço quando dorme (`closed`) e um X quando algo falhou. */
export type EyeKind = "block" | "chevron" | "closed" | "x";
export type EyeRect = { x: number; y: number; w: number; h: number };

const EYES: Record<EyeKind, EyeRect[]> = {
  block: [{ x: 5, y: 6, w: 2, h: 2 }, { x: 9, y: 6, w: 2, h: 2 }],
  chevron: [
    { x: 4, y: 5, w: 1, h: 1 }, { x: 5, y: 6, w: 2, h: 1 }, { x: 4, y: 7, w: 1, h: 1 },
    { x: 11, y: 5, w: 1, h: 1 }, { x: 9, y: 6, w: 2, h: 1 }, { x: 11, y: 7, w: 1, h: 1 },
  ],
  closed: [{ x: 5, y: 7, w: 2, h: 1 }, { x: 9, y: 7, w: 2, h: 1 }],
  x: [
    { x: 4, y: 5, w: 1, h: 1 }, { x: 6, y: 5, w: 1, h: 1 }, { x: 5, y: 6, w: 1, h: 1 }, { x: 4, y: 7, w: 1, h: 1 }, { x: 6, y: 7, w: 1, h: 1 },
    { x: 9, y: 5, w: 1, h: 1 }, { x: 11, y: 5, w: 1, h: 1 }, { x: 10, y: 6, w: 1, h: 1 }, { x: 9, y: 7, w: 1, h: 1 }, { x: 11, y: 7, w: 1, h: 1 },
  ],
};

/** Os retângulos dos olhos de cada forma. Puro, para testar sem DOM. */
export function eyeShapes(kind: EyeKind): EyeRect[] {
  return EYES[kind];
}

/** A forma dos olhos para a etapa do pet: do 2 em diante ele "fecha a cara" em chevron. */
export function eyeKindFor(stage: number): EyeKind {
  return stage >= 2 ? "chevron" : "block";
}

/** Os olhos de cada humor: dormindo fecha, falhou faz X, o resto segue a etapa do pet. */
export function eyeKindForState(state: MascotState, stage = 1): EyeKind {
  if (state === "sleeping") return "closed";
  if (state === "failed") return "x";
  return eyeKindFor(stage);
}

/** Os olhos desenhados; o grupo próprio é o que pisca (escala no eixo Y). */
export function MascotEyes({ kind = "block", fill = "var(--mascot-glow)", className }: { kind?: EyeKind; fill?: string; className?: string }) {
  return (
    <g className={className} fill={fill}>
      {EYES[kind].map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} />
      ))}
    </g>
  );
}

/**
 * O humor do mascote. `waiting`: um agente pediu permissão e está parado esperando você.
 * `sleeping`: nada acontece há um bom tempo. `failed`: algo falhou há pouco e nada mais
 * está rodando.
 */
export type MascotState = "idle" | "working" | "waiting" | "sleeping" | "failed";

/** Sem atividade por tanto tempo, o bot dorme. */
export const SLEEP_AFTER_MS = 10 * 60_000;
/** Uma falha recente mantém o bot "falhou" por esta janela, ou até algo voltar a rodar. */
export const FAILED_WINDOW_MS = 5 * 60_000;

/** Sinais de tempo que refinam o repouso: quanto faz que nada acontece e se algo falhou há pouco. */
export interface MascotSignals {
  idleMs?: number;
  recentFailure?: boolean;
}

/** O estado que corresponde a um resumo da frota. Puro, para testar sem store. Quem pede ação
 *  ou trabalha vence; só no repouso entram a falha recente e o sono. */
export function mascotStateFor(summary: { running: number; needsYou: number }, signals: MascotSignals = {}): MascotState {
  if (summary.needsYou > 0) return "waiting";
  if (summary.running > 0) return "working";
  if (signals.recentFailure) return "failed";
  if ((signals.idleMs ?? 0) >= SLEEP_AFTER_MS) return "sleeping";
  return "idle";
}

interface MascotProps {
  size?: number;
  state?: MascotState;
  /** Sem animação: listas, ícones, qualquer lugar onde o movimento distrai. */
  still?: boolean;
  className?: string;
  title?: string;
}

/** O mascote inteiro, com pernas, bracinhos e sombra. */
export function Mascot({ size = 64, state = "idle", still = false, className = "", title }: MascotProps) {
  const anim = still ? "" : `ags-mascot ags-mascot--${state}`;
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={`${anim} ${className}`}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <ellipse className="ags-mascot__shadow" cx="8" cy="14.6" rx="3.6" ry="0.55" fill="var(--mascot-shadow)" />
      <g className="ags-mascot__bot">
        <MascotLimbs />
        {BODY.map((r, i) => (
          <rect
            key={i}
            x={r.x}
            y={r.y}
            width={r.w}
            height={1}
            fill={FILL[r.c]}
          />
        ))}
        {/* Os olhos à parte: piscam escalando no eixo Y, e precisam ser um grupo só. */}
        <g className="ags-mascot__look">
          <MascotEyes kind={eyeKindForState(state)} className="ags-mascot__eyes" />
        </g>
      </g>
    </svg>
  );
}

/** Só a cabeça, sem animação: a marca ao lado do nome. */
export function MascotMark({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 1 16 10"
      width={size * 1.6}
      height={size}
      shapeRendering="crispEdges"
      className={className}
      aria-hidden
    >
      {HEAD.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={FILL[r.c]} />
      ))}
      <MascotEyes />
    </svg>
  );
}
