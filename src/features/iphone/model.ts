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
  /** O toque do aparelho está pronto (HID do CoreDevice aberto). */
  input?: boolean;
}

/** Os gestos do sistema do menu "Sistema" (nomes do backend, `iphone::model::gesture`). */
export const SYSTEM_GESTURES = ["controlCenter", "notificationCenter", "spotlight"] as const;
export type SystemGesture = (typeof SYSTEM_GESTURES)[number];

/** Os botões físicos do menu "Botões" (nomes do backend, `iphone::model::button_usage`). */
export const HARDWARE_BUTTONS = ["volumeUp", "volumeDown", "mute", "siri", "lock"] as const;
export type HardwareButton = (typeof HARDWARE_BUTTONS)[number];

/** Dá para mandar toque agora? */
export function canTouch(status: MirrorStatus | undefined): boolean {
  return status?.state === "live" && status.input === true;
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

/** Um botão da lateral da moldura: onde fica (proporção da altura do aparelho) e o que aperta. */
export interface FrameButton {
  button: HardwareButton;
  side: "left" | "right" | "top";
  top: number;
  height: number;
  /** `action` = o botão de ação; `switch` = a chave de silêncio dos modelos antigos; `button` = um botão comum. */
  kind: "action" | "switch" | "button";
}

export interface FrameLayout {
  buttons: FrameButton[];
  /** A Ilha Dinâmica (desenhada só enquanto o vídeo não chega: depois o próprio aparelho a desenha). */
  island: boolean;
  /** A borda em volta da tela, em proporção da largura da tela; e o raio dos cantos da tela, idem. */
  bezel: number;
  radius: number;
}

/** Modelos com o botão de ação (15 Pro, 16, 17 e o 16e). */
function hasActionButton(model: string): boolean {
  return /iPhone 15 Pro|iPhone 1[6-9]|iPhone [2-9]\d/.test(model);
}

/** Modelos com a Ilha Dinâmica (14 Pro em diante, e todos do 15 em diante). */
function hasIsland(model: string): boolean {
  return /iPhone 14 Pro|iPhone 1[5-9]|iPhone [2-9]\d/.test(model) && !/iPhone 16e/.test(model);
}

/**
 * A moldura do modelo: a posição dos botões (das medidas da Apple, aproximadas), a borda e os cantos. Os iPhones com
 * Face ID dividem o mesmo desenho; a diferença é o botão de ação ou a chave de silêncio. O iPad tem o botão superior.
 */
export function frameLayout(model: string, family: "iphone" | "ipad"): FrameLayout {
  if (family === "ipad") {
    return {
      buttons: [
        { button: "lock", side: "top", top: 0.78, height: 0.08, kind: "button" },
        { button: "volumeUp", side: "right", top: 0.1, height: 0.06, kind: "button" },
        { button: "volumeDown", side: "right", top: 0.17, height: 0.06, kind: "button" },
      ],
      island: false,
      bezel: 0.055,
      radius: 0.045,
    };
  }
  const action = hasActionButton(model);
  return {
    buttons: [
      { button: "mute", side: "left", top: action ? 0.19 : 0.17, height: action ? 0.045 : 0.035, kind: action ? "action" : "switch" },
      { button: "volumeUp", side: "left", top: 0.255, height: 0.075, kind: "button" },
      { button: "volumeDown", side: "left", top: 0.35, height: 0.075, kind: "button" },
      { button: "lock", side: "right", top: 0.27, height: 0.115, kind: "button" },
    ],
    island: hasIsland(model),
    bezel: 0.04,
    radius: 0.135,
  };
}

/** O zoom do aparelho no painel: 1 = um pixel CSS por ponto do iOS. */
export const ZOOM = { min: 0.25, max: 2, step: 0.1 } as const;

/** O zoom que faz o aparelho (tela + borda) caber em `box`. */
export function fitScale(screen: { width: number; height: number }, box: { w: number; h: number }, bezel: number): number {
  if (box.w <= 0 || box.h <= 0 || screen.width <= 0 || screen.height <= 0) return ZOOM.min;
  const outer = { w: screen.width * (1 + 2 * bezel), h: screen.height + screen.width * 2 * bezel };
  return Math.max(ZOOM.min, Math.min(ZOOM.max, box.w / outer.w, box.h / outer.h));
}

export function stepZoom(zoom: number, direction: 1 | -1): number {
  return Math.round(Math.min(ZOOM.max, Math.max(ZOOM.min, zoom + direction * ZOOM.step)) * 100) / 100;
}
