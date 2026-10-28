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
    /* sem armazenamento: o Vigia não age (ver `vigiaActive`, falha fechada) */
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

/** O que o armazenamento diz: `null` = a leitura falhou (sem armazenamento, bloqueado). */
function stored(): boolean | null {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return null;
  }
}

/**
 * O Vigia pode AGIR agora (cutucar um terminal, avisar)? Chamado logo antes de cada ação, não só no
 * começo do ciclo: o usuário que desliga o botão no meio de um ciclo (ou noutra janela, que só muda o
 * armazenamento) para a próxima ação. Falha fechada: o botão ligado nesta janela E o armazenamento
 * dizendo ligado; leitura que falha = não age.
 */
export function vigiaActive(): boolean {
  if (!useVigiaSwitch.getState().enabled) return false;
  return stored() === true;
}
