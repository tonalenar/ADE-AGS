/**
 * O simulador solto no canvas é um bloco alinhado: a barra flutuante em cima, com a largura exata do bloco; o
 * aparelho embaixo e, com a conversa aberta, o painel dela ao lado, com o mesmo topo e o mesmo pé do aparelho.
 * Tudo sai da tela do aparelho (em pontos do iOS) e da escala. Pura.
 */

export const SIM_BAR_H = 38;
export const SIM_GAP_Y = 12;
export const SIM_GAP_X = 16;
export const SIM_CHAT_W = 420;
/** A moldura em volta da tela, em pontos do iOS (vira px com a escala). */
const BEZEL_PT = 17;
/** A barra compacta precisa de pelo menos isto: o aparelho não fica mais estreito que ela. */
export const SIM_MIN_W = 230;
export const SIM_SCALE = { initial: 0.64, max: 1.2, step: 0.08 } as const;

export interface SimScreen {
  width: number;
  height: number;
  family: "iphone" | "ipad";
}

/** O aparelho que ainda não se conhece (a lista do Xcode não chegou): um iPhone de tamanho comum. */
export const DEFAULT_SCREEN: SimScreen = { width: 402, height: 874, family: "iphone" };

export interface PhoneGeometry {
  /** O aparelho com a moldura. */
  w: number;
  h: number;
  bezel: number;
  /** A tela dentro da moldura. */
  screenW: number;
  screenH: number;
  /** Raio dos cantos da tela e da moldura (o iPhone tem cantos bem redondos; o iPad, quase retos). */
  screenRadius: number;
  outerRadius: number;
}

export function phoneOf(screen: SimScreen, scale: number): PhoneGeometry {
  const bezel = BEZEL_PT * scale;
  const screenW = screen.width * scale;
  const screenH = screen.height * scale;
  const screenRadius = screenW * (screen.family === "ipad" ? 0.045 : 0.135);
  return { w: screenW + 2 * bezel, h: screenH + 2 * bezel, bezel, screenW, screenH, screenRadius, outerRadius: screenRadius + bezel };
}

/** A menor escala em que a barra compacta ainda cabe na largura do aparelho. */
export function minScale(screen: SimScreen): number {
  return SIM_MIN_W / (screen.width + 2 * BEZEL_PT);
}

export function clampScale(screen: SimScreen, scale: number): number {
  const value = Number.isFinite(scale) ? scale : SIM_SCALE.initial;
  return Math.round(Math.min(SIM_SCALE.max, Math.max(minScale(screen), value)) * 1000) / 1000;
}

/** O tamanho do nó: barra + espaço + aparelho; com a conversa, mais o painel ao lado. */
export function nodeSize(screen: SimScreen, scale: number, chat: boolean): { w: number; h: number } {
  const phone = phoneOf(screen, scale);
  return {
    w: Math.round(phone.w + (chat ? SIM_GAP_X + SIM_CHAT_W : 0)),
    h: Math.round(SIM_BAR_H + SIM_GAP_Y + phone.h),
  };
}

/** A escala que um nó dessa altura tem (o `box` gravado é a fonte da verdade). Inversa de `nodeSize`. */
export function scaleOf(screen: SimScreen, boxHeight: number): number {
  return clampScale(screen, (boxHeight - SIM_BAR_H - SIM_GAP_Y) / (screen.height + 2 * BEZEL_PT));
}

/** Um passo de zoom pela barra. */
export function stepScale(screen: SimScreen, scale: number, direction: 1 | -1): number {
  return clampScale(screen, scale + direction * SIM_SCALE.step);
}
