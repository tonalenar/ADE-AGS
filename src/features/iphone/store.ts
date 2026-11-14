import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import { iphoneDevices, iphoneMirrorSessionPaused, iphoneMirrorStatus, IPHONE_SESSION_EVENT, IPHONE_STATUS_EVENT } from "./ipc";
import { pickedPhysical, sortForPicker, type MirrorStatus, type PhysicalDevice, type Unavailable } from "./model";

interface IphoneState {
  devices: PhysicalDevice[];
  loaded: boolean;
  unavailable: Unavailable | null;
  /** O estado do espelhamento de cada aparelho (por id). */
  statuses: Record<string, MirrorStatus>;
  /** Aparelhos cuja sessão ADE foi pausada pela pessoa no painel. */
  disconnectedDevices: string[];
  /** O aparelho físico escolhido no painel do chat (`null` = o painel mostra um simulador). */
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

export const useIphoneStore = create<IphoneState>(() => ({ devices: [], loaded: false, unavailable: null, statuses: {}, disconnectedDevices: [], panelPick: readPick() }));

/** Sincroniza a pausa local da sessão com as outras janelas e com o comando nativo. */
export function setMirrorDisconnected(device: string, disconnected: boolean) {
  useIphoneStore.setState((s) => ({ disconnectedDevices: disconnected
    ? s.disconnectedDevices.includes(device) ? s.disconnectedDevices : [...s.disconnectedDevices, device]
    : s.disconnectedDevices.filter((id) => id !== device) }));
}

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

/** Relê a lista do CoreDevice (`devicectl`, ~0,6 s). `force` agenda uma consulta fresca após a atual. */
export function refreshPhysical(force = false): Promise<void> {
  if (loading && !force) return loading;
  const previous = loading;
  let request!: Promise<void>;
  request = (async () => {
    if (previous) await previous;
    try {
      const list = await iphoneDevices();
      useIphoneStore.setState({ devices: sortForPicker(list.devices), unavailable: list.unavailable, loaded: true });
    } catch {
      useIphoneStore.setState({ loaded: true });
    }
  })().finally(() => {
    if (loading === request) loading = null;
  });
  loading = request;
  return request;
}

/** De quanto em quanto relê a lista enquanto alguém mostra os aparelhos (um iPhone demora a aparecer no Wi-Fi). */
// A varredura via devicectl leva cerca de 0,3 s neste Mac; 2 s reduz a espera para aparelhos
// que acabam de surgir no Wi-Fi sem manter consultas mais frequentes que o próprio comando.
const LIST_EVERY_MS = 2000;
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
let listeningSession = false;

/** Ouve o estado do espelhamento (`iphone-mirror-status`). Uma vez por janela. */
export function listenMirrorStatus() {
  if (listening) return;
  listening = true;
  listen<MirrorStatus>(IPHONE_STATUS_EVENT, (e) => setStatus(e.payload)).catch(() => { listening = false; });
}

function listenMirrorSession() {
  if (listeningSession) return;
  listeningSession = true;
  listen<{ device: string; disconnected: boolean }>(IPHONE_SESSION_EVENT, (e) => setMirrorDisconnected(e.payload.device, e.payload.disconnected))
    .catch(() => { listeningSession = false; });
}

export function setStatus(status: MirrorStatus) {
  useIphoneStore.setState((s) => ({ statuses: { ...s.statuses, [status.device]: status } }));
}

/** O estado do espelhamento de `device`, acompanhado (pede o atual ao abrir). */
export function useMirrorStatus(device: string | null): MirrorStatus | undefined {
  useEffect(() => {
    listenMirrorStatus();
    listenMirrorSession();
    if (device) {
      iphoneMirrorStatus(device).then((s) => s && setStatus(s)).catch(() => undefined);
      iphoneMirrorSessionPaused(device).then((paused) => setMirrorDisconnected(device, paused)).catch(() => undefined);
    }
  }, [device]);
  return useIphoneStore((s) => (device ? s.statuses[device] : undefined));
}
