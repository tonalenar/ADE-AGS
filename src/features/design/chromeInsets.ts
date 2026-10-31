/**
 * Quanto uma barra encostada no topo da janela precisa deixar livre para os controles da janela:
 * no macOS os semáforos nativos ficam POR CIMA do conteúdo no canto de cima à esquerda (barra
 * overlay); no Windows e no Linux os botões ficam à direita. Puro: recebe a caixa da barra.
 */
export const MAC_LIGHTS = { right: 84, bottom: 34 } as const;
export const WIN_CONTROLS = { windows: 140, linux: 108, bottom: 34 } as const;

export function chromeInsets(bar: { left: number; top: number; right: number }, windowWidth: number, os: string): { left: number; right: number } {
  if (bar.top >= MAC_LIGHTS.bottom) return { left: 0, right: 0 };
  if (os === "macos") return { left: Math.max(0, Math.ceil(MAC_LIGHTS.right - bar.left)), right: 0 };
  const width = os === "windows" ? WIN_CONTROLS.windows : os === "linux" ? WIN_CONTROLS.linux : 0;
  return { left: 0, right: Math.max(0, Math.ceil(width - (windowWidth - bar.right))) };
}
