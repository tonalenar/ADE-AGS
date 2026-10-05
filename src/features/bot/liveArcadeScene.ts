import type { ArcadeScene, ArcadeStageId } from "./liveArcadeModel";

/** Geometria e movimento da cena. Tudo puro: o canvas só desenha o que sai daqui. */
export const ARCADE_W = 960;
export const ARCADE_H = 480;
export const BEAM_LEFT = 158;
export const BEAM_RIGHT = 808;
/** Nível 0 = chão (equipe, sem andar conhecido); 1..5 = andares da etapa. */
export const LEVEL_BASE_Y = [452, 370, 305, 240, 175, 110];
const TILT = 8;
const LEVEL_OF_STAGE: Record<ArcadeStageId, number> = { opening: 1, work: 2, tests: 3, review: 4, delivery: 5 };
export const levelOfStage = (stage: ArcadeStageId | null): number => (stage ? LEVEL_OF_STAGE[stage] : 0);
/** Quadros por segundo do canvas: ~12 fps. */
/** Onde o herói deixa o bloco: ao pé da torre, no chão. */
export const TOWER_DROP_X = 826;
export const TOWER_LEFT = 850;
export const TOWER_WIDTH = 64;
export const FRAME_MS = 1000 / 12;

function floorY(level: number, x: number): number {
  const tilt = level === 0 ? 0 : level % 2 === 0 ? -TILT : TILT;
  return LEVEL_BASE_Y[level] + tilt * ((x - BEAM_LEFT) / (BEAM_RIGHT - BEAM_LEFT) - 0.5);
}
/** Altura da viga (inclinada, como no Donkey Kong) em x; nível fracionário = no meio da escada. */
export function beamY(level: number, x: number): number {
  const lo = Math.floor(level);
  const hi = Math.min(LEVEL_BASE_Y.length - 1, lo + 1);
  const frac = level - lo;
  return floorY(lo, x) + (floorY(hi, x) - floorY(lo, x)) * frac;
}
/** A escada entre `lower` e `lower + 1` alterna de lado a cada andar. */
export function ladderX(lower: number): number {
  return lower % 2 === 0 ? 740 : 230;
}

export interface Motion { x: number; level: number }
const EPS = 0.001;
const approach = (value: number, to: number, step: number): number =>
  Math.abs(to - value) <= step ? to : value + Math.sign(to - value) * step;

/** Um passo de `dtMs`: anda até a escada, sobe/desce um andar por vez e anda até o destino. */
export function stepMotion(m: Motion, target: Motion, dtMs: number, speed: number, climb = 1.1): Motion {
  const sec = Math.max(0, dtMs) / 1000;
  const onFloor = Math.abs(m.level - Math.round(m.level)) < EPS;
  const level = onFloor ? Math.round(m.level) : m.level;
  if (onFloor && level === target.level) return { x: approach(m.x, target.x, speed * sec), level };
  const up = target.level > level;
  const next = up ? Math.floor(level + EPS) + 1 : Math.ceil(level - EPS) - 1;
  const lx = ladderX(up ? Math.floor(level + EPS) : next);
  if (onFloor && Math.abs(m.x - lx) > 0.5) return { x: approach(m.x, lx, speed * sec), level };
  return { x: lx, level: approach(level, next, climb * sec) };
}

export interface SceneSlot { x: number; level: number }

