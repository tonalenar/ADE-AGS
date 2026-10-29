import { create } from "zustand";

/** Preferências do simulador nesta máquina (localStorage, chave `cc-simulator`). */
interface SimulatorPrefs {
  /** Modo leve: o aparelho liga sem os serviços pesados do iOS (ver `simulator::model::LIGHT_JOBS`). */
  light: boolean;
  setLight: (light: boolean) => void;
}

const KEY = "cc-simulator";

function read(): { light: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as { light?: unknown };
    return { light: raw.light !== false };
  } catch {
    return { light: true };
  }
}

export const useSimulatorPrefs = create<SimulatorPrefs>((set) => ({
  ...read(),
  setLight: (light) => {
    set({ light });
    try {
      localStorage.setItem(KEY, JSON.stringify({ light }));
    } catch {
      // Sem localStorage (janela privada): vale só nesta sessão.
    }
  },
}));
