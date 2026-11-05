/**
 * O iPhone ou iPad físico ao lado do simulador: o modelo puro (sem React nem Tauri). Ver `src-tauri/src/iphone/`
 * e `docs/ade-ags/ESPELHAMENTO_IPHONE.md`.
 */
import { DEFAULT_SCREEN, type SimScreen } from "@/features/simulator/geometry";

/** O id que o nó do canvas e o painel do chat guardam no lugar do UDID do simulador: `device:<id do CoreDevice>`. */
export const PHYSICAL_PREFIX = "device:";

export type Transport = "usb" | "wifi" | "none";

/** Um iPhone ou iPad de verdade que o CoreDevice conhece (de `iphone_devices`). */
export interface PhysicalDevice {
  id: string;
  name: string;
  /** `iPhone 15 Pro Max`. */
  model: string;
  /** `27.2`. */
  os: string;
  family: "iphone" | "ipad";
  transport: Transport;
  /** A pessoa tocou em "Confiar". */
  paired: boolean;
  /** `false` = o Modo de Desenvolvedor está desligado; `null` = o aparelho não disse. */
  developerMode: boolean | null;
  /** O túnel do CoreDevice está de pé. */
  tunnel: boolean;
}

/** Por que não dá para espelhar neste Mac: sem o Xcode 27, sem o helper no app, ou fora do macOS. */
export type Unavailable = "xcode" | "helper" | "platform";

export type MirrorState = "connecting" | "live" | "reconnecting" | "offline" | "paused";

/** O estado do espelhamento de um aparelho (evento `iphone-mirror-status`). `display` = a tela em pixels. */
export interface MirrorStatus {
  device: string;
  state: MirrorState;
  transport: Transport | null;
  display: { w: number; h: number } | null;
  error: string | null;
}

export function isPhysicalId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.startsWith(PHYSICAL_PREFIX);
}

/** Só guarda (e devolve) uma escolha que é de aparelho físico. */
export function pickedPhysical(raw: string | null | undefined): string | null {
  return isPhysicalId(raw) ? raw : null;
}

export function isReady(d: PhysicalDevice): boolean {
  return d.transport !== "none" && d.paired && d.developerMode !== false;
}

/** O que falta para o aparelho espelhar, na ordem em que a pessoa resolve: ligar o cabo ou o Wi-Fi, tocar em
 *  "Confiar" e ligar o Modo de Desenvolvedor. `null` = pronto. */
export function deviceHint(d: PhysicalDevice): "disconnected" | "trust" | "developerMode" | null {
  if (d.transport === "none") return "disconnected";
  if (!d.paired) return "trust";
  if (d.developerMode === false) return "developerMode";
  return null;
}

export function sortForPicker(list: PhysicalDevice[]): PhysicalDevice[] {
  return [...list].sort((a, b) => Number(isReady(b)) - Number(isReady(a)) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** O iPad comum, enquanto a tela de verdade não chega. */
const DEFAULT_IPAD: SimScreen = { width: 820, height: 1180, family: "ipad" };

/** A tela em pontos do iOS, para a moldura: @3x nos iPhones grandes, @2x nos pequenos (até 828 px) e nos iPads. */
export function physicalScreen(display: { w: number; h: number } | null, family: "iphone" | "ipad"): SimScreen {
  if (!display || display.w <= 0 || display.h <= 0) return family === "ipad" ? DEFAULT_IPAD : DEFAULT_SCREEN;
  const scale = family === "ipad" || display.w <= 828 ? 2 : 3;
  return { width: Math.round(display.w / scale), height: Math.round(display.h / scale), family };
}

/** A linha de estado: a cor, o texto e o transporte (só quando ligado ou reconectando). */
export function statusView(status: MirrorStatus | undefined): { tone: "ok" | "wait" | "off"; key: string; transport: string | null } {
  const state = status?.state ?? "connecting";
  const tone = state === "live" ? "ok" : state === "connecting" || state === "reconnecting" ? "wait" : "off";
  const via = status?.transport && status.transport !== "none" && (state === "live" || state === "reconnecting") ? `iphone.transport.${status.transport}` : null;
  return { tone, key: `iphone.status.${state}`, transport: via };
}
