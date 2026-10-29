import { create } from "zustand";

import { simulatorSettings } from "./ipc";

/** Minutos fora de vista até hibernar o aparelho (0 = nunca). */
export const HIBERNATE_OPTIONS = [0, 5, 10, 30] as const;

/** Preferências do simulador nesta máquina (localStorage, chave `cc-simulator`), espelhadas no backend
 *  (`simulator::lifecycle`), que é quem hiberna e acerta a prioridade. */
interface SimulatorPrefs {
  /** Modo leve: o iOS com prioridade baixa no pico do boot e fora de vista. */
  light: boolean;
  hibernateMin: number;
  /** Um aparelho ligado por vez: ligar outro hiberna o anterior. */
  single: boolean;
  set: (patch: Partial<Pick<SimulatorPrefs, "light" | "hibernateMin" | "single">>) => void;
}

const KEY = "cc-simulator";

function read(): Pick<SimulatorPrefs, "light" | "hibernateMin" | "single"> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    const min = Number(raw.hibernateMin);
    return {
      light: raw.light !== false,
      hibernateMin: (HIBERNATE_OPTIONS as readonly number[]).includes(min) ? min : 10,
      single: raw.single !== false,
    };
  } catch {
    return { light: true, hibernateMin: 10, single: true };
  }
}

export const useSimulatorPrefs = create<SimulatorPrefs>((set, get) => ({
  ...read(),
  set: (patch) => {
    set(patch);
    const { light, hibernateMin, single } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ light, hibernateMin, single }));
    } catch {
      // Sem localStorage (janela privada): vale só nesta sessão.
    }
    syncSimulatorPrefs();
  },
}));

/** Manda as preferências ao backend (na abertura do primeiro simulador e a cada mudança). */
export function syncSimulatorPrefs() {
  const { light, hibernateMin, single } = useSimulatorPrefs.getState();
  simulatorSettings(hibernateMin, single, light).catch(() => undefined);
}
