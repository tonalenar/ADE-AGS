import { useEffect, useReducer } from "react";

import { revealAdvance, revealCut, revealDone, revealStart, revealTarget, type Reveal } from "./streaming";

/**
 * Quanto de cada fala já apareceu, por id do item. Fica fora do componente: o rascunho e o item
 * final têm o mesmo id, mas são desenhados em lugares diferentes do turno (no corpo enquanto o
 * turno está aberto, fora do fold depois), e trocar de lugar não pode recomeçar do zero.
 */
const progress = new Map<string, Reveal>();
const streamed = new Set<string>();
const KEEP = 400;

function remember(id: string, r: Reveal): void {
  progress.delete(id);
  progress.set(id, r);
  if (progress.size > KEEP) {
    const oldest = progress.keys().next().value;
    if (oldest !== undefined) progress.delete(oldest);
  }
}

function rememberStreamed(id: string): void {
  streamed.delete(id);
  streamed.add(id);
  if (streamed.size > KEEP) {
    const oldest = streamed.values().next().value;
    if (oldest !== undefined) streamed.delete(oldest);
  }
}

/** Com movimento reduzido, o texto aparece inteiro e o cursor não pisca. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Um redesenho a cada ~30 ms basta para o olho e poupa o markdown de reprocessar a cada quadro. */
const MIN_FRAME_MS = 32;

/**
 * O texto de uma fala do agente como deve aparecer agora. Com `animate`, o texto novo aparece
 * palavra a palavra (ver `streaming.ts`); sem, inteiro, a menos que a fala já estivesse aparecendo
 * (o rascunho virou o item final). `revealing` diz se ainda falta texto.
 */
export function useRevealedText(id: string, text: string, animate: boolean, live = false): { text: string; revealing: boolean } {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const reduced = prefersReducedMotion();

  if (live) {
    // Os deltas já chegam no ritmo do provedor; não os põe numa segunda fila de texto.
    progress.delete(id);
    rememberStreamed(id);
  }
  const arrivedAsStream = live || streamed.has(id);
  let r = reduced || arrivedAsStream ? undefined : progress.get(id);
  if (!reduced && !arrivedAsStream && !r && animate) {
    r = revealStart(text.length);
    remember(id, r);
  } else if (r && r.target !== text.length) {
    r = revealTarget(r, text.length);
    remember(id, r);
  }
  const revealing = !arrivedAsStream && !!r && !revealDone(r);

  useEffect(() => {
    if (!revealing) return;
    let frame = 0;
    let last: number | null = null;
    let drawn = 0;
    const step = (now: number) => {
      const current = progress.get(id);
      if (!current) return;
      const next = last === null ? current : revealAdvance(current, now - last);
      last = now;
      remember(id, next);
      const done = revealDone(next);
      if (done || now - drawn >= MIN_FRAME_MS) {
        drawn = now;
        redraw();
      }
      if (!done) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [id, revealing, text.length]);

  if (arrivedAsStream || !r) return { text, revealing: false };
  return { text: text.slice(0, revealCut(text, r.shown)), revealing };
}
