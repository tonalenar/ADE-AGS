import { create } from "zustand";

import type { SettingsPageId } from "@/features/settings/settingsNav";

/** Para onde a busca mandou ir: a página, a aba (quando a página tem abas) e o bloco a rolar. */
export interface SettingsTarget {
  readonly page: SettingsPageId;
  readonly tab?: string;
  readonly anchor: string;
  /** Muda a cada pedido, para o mesmo ajuste poder ser achado de novo depois de rolar. */
  readonly nonce: number;
}

interface SettingsTargetState {
  target: SettingsTarget | null;
  goTo: (target: Omit<SettingsTarget, "nonce">) => void;
  clear: () => void;
}

let nonceSeq = 0;

/**
 * O pedido pendente de rolar até um bloco. A página o consome ao montar o bloco e o limpa; é só
 * uma ponte entre a barra (que escolhe) e o corpo da página (que rola).
 */
export const useSettingsTargetStore = create<SettingsTargetState>((set) => ({
  target: null,
  goTo: (target) => set({ target: { ...target, nonce: ++nonceSeq } }),
  clear: () => set({ target: null }),
}));
