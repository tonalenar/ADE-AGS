import { useEffect, useState } from "react";

const listeners = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function publish(): void {
  const now = Date.now() / 1000;
  for (const listener of listeners) listener(now);
}

function subscribe(listener: (now: number) => void): () => void {
  listeners.add(listener);
  listener(Date.now() / 1000);
  if (timer === null) timer = setInterval(publish, 1000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** O relógio da frota: todas as tarefas vivas compartilham um único intervalo de um segundo. */
export function useFleetClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => active ? subscribe(setNow) : undefined, [active]);
  return now;
}
