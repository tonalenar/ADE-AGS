import type { Viewport } from "./viewport";

/**
 * Catálogo único dos celulares: o que a moldura do navegador, o celular solto do canvas e o backend (densidade e área
 * segura do CDP) usam. Medidas em pt/dp do aparelho, que viram px da página 1:1 (o viewport CSS é em pt/dp).
 */
export type PhonePlatform = "ios" | "android";

export interface Insets { top: number; bottom: number; left: number; right: number }

export type ButtonKind = "action" | "volUp" | "volDown" | "volume" | "power";

/** Um botão do aparelho em pé: o lado, o começo e o comprimento (frações do lado maior, a partir do topo). */
export interface ButtonSpec { side: "left" | "right"; kind: ButtonKind; start: number; length: number }

export interface PhoneModel {
  id: string;
  label: string;
  brand: "Apple" | "Samsung" | "Google";
  platform: PhonePlatform;
  /** O viewport CSS em pé. */
  width: number;
  height: number;
  dpr: number;
  /** O raio dos cantos da tela. */
  radius: number;
  /** A borda preta e o aro de metal em volta da tela. */
  bezel: number;
  rim: number;
  /** A ilha (iPhone) ou o furo da câmera (Android), em pé: `top` é a distância do topo da tela. */
  cutout: { kind: "island" | "punch"; width: number; height: number; top: number };
  /** A altura da barra de status em pé. */
  statusBar: number;
  safePortrait: Insets;
  safeLandscape: Insets;
  /** A barra de início (iPhone) ou a alça de gestos (Android): o comprimento em pé e deitado. */
  home: { portrait: number; landscape: number; bottom: number; height: number };
  buttons: readonly ButtonSpec[];
  /** O `model` do user agent (Android). */
  uaModel: string;
}

const IPHONE_BUTTONS: readonly ButtonSpec[] = [
  { side: "left", kind: "action", start: 0.175, length: 0.04 },
  { side: "left", kind: "volUp", start: 0.245, length: 0.075 },
  { side: "left", kind: "volDown", start: 0.34, length: 0.075 },
  { side: "right", kind: "power", start: 0.28, length: 0.112 },
];

export const PHONE_MODELS: readonly PhoneModel[] = [
  {
    id: "iphone-17-pro", label: "iPhone 17 Pro / 16 Pro", brand: "Apple", platform: "ios", width: 402, height: 874, dpr: 3, radius: 62,
    bezel: 10, rim: 2, cutout: { kind: "island", width: 126, height: 37, top: 11 }, statusBar: 62,
    safePortrait: { top: 62, bottom: 34, left: 0, right: 0 }, safeLandscape: { top: 0, bottom: 21, left: 62, right: 62 },
    home: { portrait: 139, landscape: 209, bottom: 8, height: 5 }, buttons: IPHONE_BUTTONS, uaModel: "",
  },
  {
    id: "iphone-17-pro-max", label: "iPhone 17 Pro Max / 16 Pro Max", brand: "Apple", platform: "ios", width: 440, height: 956, dpr: 3, radius: 62,
    bezel: 10, rim: 2, cutout: { kind: "island", width: 126, height: 37, top: 11 }, statusBar: 62,
    safePortrait: { top: 62, bottom: 34, left: 0, right: 0 }, safeLandscape: { top: 0, bottom: 21, left: 62, right: 62 },
    home: { portrait: 144, landscape: 215, bottom: 8, height: 5 }, buttons: IPHONE_BUTTONS, uaModel: "",
  },
  {
    id: "iphone-16", label: "iPhone 16 / 15 Pro", brand: "Apple", platform: "ios", width: 393, height: 852, dpr: 3, radius: 55,
    bezel: 11, rim: 2, cutout: { kind: "island", width: 126, height: 37, top: 11 }, statusBar: 59,
    safePortrait: { top: 59, bottom: 34, left: 0, right: 0 }, safeLandscape: { top: 0, bottom: 21, left: 59, right: 59 },
    home: { portrait: 134, landscape: 209, bottom: 8, height: 5 }, buttons: IPHONE_BUTTONS, uaModel: "",
  },
  {
    id: "pixel-9", label: "Pixel 9 / 10", brand: "Google", platform: "android", width: 412, height: 924, dpr: 2.625, radius: 46,
    bezel: 10, rim: 2, cutout: { kind: "punch", width: 15, height: 15, top: 14 }, statusBar: 44,
    safePortrait: { top: 44, bottom: 24, left: 0, right: 0 }, safeLandscape: { top: 0, bottom: 24, left: 44, right: 0 },
    home: { portrait: 108, landscape: 108, bottom: 9, height: 4 },
    buttons: [
      { side: "right", kind: "power", start: 0.28, length: 0.065 },
      { side: "right", kind: "volume", start: 0.38, length: 0.13 },
    ],
    uaModel: "Pixel 9",
  },
  {
    id: "galaxy-s25", label: "Galaxy S25", brand: "Samsung", platform: "android", width: 360, height: 780, dpr: 3, radius: 38,
    bezel: 9, rim: 2, cutout: { kind: "punch", width: 12, height: 12, top: 11 }, statusBar: 36,
    safePortrait: { top: 36, bottom: 24, left: 0, right: 0 }, safeLandscape: { top: 0, bottom: 24, left: 36, right: 0 },
    home: { portrait: 108, landscape: 108, bottom: 9, height: 4 },
    buttons: [
      { side: "right", kind: "volume", start: 0.24, length: 0.13 },
      { side: "right", kind: "power", start: 0.41, length: 0.068 },
    ],
    uaModel: "SM-S931B",
  },
  {
    id: "galaxy-s25-ultra", label: "Galaxy S25 Ultra", brand: "Samsung", platform: "android", width: 412, height: 915, dpr: 3.5, radius: 20,
    bezel: 9, rim: 2, cutout: { kind: "punch", width: 11, height: 11, top: 11 }, statusBar: 36,
    safePortrait: { top: 36, bottom: 24, left: 0, right: 0 }, safeLandscape: { top: 0, bottom: 24, left: 36, right: 0 },
    home: { portrait: 108, landscape: 108, bottom: 9, height: 4 },
    buttons: [
      { side: "right", kind: "volume", start: 0.24, length: 0.125 },
      { side: "right", kind: "power", start: 0.4, length: 0.065 },
    ],
    uaModel: "SM-S938B",
  },
];

