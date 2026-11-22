/** Larguras de teste do modo focado (desktop, tablet e celular), em px de prancheta. */
export const FRAME_WIDTHS = { desktop: 1280, tablet: 834, mobile: 390 } as const;

/** Margem em volta da prancheta no modo Caber. */
const PAD = 24;

export interface FocusFrameInput {
  board: { w: number; h: number };
  /** Preencher: a janela inteira (ou a largura escolhida, reduzida para caber). Caber: a prancheta inteira. */
  fit: "fill" | "fit";
  /** Largura escolhida (um dos `FRAME_WIDTHS`), ou `null` para a largura original da prancheta. */
  width: number | null;
  /** O tamanho da área da tela de foco. */
  box: { w: number; h: number };
}

export interface FocusFrame { w: number; h: number; k: number; left: number; top: number }

/** Onde e em que escala o iframe da prancheta fica no modo focado. Puro: a tela só mede a janela. */
export function focusFrame({ board, fit, width, box }: FocusFrameInput): FocusFrame {
  if (fit === "fill") {
    if (width === null) return { w: box.w, h: box.h, k: 1, left: 0, top: 0 };
    const k = box.w > 0 ? Math.min(1, box.w / width) : 1;
    return { w: width, h: box.h, k, left: (box.w - width * k) / 2, top: 0 };
  }
  const w = width ?? board.w;
  const h = board.h;
  const k = box.w > 0 ? Math.min(1, (box.w - PAD * 2) / w, (box.h - PAD * 2) / h) : 1;
  return { w, h, k, left: (box.w - w * k) / 2, top: (box.h - h * k) / 2 };
}
