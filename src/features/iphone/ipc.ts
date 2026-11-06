// O iPhone ou iPad físico: ver `src-tauri/src/iphone/` (a lista do devicectl, o helper do CoreDevice, o
// decodificador, a tela nativa e o HID). Os botões e gestos daqui são a pessoa mexendo: não pedem confirmação.
import { invoke } from "@tauri-apps/api/core";

import type { SimPlace } from "@/features/simulator/ipc";

import type { HardwareButton, MirrorStatus, PhysicalDevice, SystemGesture, Unavailable } from "./model";

export interface PhysicalList {
  devices: PhysicalDevice[];
  /** Por que não dá para espelhar neste Mac (`null` = dá). */
  unavailable: Unavailable | null;
}

export const iphoneDevices = () => invoke<PhysicalList>("iphone_devices");

/** Pausa todas as telas espelhadas desta instância da ADE, mantendo o pareamento do Mac. */
export const iphoneMirrorDisconnect = (device: string) => invoke<void>("iphone_mirror_disconnect", { device });

/** Libera o espelhamento novamente; as telas visíveis reabrem a sessão. */
export const iphoneMirrorConnect = (device: string) => invoke<void>("iphone_mirror_connect", { device });

/** Consulta a pausa nativa para restaurar o estado visual depois de recarregar a janela. */
export const iphoneMirrorSessionPaused = (device: string) => invoke<boolean>("iphone_mirror_session_paused", { device });

/** Espelha `device` na tela `id` (um nó do canvas ou o painel do chat), no lugar `place`. */
export const iphoneMirrorAttach = (id: string, device: string, place: SimPlace) => invoke<void>("iphone_mirror_attach", { id, device, place });

export const iphoneMirrorPlace = (id: string, place: SimPlace) => invoke<void>("iphone_mirror_place", { id, place });

export const iphoneMirrorDetach = (id: string) => invoke<void>("iphone_mirror_detach", { id });

/** O estado atual (o mesmo do evento); `null` = nenhuma tela aberta para o aparelho. */
export const iphoneMirrorStatus = (device: string) => invoke<MirrorStatus | null>("iphone_mirror_status", { device });

/** Evento do backend a cada mudança de estado do espelhamento (ligado, reconectando, sem conexão…). */
export const IPHONE_STATUS_EVENT = "iphone-mirror-status";
export const IPHONE_SESSION_EVENT = "iphone-mirror-session";

/** Aperta e solta um botão físico do aparelho (início, bloquear, volume, mudo, Siri). */
export const iphoneButton = (device: string, name: HardwareButton | "home") => invoke<void>("iphone_button", { device, name });

/** Um gesto do sistema: Central de Controle, Central de Notificações, Busca ou início. */
export const iphoneGesture = (device: string, name: SystemGesture | "home") => invoke<void>("iphone_gesture", { device, name });

/** Segura (`down`) ou solta um botão: os botões da lateral da moldura (segurar o lateral chama a Siri). */
export const iphoneButtonState = (device: string, name: HardwareButton, down: boolean) => invoke<void>("iphone_button_state", { device, name, down });

/** O alternador de apps (subir da borda de baixo e segurar). */
export const iphoneAppSwitcher = (device: string) => invoke<void>("iphone_gesture", { device, name: "appSwitcher" });

/** Digita o texto no aparelho (teclado US, só ASCII). */
export const iphoneType = (device: string, text: string) => invoke<void>("iphone_type", { device, text });

/** Salva a foto da tela em Imagens; devolve o caminho. */
export const iphoneScreenshot = (device: string) => invoke<string>("iphone_screenshot", { device });

/** Copia um PNG para a área de transferência do Mac. */
export const iphoneCopyImage = (path: string) => invoke<void>("iphone_copy_image", { path });
