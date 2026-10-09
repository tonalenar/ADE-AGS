import { create } from "zustand";

/**
 * A largura da dock (a barra de baixo do canvas), medida pelo próprio componente. Os painéis que
 * abrem acima dela (chat, rotinas, andares, mapa, uso) usam a mesma largura, para ficarem
 * alinhados com a barra. 0 = ainda não medida: cada painel usa a sua largura de sempre.
 */
export const useDockWidth = create<{ width: number; setWidth: (width: number) => void }>((set) => ({
  width: 0,
  setWidth: (width) => set((s) => (s.width === width ? s : { width })),
}));
