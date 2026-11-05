import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import { iphoneDevices, iphoneMirrorStatus, IPHONE_STATUS_EVENT } from "./ipc";
import { pickedPhysical, sortForPicker, type MirrorStatus, type PhysicalDevice, type Unavailable } from "./model";

interface IphoneState {
  devices: PhysicalDevice[];
  loaded: boolean;
  unavailable: Unavailable | null;
  /** O estado do espelhamento de cada aparelho (por id). */
  statuses: Record<string, MirrorStatus>;
  /** O aparelho físico escolhido no painel do chat (`null` = o painel mostra um simulador). Não vai para os agentes:
   *  por enquanto eles não controlam aparelho físico. */
  panelPick: string | null;
}

const PICK_KEY = "cc-iphone-panel-pick";

function readPick(): string | null {
  try {
    return pickedPhysical(localStorage.getItem(PICK_KEY));
  } catch {
    return null;
  }
}

export const useIphoneStore = create<IphoneState>(() => ({ devices: [], loaded: false, unavailable: null, statuses: {}, panelPick: readPick() }));

/** O painel do chat passa a mostrar `id` (um aparelho físico) ou volta ao simulador (`null`). */
export function setPanelPick(id: string | null) {
  const pick = pickedPhysical(id);
  try {
    if (pick) localStorage.setItem(PICK_KEY, pick);
    else localStorage.removeItem(PICK_KEY);
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
  useIphoneStore.setState({ panelPick: pick });
}

let loading: Promise<void> | null = null;

/** Relê a lista do CoreDevice (`devicectl`, ~0,6 s). */
export function refreshPhysical(): Promise<void> {
  loading ??= iphoneDevices()
    .then((list) => useIphoneStore.setState({ devices: sortForPicker(list.devices), unavailable: list.unavailable, loaded: true }))
    .catch(() => useIphoneStore.setState({ loaded: true }))
    .finally(() => { loading = null; });
  return loading;
}

/** De quanto em quanto relê a lista enquanto alguém mostra os aparelhos (um iPhone demora a aparecer no Wi-Fi). */
const LIST_EVERY_MS = 4000;
let watchers = 0;
let timer: number | undefined;

/** Mantém a lista em dia enquanto algum seletor ou estado vazio está aberto; devolve o "parar". */
export function watchPhysical(): () => void {
  watchers += 1;
  if (watchers === 1) {
    void refreshPhysical();
    timer = window.setInterval(() => { if (!document.hidden) void refreshPhysical(); }, LIST_EVERY_MS);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers -= 1;
    if (watchers === 0) window.clearInterval(timer);
  };
}

/** A lista dos aparelhos físicos, relida enquanto `active`. */
export function usePhysicalDevices(active = true) {
  useEffect(() => (active ? watchPhysical() : undefined), [active]);
  return useIphoneStore((s) => s.devices);
}

let listening = false;

/** Ouve o estado do espelhamento (`iphone-mirror-status`). Uma vez por janela. */
export function listenMirrorStatus() {
  if (listening) return;
  listening = true;
  listen<MirrorStatus>(IPHONE_STATUS_EVENT, (e) => setStatus(e.payload)).catch(() => { listening = false; });
}

export function setStatus(status: MirrorStatus) {
  useIphoneStore.setState((s) => ({ statuses: { ...s.statuses, [status.device]: status } }));
}

/** O estado do espelhamento de `device`, acompanhado (pede o atual ao abrir). */
export function useMirrorStatus(device: string | null): MirrorStatus | undefined {
  useEffect(() => {
    listenMirrorStatus();
    if (device) iphoneMirrorStatus(device).then((s) => s && setStatus(s)).catch(() => undefined);
  }, [device]);
  return useIphoneStore((s) => (device ? s.statuses[device] : undefined));
}
