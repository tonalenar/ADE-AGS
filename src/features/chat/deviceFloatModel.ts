/** A área da conversa, em coordenadas da janela (o `getBoundingClientRect` do `<main>`). */
export interface ChatAreaRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** O retângulo do aparelho flutuante, em coordenadas da janela (`position: fixed`). */
export interface DeviceFloatBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A mesma margem do preview do navegador, do canto de baixo à direita. */
const FLOAT_MARGIN = 18;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * Onde o aparelho flutua: uma fração da conversa, entre um mínimo e um máximo, encostado no canto de baixo à direita.
 * Numa conversa pequena, o piso (280 px de largura e 240 de altura) vence o encolhimento. Pura.
 */
export function deviceFloatBox(area: ChatAreaRect): DeviceFloatBox {
  const width = Math.round(Math.min(clamp(area.width * 0.42, 340, 460), Math.max(280, area.width - 24)));
  const height = Math.round(Math.min(clamp(area.height * 0.6, 360, 560), Math.max(240, area.height - 72)));
  return {
    left: Math.round(area.left + area.width - width - FLOAT_MARGIN),
    top: Math.round(area.top + area.height - height - FLOAT_MARGIN),
    width,
    height,
  };
}
