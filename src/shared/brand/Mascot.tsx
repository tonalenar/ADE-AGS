/**
 * O mascote do ADE AGS: um robozinho em pixel art que flutua.
 *
 * O sprite é uma grade 16×16 escrita como texto, uma letra por pixel. Cada letra é um
 * papel (corpo, visor, olho…), não uma cor: as cores saem de variáveis CSS definidas em
 * App.css (`--mascot-*`), que trocam entre tema claro e escuro. Assim o mesmo desenho
 * serve para os dois temas e para o ícone do app (que fixa as cores no SVG de origem).
 *
 * `.` vazio · `g` brilho da antena · `e` olho (desenhado à parte, para piscar) · `b` corpo · `s` sombra do corpo · `v` visor ·
 * `f` propulsor.
 */
const SPRITE = [
  "................",
  ".......gg.......",
  ".......bb.......",
  "...bbbbbbbbbb...",
  "..bbbbbbbbbbbb..",
  "..bbvvvvvvvvbb..",
  ".bbvveevveevvbb.",
  ".bbvveevveevvbb.",
  "..bbvvvvvvvvbb..",
  "..bbbbbbbbbbbb..",
  "...ssssssssss...",
  "....ss....ss....",
  "....ff....ff....",
];

const FILL: Record<string, string> = {
  g: "var(--mascot-glow)",
  b: "var(--mascot-body)",
  s: "var(--mascot-shade)",
  v: "var(--mascot-visor)",
  f: "var(--mascot-glow)",
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
      if (c !== "." && c !== "e") out.push({ x, y, w, c });
      x += w;
    }
  });
  return out;
}

const BODY = runs(SPRITE);
/** A cabeça sozinha (linhas 1–10), para o logo. */
const HEAD = runs(SPRITE.slice(0, 11));

/** `waiting`: um agente pediu permissão e está parado esperando você. */
export type MascotState = "idle" | "working" | "waiting";

/** O estado que corresponde a um resumo da frota. Puro, para testar sem store. */
export function mascotStateFor(summary: { running: number; needsYou: number }): MascotState {
  if (summary.needsYou > 0) return "waiting";
  if (summary.running > 0) return "working";
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

/** O mascote inteiro, com propulsores e sombra. */
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
      <ellipse className="ags-mascot__shadow" cx="8" cy="15.2" rx="3.6" ry="0.55" fill="var(--mascot-shadow)" />
      <g className="ags-mascot__bot">
        {BODY.map((r, i) => (
          <rect
            key={i}
            x={r.x}
            y={r.y}
            width={r.w}
            height={1}
            fill={FILL[r.c]}
            className={r.c === "f" ? "ags-mascot__flame" : undefined}
          />
        ))}
        {/* Os olhos à parte: piscam escalando no eixo Y, e precisam ser um grupo só. */}
        <g className="ags-mascot__eyes" fill="var(--mascot-glow)">
          <rect x="5" y="6" width="2" height="2" />
          <rect x="9" y="6" width="2" height="2" />
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
      <g fill="var(--mascot-glow)">
        <rect x="5" y="6" width="2" height="2" />
        <rect x="9" y="6" width="2" height="2" />
      </g>
    </svg>
  );
}
