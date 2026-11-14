import { useEffect, useState } from "react";

const listeners = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function syncTimer(): void {
  const visible = document.visibilityState === "visible";
  if (!visible && timer !== null) {
    clearInterval(timer);
    timer = null;
  } else if (visible && listeners.size > 0 && timer === null) {
    timer = setInterval(publish, 1000);
  }
}

function publish(): void {
  const now = Date.now() / 1000;
  for (const listener of listeners) listener(now);
}

function subscribe(listener: (now: number) => void): () => void {
  if (listeners.size === 0) document.addEventListener("visibilitychange", syncTimer);
  listeners.add(listener);
  listener(Date.now() / 1000);
  syncTimer();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (listeners.size === 0) document.removeEventListener("visibilitychange", syncTimer);
  };
}

/** O relógio da frota: todas as tarefas vivas compartilham um único intervalo de um segundo. */
export function useFleetClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => active ? subscribe(setNow) : undefined, [active]);
  return now;
}
