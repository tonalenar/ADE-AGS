import { create } from "zustand";

const KEY = "ags.vigia.enabled";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function write(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
}

interface VigiaSwitch {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  toggle: () => void;
}

/**
 * Liga e desliga o Vigia. Começa DESLIGADO: ele escreve nos terminais dos agentes, então só
 * age quando o usuário pede (botão ao lado do chat, na barra de baixo do canvas).
 */
export const useVigiaSwitch = create<VigiaSwitch>((set, get) => ({
  enabled: read(),
  setEnabled: (on) => {
    write(on);
    set({ enabled: on });
  },
  toggle: () => get().setEnabled(!get().enabled),
}));
