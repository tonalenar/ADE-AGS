import { useEffect, useState } from "react";

import { simulatorMemory, type SimMemory } from "./ipc";

/** Quanto esperar entre duas leituras da memória do aparelho ligado (o `ps` e o `proc_pid_rusage` custam pouco). */
export const MEMORY_EVERY_MS = 5000;

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Bytes no formato do idioma: GB com uma casa a partir de 1 GB, senão MB inteiros. */
export function formatMemory(bytes: number, locale: string): string {
  const gib = bytes >= GIB;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: gib ? "gigabyte" : "megabyte",
    unitDisplay: "short",
    maximumFractionDigits: gib ? 1 : 0,
  }).format(gib ? bytes / GIB : bytes / MIB);
}

/**
 * A memória do aparelho `udid`, relida a cada `MEMORY_EVERY_MS` só enquanto houver `udid` (o aparelho está ligado)
 * e a aba estiver visível. Uma leitura só começa depois que a anterior termina; ao sair, o relógio para.
 */
export function useSimulatorMemory(udid: string | undefined): SimMemory | null {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [memory, setMemory] = useState<SimMemory | null>(null);

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  useEffect(() => {
    setMemory(null);
    if (!udid || !visible) return;
    let alive = true;
    let timer: number | undefined;
    const read = () => {
      simulatorMemory(udid)
        .then((m) => { if (alive) setMemory(m); })
        .catch(() => { if (alive) setMemory(null); })
        .finally(() => { if (alive) timer = window.setTimeout(read, MEMORY_EVERY_MS); });
    };
    read();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [udid, visible]);

  return memory;
}
