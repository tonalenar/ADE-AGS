import { create } from "zustand";

import { simulatorSettings } from "./ipc";

/** Minutos fora de vista até hibernar o aparelho (0 = nunca). */
export const HIBERNATE_OPTIONS = [0, 5, 10, 30] as const;

/** Preferências do simulador nesta máquina (localStorage, chave `cc-simulator`), espelhadas no backend
 *  (`simulator::lifecycle`), que é quem hiberna e acerta a prioridade. */
export interface SimulatorPrefsData {
  /** Modo leve: o iOS com prioridade baixa no pico do boot e fora de vista. */
  light: boolean;
  /** Modo máximo (opcional): além do modo leve, desliga push, compras/StoreKit e universal links no próximo boot. */
  lightMax: boolean;
  hibernateMin: number;
  /** Um aparelho ligado por vez: ligar outro hiberna o anterior. */
  single: boolean;
}

interface SimulatorPrefs extends SimulatorPrefsData {
  set: (patch: Partial<SimulatorPrefsData>) => void;
}

const KEY = "cc-simulator";

/** Lê e normaliza o JSON salvo em `localStorage`, tolerando campos ausentes ou inválidos. */
export function parseSimulatorPrefs(rawJson: string | null): SimulatorPrefsData {
  try {
    const raw = JSON.parse(rawJson ?? "{}") as Record<string, unknown>;
    const min = Number(raw.hibernateMin);
    return {
      light: raw.light !== false,
      lightMax: raw.lightMax === true,
      hibernateMin: (HIBERNATE_OPTIONS as readonly number[]).includes(min) ? min : 10,
      single: raw.single !== false,
    };
  } catch {
    return { light: true, lightMax: false, hibernateMin: 10, single: true };
  }
}

function read(): SimulatorPrefsData {
  try {
    return parseSimulatorPrefs(localStorage.getItem(KEY));
  } catch {
    return { light: true, lightMax: false, hibernateMin: 10, single: true };
  }
}

export const useSimulatorPrefs = create<SimulatorPrefs>((set, get) => ({
  ...read(),
  set: (patch) => {
    set(patch);
    const { light, lightMax, hibernateMin, single } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ light, lightMax, hibernateMin, single }));
    } catch {
      // Sem localStorage (janela privada): vale só nesta sessão.
    }
    syncSimulatorPrefs();
  },
}));

/** Manda as preferências ao backend (na abertura do primeiro simulador e a cada mudança). */
export function syncSimulatorPrefs() {
  const { light, lightMax, hibernateMin, single } = useSimulatorPrefs.getState();
  simulatorSettings(hibernateMin, single, light, lightMax).catch(() => undefined);
}