const BARREL_SPEED = 42;
/** O barril rola ladeira abaixo: nas vigas pares a esquerda é a parte baixa, nas ímpares a direita. */
export const rollDir = (level: number): 1 | -1 => (level % 2 === 0 ? -1 : 1);
export interface PlacedBarrel<B> { barrel: B; x: number; level: number }
/** Posição de cada barril: rolando pela viga do andar (e recomeçando na ponta alta) ou, sem animação, parado na tarefa que trava. */
export function placeBarrels<B extends { stage: ArcadeStageId; taskId?: string }>(
  barrels: B[], slots: Map<string, SceneSlot>, nowMs: number, animated: boolean,
): Array<PlacedBarrel<B>> {
  const span = BEAM_RIGHT - BEAM_LEFT - 24;
  const perStage = new Map<string, number>();
  return barrels.map((barrel, index) => {
    const level = levelOfStage(barrel.stage);
    const n = perStage.get(barrel.stage) ?? 0;
    perStage.set(barrel.stage, n + 1);
    if (!animated) return { barrel, level, x: (barrel.taskId ? slots.get(barrel.taskId)?.x : undefined) ?? 760 - n * 26 };
    const dir = rollDir(level);
    const phase = (((index * 97) % span) + (nowMs / 1000) * BARREL_SPEED) % span;
    return { barrel, level, x: (dir > 0 ? BEAM_LEFT + 12 : BEAM_RIGHT - 12) + dir * phase };
  });
}
/** O herói pula quando um barril passa na mesma viga. */
export function heroLift(level: number, x: number, barrels: Array<{ x: number; level: number }>): number {
  if (Math.abs(level - Math.round(level)) > 0.001) return 0;
  return barrels.reduce((best, b) => (b.level === Math.round(level) ? Math.max(best, jumpLift(x - b.x)) : best), 0);
}
/** Onde fica cada tarefa na viga do seu andar (mesma regra dos nós desenhados). */
export function taskSlots(scene: ArcadeScene): Map<string, SceneSlot> {
  const out = new Map<string, SceneSlot>();
  for (const stage of ["work", "tests", "review"] as const) {
    const tasks = scene.tasks.filter((task) => task.stage === stage);
    const slot = 600 / Math.max(1, tasks.length);
    tasks.forEach((task, index) => out.set(task.id, { x: 190 + slot * (index + 0.5), level: LEVEL_OF_STAGE[stage] }));
  }
  return out;
}

/** Destino de cada herói: a tarefa ligada, com leve afastamento se vários dividem a tarefa; sem tarefa, o chão. */
export function heroTargets(
  heroes: Array<{ tabId: string; taskId: string | null; stage?: ArcadeStageId | null }>,
  slots: Map<string, SceneSlot>,
): Map<string, SceneSlot> {
  const out = new Map<string, SceneSlot>();
  const crowd = new Map<string, number>();
  let ground = 0;
  const perStage = new Map<ArcadeStageId, number>();
  for (const hero of heroes) {
    const slot = hero.taskId ? slots.get(hero.taskId) : undefined;
    // Sem tarefa mas com andar (derivado dos sinais do terminal): fica na viga desse andar.
    if (!slot && hero.stage) {
      const n = perStage.get(hero.stage) ?? 0;
      perStage.set(hero.stage, n + 1);
      out.set(hero.tabId, { x: Math.min(BEAM_RIGHT - 24, 200 + n * 46), level: LEVEL_OF_STAGE[hero.stage] });
      continue;
    }
    if (!hero.taskId || !slot) {
      out.set(hero.tabId, { x: 190 + ground * 46, level: 0 });
      ground += 1;
      continue;
    }
    const n = crowd.get(hero.taskId) ?? 0;
    crowd.set(hero.taskId, n + 1);
    out.set(hero.tabId, { x: Math.min(BEAM_RIGHT - 24, slot.x + (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 18), level: slot.level });
  }
  return out;
}

/** Quem corre (saída sustentada) vai e vem perto do destino; só depende do relógio, nunca inventa deslocamento. */
export function patrolOffset(nowMs: number, seed: number): number {
  return Math.round(Math.sin(nowMs / 450 + seed) * 16);
}
/** Salto sobre um barril que passa: sobe em parábola dentro de 18 px de distância. */
export function jumpLift(dx: number): number {
  const d = Math.abs(dx);
  return d >= 18 ? 0 : Math.round(12 * (1 - (d / 18) ** 2));
}
