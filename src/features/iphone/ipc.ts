// O iPhone ou iPad físico: ver `src-tauri/src/iphone/` (a lista do devicectl, o helper do CoreDevice, o
// decodificador e a tela nativa). Só VER: nenhum comando daqui mexe no aparelho.
import { invoke } from "@tauri-apps/api/core";

import type { SimPlace } from "@/features/simulator/ipc";

import type { MirrorStatus, PhysicalDevice, Unavailable } from "./model";

export interface PhysicalList {
  devices: PhysicalDevice[];
  /** Por que não dá para espelhar neste Mac (`null` = dá). */
  unavailable: Unavailable | null;
}

export const iphoneDevices = () => invoke<PhysicalList>("iphone_devices");

/** Espelha `device` na tela `id` (um nó do canvas ou o painel do chat), no lugar `place`. */
export const iphoneMirrorAttach = (id: string, device: string, place: SimPlace) => invoke<void>("iphone_mirror_attach", { id, device, place });

export const iphoneMirrorPlace = (id: string, place: SimPlace) => invoke<void>("iphone_mirror_place", { id, place });

export const iphoneMirrorDetach = (id: string) => invoke<void>("iphone_mirror_detach", { id });

/** O estado atual (o mesmo do evento); `null` = nenhuma tela aberta para o aparelho. */
export const iphoneMirrorStatus = (device: string) => invoke<MirrorStatus | null>("iphone_mirror_status", { device });

/** Evento do backend a cada mudança de estado do espelhamento (ligado, reconectando, sem conexão…). */
export const IPHONE_STATUS_EVENT = "iphone-mirror-status";
