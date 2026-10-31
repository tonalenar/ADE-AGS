import type { Surface } from "./store";

/** Um aparelho do painel que os agentes alcançam (`devices_share`). */
export interface SharedDevice { kind: "ios" | "android"; name: string; udid?: string; serial?: string }

/**
 * As contas dos aparelhos do painel direito (pranchetas 9 e 10): a moldura proporcional à da prancheta,
 * o nome do Android e os lugares prontos da localização simulada. Tudo puro.
 */

export interface Size { w: number; h: number }

export interface DeviceFrame {
  /** O aparelho com a moldura. */
  outerW: number;
  outerH: number;
  /** A moldura em volta da tela. */
  pad: number;
  outerRadius: number;
  screenRadius: number;
}

/** As medidas da prancheta, relativas à largura da tela: iPhone 300×620 com moldura de 10 e cantos 52/42; Pixel 296×620, 9 e 40/32. */
const LOOK = {
  ios: { pad: 10 / 280, outer: 52 / 280, screen: 42 / 280 },
  ipad: { pad: 10 / 280, outer: 22 / 280, screen: 14 / 280 },
  android: { pad: 9 / 278, outer: 40 / 278, screen: 32 / 278 },
} as const;

/** A maior altura do aparelho no painel, como na prancheta (620 numa janela de 900). */
export const MAX_DEVICE_H = 680;

/** A moldura que cabe em `box` com a tela na proporção `screen` (pontos ou pixels). Sem espaço = zeros. */
export function deviceFrame(look: keyof typeof LOOK, screen: Size, box: Size, maxH = MAX_DEVICE_H): DeviceFrame {
  const ratio = LOOK[look];
  if (screen.w <= 0 || screen.h <= 0 || box.w <= 0 || box.h <= 0) return { outerW: 0, outerH: 0, pad: 0, outerRadius: 0, screenRadius: 0 };
  // Com a tela de largura 1: o aparelho mede (1 + 2·pad) × (h/w + 2·pad).
  const unitW = 1 + 2 * ratio.pad;
  const unitH = screen.h / screen.w + 2 * ratio.pad;
  const scale = Math.max(0, Math.min(box.w / unitW, Math.min(box.h, maxH) / unitH));
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    outerW: round(unitW * scale),
    outerH: round(unitH * scale),
    pad: round(ratio.pad * scale),
    outerRadius: round(ratio.outer * scale),
    screenRadius: round(ratio.screen * scale),
  };
}

export interface AndroidInfo { model: string; api: number | null; emulator: boolean }

/** O rótulo de um Android no seletor: "Pixel 9 · API 36 · emulador" ou "Galaxy S25 · USB". */
export function androidLabel(info: AndroidInfo, words: { emulator: string; usb: string }): string {
  const parts = [info.model.trim() || "Android"];
  if (info.emulator) {
    if (info.api !== null) parts.push(`API ${info.api}`);
    parts.push(words.emulator);
  } else {
    parts.push(words.usb);
  }
  return parts.join(" · ");
}

/** O nome curto de um iOS para a aba (`iPhone 18 Pro`) e o do seletor (`iPhone 18 Pro · iOS 26`). */
export function iosLabel(name: string, runtime: string): string {
  return runtime ? `${name} · ${runtime}` : name;
}

/** Lugares prontos para a localização simulada. */
export const LOCATION_PRESETS = [
  { id: "saoPaulo", lat: -23.5505, lon: -46.6333 },
  { id: "rio", lat: -22.9068, lon: -43.1729 },
  { id: "lisbon", lat: 38.7223, lon: -9.1393 },
  { id: "newYork", lat: 40.7128, lon: -74.006 },
  { id: "cupertino", lat: 37.3349, lon: -122.009 },
] as const;

/** Um número de latitude (±90) ou longitude (±180) digitado com ponto ou vírgula; `null` se não serve. */
export function parseCoord(text: string, limit: 90 | 180): number | null {
  const n = Number(text.trim().replace(",", "."));
  return text.trim() !== "" && Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** Os aparelhos que o painel mostra agora: uma aba aberta com um aparelho escolhido. Pura. */
export function sharedDevices(surfaces: Surface[], devices: { ios: string | null; android: string | null }, names: { ios: string | null; android: string | null }): SharedDevice[] {
  const out: SharedDevice[] = [];
  if (surfaces.includes("ios") && devices.ios) out.push({ kind: "ios", name: names.ios ?? devices.ios, udid: devices.ios });
  if (surfaces.includes("android") && devices.android) out.push({ kind: "android", name: names.android ?? devices.android, serial: devices.android });
  return out;
}
