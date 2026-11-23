import { buttonPlacements, frameThickness, type ButtonKind, type PhoneModel } from "./deviceCatalog";
import type { Viewport } from "./viewport";

/** A espessura mínima, em px do monitor, da borda preta e do aro: na miniatura a moldura continua visível. */
const MIN_BEZEL_PX = 4;
const MIN_RIM_PX = 1.5;
/** Quanto o botão sai da moldura (pt) e o mínimo visível (px do monitor). */
const BUTTON_OUT = 3;
const MIN_BUTTON_PX = 2;

/** A borda preta e o aro em px do MONITOR: proporcionais ao aparelho (pt × escala), nunca menores que o mínimo. Pura. */
export function monitorFrame(model: Pick<PhoneModel, "bezel" | "rim">, scale: number): { bezel: number; rim: number } {
  return {
    bezel: Math.max(model.bezel * scale, MIN_BEZEL_PX),
    rim: Math.max(model.rim * scale, MIN_RIM_PX),
  };
}

/** A escala que faz o aparelho inteiro (tela + moldura) caber na caixa da miniatura, com `margin` px de folga. Pura. */
export function miniScale(shown: Viewport, box: Viewport, model: PhoneModel, margin: number): number {
  const f = frameThickness(model);
  const s = Math.min((box.width - margin) / (shown.width + 2 * f), (box.height - margin) / (shown.height + 2 * f));
  return Number.isFinite(s) ? Math.max(0.1, s) : 0.1;
}

export interface ButtonRect { kind: ButtonKind; left: number; top: number; width: number; height: number }

/**
 * Os botões em px do monitor, relativos ao canto da tela (`w`×`h` = a tela já escalada): saem pela moldura, com a
 * espessura e o comprimento proporcionais a `scale`. Pura.
 */
export function buttonRects(model: PhoneModel, landscape: boolean, w: number, h: number, scale: number): ButtonRect[] {
  const f = monitorFrame(model, scale);
  const thick = Math.max(MIN_BUTTON_PX, BUTTON_OUT * scale);
  const out = f.bezel + f.rim + thick - 1;
  const long = landscape ? w : h;
  return buttonPlacements(model, landscape).map(({ edge, kind, start, length }) => {
    const along = start * long;
    const size = length * long;
    switch (edge) {
      case "left": return { kind, left: -out, top: along, width: thick, height: size };
      case "right": return { kind, left: w + out - thick, top: along, width: thick, height: size };
      case "top": return { kind, left: along, top: -out, width: size, height: thick };
      default: return { kind, left: along, top: h + out - thick, width: size, height: thick };
    }
  });
}
