import { create } from "zustand";

interface BotPanelState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/** Si el panel del bot está abierto. Lo abre un clic en el bot, desde cualquier lado. */
export const useBotPanelStore = create<BotPanelState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export const openBotPanel = () => useBotPanelStore.getState().setOpen(true);
