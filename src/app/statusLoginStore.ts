import { create } from "zustand";

import type { AgentAccount } from "@/features/accounts/types";

interface StatusLoginState {
  /** A conta cujo login está aberto pela barra de status, ou `null`. */
  account: AgentAccount | null;
  open: (account: AgentAccount) => void;
  close: () => void;
}

/**
 * O login de conta aberto pela barra de status. Mora numa store, e não no estado da própria barra, para o
 * diálogo ficar FORA da fronteira de erro da barra: se a barra quebra com o login aberto, o terminal de login
 * (um PTY) continua montado.
 */
export const useStatusLoginStore = create<StatusLoginState>((set) => ({
  account: null,
  open: (account) => set({ account }),
  close: () => set({ account: null }),
}));
