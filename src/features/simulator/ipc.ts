// O simulador iOS: ver `src-tauri/src/simulator/` (CoreSimulator, a tela por IOSurface e o HID) e
// `src-tauri/src/ipc/commands/simulators.rs` (a conversa com os agentes conectados).
import { invoke } from "@tauri-apps/api/core";
import type { Box } from "@/features/browser/realBrowser";

/** Um iPhone ou iPad do Xcode. `width`×`height` é a tela em pontos do iOS. */
export interface SimDevice {
  udid: string;
  name: string;
  runtime: string;
  family: "iphone" | "ipad";
  state: "shutdown" | "booting" | "booted" | "shuttingDown" | "unknown";
  width: number;
  height: number;
}

/** Onde a tela está: `rect` na janela; `visible` e `holes` relativos à própria tela (ver `simulator::model::Place`). */
export interface SimPlace {
  rect: Box;
  radius: number;
  visible: Box | null;
  holes: Box[];
}

export const simulatorDevices = () => invoke<SimDevice[]>("simulator_devices");

/** Liga sem o app Simulator; desliga junto com a ADE. `light` = o iOS na prioridade baixa. */
export const simulatorBoot = (udid: string, light: boolean) => invoke<void>("simulator_boot", { udid, light });

/** Modo leve num aparelho ligado: o iOS passa para a prioridade baixa (ou volta à normal) na hora. */
export const simulatorPriority = (udid: string, light: boolean) => invoke<number>("simulator_priority", { udid, light });

export const simulatorShutdown = (udid: string) => invoke<void>("simulator_shutdown", { udid });

/** `home`, `lock`, `side` ou `siri`. */
export const simulatorButton = (udid: string, name: string) => invoke<void>("simulator_button", { udid, name });

export const simulatorOpenUrl = (udid: string, url: string) => invoke<void>("simulator_open_url", { udid, url });

/** A foto da tela num PNG temporário: o caminho. */
export const simulatorScreenshot = (udid: string) => invoke<string>("simulator_screenshot", { udid });

/** Mostra a tela de `udid` na janela como a tela `id`, no lugar `place`. */
export const simulatorAttach = (id: string, udid: string, place: SimPlace) => invoke<void>("simulator_attach", { id, udid, place });

export const simulatorPlace = (id: string, place: SimPlace) => invoke<void>("simulator_place", { id, place });

export const simulatorDetach = (id: string) => invoke<void>("simulator_detach", { id });

/** Manda a mensagem da pessoa a todos os agentes ligados ao nó `node` do canvas `key`. */
export const simulatorTell = (key: string, node: string, name: string, text: string, shot: string | null) =>
  invoke<{ sent: string[] }>("simulator_tell", { key, node, name, text, shot });