/** O aparelho de partida de cada sistema: o mais novo. */
export function defaultModel(platform: PhonePlatform): PhoneModel {
  return PHONE_MODELS.find((m) => m.platform === platform)!;
}

/** O modelo do sistema com este tamanho (em pé ou deitado); sem correspondência, o padrão do sistema. Pura. */
export function modelFor(platform: PhonePlatform, viewport: Viewport | null | undefined): PhoneModel {
  if (viewport) {
    const short = Math.min(viewport.width, viewport.height);
    const long = Math.max(viewport.width, viewport.height);
    const found = PHONE_MODELS.find((m) => m.platform === platform && m.width === short && m.height === long);
    if (found) return found;
  }
  return defaultModel(platform);
}

/** A área segura do modelo na orientação. Pura. */
export function insetsFor(model: PhoneModel, landscape: boolean): Insets {
  return { ...(landscape ? model.safeLandscape : model.safePortrait) };
}

/** A espessura total da moldura (borda preta + aro), em pt: a mesma em pé e deitado. */
export function frameThickness(model: PhoneModel): number {
  return model.bezel + model.rim;
}

/** O envelope do aparelho inteiro, em pt: a tela mais a moldura dos dois lados. */
function envelope(viewport: Viewport, frame: number): Viewport {
  return { width: viewport.width + 2 * frame, height: viewport.height + 2 * frame };
}

/** A largura/altura do aparelho COM a moldura, para a miniatura encaixar justa. Pura. */
export function outerAspect(viewport: Viewport, platform: PhonePlatform): number {
  const box = envelope(viewport, frameThickness(modelFor(platform, viewport)));
  return box.width / box.height;
}

export interface CutoutBox {
  kind: "island" | "punch";
  left: number | string;
  top: number | string;
  width: number;
  height: number;
  translate: string;
}

/** Onde fica a ilha ou o furo: no topo em pé, na lateral esquerda deitado (rodando o aparelho no sentido anti-horário). */
export function cutoutBox(model: PhoneModel, landscape: boolean): CutoutBox {
  const { kind, width, height, top } = model.cutout;
  return landscape
    ? { kind, left: top, top: "50%", width: height, height: width, translate: "0 -50%" }
    : { kind, left: "50%", top, width, height, translate: "-50% 0" };
}

export interface ButtonPlacement { edge: "left" | "right" | "top" | "bottom"; kind: ButtonKind; start: number; length: number }

/**
 * Os botões na orientação. Deitado (anti-horário, ilha à esquerda), a borda esquerda em pé vai para baixo e a direita
 * para cima; a posição ao longo do lado maior é a mesma (do começo, a esquerda). Ordenados por `start`. Pura.
 */
export function buttonPlacements(model: PhoneModel, landscape: boolean): ButtonPlacement[] {
  const edge = (side: "left" | "right"): ButtonPlacement["edge"] =>
    !landscape ? side : side === "left" ? "bottom" : "top";
  return model.buttons
    .map((b) => ({ edge: edge(b.side), kind: b.kind, start: b.start, length: b.length }))
    .sort((a, b) => a.start - b.start);
}

/**
 * A área segura que a PÁGINA vê (`env(safe-area-inset-*)`). O que o aparelho desenha fora dela não conta: no iPhone em
 * pé a barra de status vira margem do `<html>` (topo 0); no Android a barra do Chrome e a faixa da câmera ficam fora da
 * vista. Pura.
 */
export function pageInsets(model: PhoneModel, landscape: boolean): Insets {
  if (model.platform === "android") return { top: 0, bottom: 0, left: 0, right: 0 };
  const safe = insetsFor(model, landscape);
  return landscape ? safe : { ...safe, top: 0 };
}

/** O que o backend precisa do modelo (`real_browser_emulate`). */
export interface DeviceHint { dpr: number; uaModel: string; safePortrait: Insets; safeLandscape: Insets }

export function deviceHintOf(model: PhoneModel): DeviceHint {
  return { dpr: model.dpr, uaModel: model.uaModel, safePortrait: pageInsets(model, false), safeLandscape: pageInsets(model, true) };
}
