import { useEffect, useRef, useState } from "react";

/**
 * O level-up "Arcade" (prancheta "Level-up", proposta C do Canvas de Design): o bot se agacha
 * (anticipation), a barra de EXP enche e pisca, um flash em degraus, confete pixel e o número
 * do LV gira como num slot. Aqui ficam as partes puras (testáveis sem DOM) e o gancho que
 * dispara o efeito, compartilhado pelo Pet, pelo número do LV e pelas barras.
 */

/** Quanto dura o efeito inteiro, do agachar ao último confete. */
export const LEVEL_UP_MS = 1500;

/** As cores do confete: amarelo, laranja e ciano, a paleta do QG. */
export const CONFETTI_COLORS = ["#ffd24a", "#ff8a3d", "#3dd6e8"] as const;

/** Só conta como subir de nível quando o LV sobe exatamente um: o salto de 1 para o nível real
 *  na primeira leitura do pet (ao abrir o app) não é uma subida e não deve comemorar. */
export function isLevelUp(previous: number, next: number): boolean {
  return next === previous + 1;
}

export interface Confetti {
  /** Deslocamento final, em unidades do sprite (viewBox do Pet). */
  dx: number;
  dy: number;
  color: string;
  delay: number;
}

/** O confete `i` de `count`, repartido em círculo sem azar: o efeito sai igual a cada render. */
export function confettiAt(i: number, count = 14): Confetti {
  const angle = (i / count) * Math.PI * 2;
  const reach = 8 + (i % 3) * 1.5;
  return {
    dx: Math.round(Math.cos(angle) * reach * 10) / 10,
    dy: Math.round((Math.sin(angle) * reach - 3) * 10) / 10,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    delay: (i % 4) * 0.03,
  };
}

export interface LevelUpState {
  /** Há um efeito em curso. */
  active: boolean;
  /** Muda a cada subida, para reiniciar a animação mesmo com subidas seguidas. */
  key: number;
  /** O nível de que se veio (o número que sai do slot). */
  from: number;
}

const IDLE: LevelUpState = { active: false, key: 0, from: 0 };

/** Dispara o efeito quando o nível sobe enquanto o componente está à vista. Um único timer, só
 *  durante o efeito: nada de intervalo por instância. */
export function useLevelUp(level: number): LevelUpState {
  const previous = useRef(level);
  const [state, setState] = useState<LevelUpState>(IDLE);
  useEffect(() => {
    const before = previous.current;
    previous.current = level;
    if (!isLevelUp(before, level)) return;
    setState((s) => ({ active: true, key: s.key + 1, from: before }));
    const timer = window.setTimeout(() => setState((s) => ({ ...s, active: false })), LEVEL_UP_MS);
    return () => window.clearTimeout(timer);
  }, [level]);
  return state;
}
