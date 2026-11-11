import { create } from "zustand";

/** A página que a superfície Páginas HTML mostra (`null` = a lista). Um agente pode pedir uma página específica. */
interface RendersState {
  selectedId: string | null;
  select: (id: string | null) => void;
}

export const useRendersStore = create<RendersState>((set) => ({
  selectedId: null,
  select: (id) => set({ selectedId: id }),
}));
