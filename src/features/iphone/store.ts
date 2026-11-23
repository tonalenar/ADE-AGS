import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import { isDocumentHidden } from "@/shared/visiblePolling";

import { iphoneDevices, iphoneMirrorSessionPaused, iphoneMirrorStatus, IPHONE_SESSION_EVENT, IPHONE_STATUS_EVENT, type DiscoveryError } from "./ipc";
import { pickedPhysical, sortForPicker, type MirrorStatus, type PhysicalDevice, type Unavailable } from "./model";

interface IphoneState {
  devices: PhysicalDevice[];
  loaded: boolean;
  unavailable: Unavailable | null;
  /** Por que a última consulta da lista falhou (`null` = deu certo). Com `timeout`, a lista anterior continua. */
  discovery: DiscoveryError | null;
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

export const useIphoneStore = create<IphoneState>(() => ({ devices: [], loaded: false, unavailable: null, discovery: null, statuses: {}, disconnectedDevices: [], panelPick: readPick() }));

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

export const PHYSICAL_FAST_POLL_MS = 2000;
export const PHYSICAL_FAST_WINDOW_MS = 20_000;
export const PHYSICAL_STEADY_POLL_MS = 10_000;
export const PHYSICAL_SLOW_CALL_MS = 1000;
export const PHYSICAL_MAX_POLL_MS = 30_000;

/**
 * Intervalo até a próxima chamada ao `devicectl`:
 * - 2 s nos primeiros 20 s após abrir o seletor (aparelho recém-surgido no Wi-Fi);
 * - depois 10 s em regime estável;
 * - se a chamada anterior levou > 1 s (Mac carregado) ou deu timeout, aplica backoff até 30 s.
 */
export function nextPhysicalPollMs(info: {
  elapsedSinceStartMs: number;
  lastDurationMs: number;
  timedOut: boolean;
  timeoutStreak: number;
}): number {
  const { elapsedSinceStartMs, lastDurationMs, timedOut, timeoutStreak } = info;
  if (timedOut) {
    const step = Math.max(1, timeoutStreak);
    return Math.min(PHYSICAL_MAX_POLL_MS, PHYSICAL_STEADY_POLL_MS * 2 ** Math.min(step - 1, 2));
  }
  const base = elapsedSinceStartMs < PHYSICAL_FAST_WINDOW_MS ? PHYSICAL_FAST_POLL_MS : PHYSICAL_STEADY_POLL_MS;
  if (lastDurationMs > PHYSICAL_SLOW_CALL_MS) {
    return Math.min(PHYSICAL_MAX_POLL_MS, Math.max(base, 8000, Math.round(lastDurationMs * 4)));
  }
  return base;
}

let loading: Promise<void> | null = null;
let lastDurationMs = 0;
let lastTimedOut = false;
let timeoutStreak = 0;

/** Relê a lista do CoreDevice (`devicectl`, ~0,6 s). `force` agenda uma consulta fresca após a atual. */
export function refreshPhysical(force = false): Promise<void> {
  if (loading && !force) return loading;
  const previous = loading;
  let request!: Promise<void>;
  request = (async () => {
    if (previous) await previous;
    const started = Date.now();
    try {
      const list = await iphoneDevices();
      lastDurationMs = Math.max(0, Date.now() - started);
      if (list.error?.kind === "timeout") {
        lastTimedOut = true;
        timeoutStreak += 1;
        // Um `devicectl` lento não apaga a lista que a pessoa já via: mantém a última e só registra o atraso.
        useIphoneStore.setState({ discovery: list.error, loaded: true });
      } else {
        lastTimedOut = false;
        timeoutStreak = 0;
        useIphoneStore.setState({ devices: sortForPicker(list.devices), unavailable: list.unavailable, discovery: list.error, loaded: true });
      }
    } catch {
      lastDurationMs = Math.max(0, Date.now() - started);
      lastTimedOut = true;
      timeoutStreak += 1;
      useIphoneStore.setState({ loaded: true });
    }
  })().finally(() => {
    if (loading === request) loading = null;
  });
  loading = request;
  return request;
}

let watchers = 0;
let watchStartedAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let onVisibilityChange: (() => void) | null = null;

function clearWatchTimer() {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
}

function scheduleNextPhysical() {
  clearWatchTimer();
  if (watchers === 0 || isDocumentHidden()) return;
  const delay = nextPhysicalPollMs({
    elapsedSinceStartMs: Math.max(0, Date.now() - watchStartedAt),
    lastDurationMs,
    timedOut: lastTimedOut,
    timeoutStreak,
  });
  timer = setTimeout(() => {
    timer = undefined;
    void runWatchTick();
  }, delay);
}

async function runWatchTick() {
  if (watchers === 0 || isDocumentHidden()) return;
  clearWatchTimer();
  await refreshPhysical();
  scheduleNextPhysical();
}

/** Mantém a lista em dia enquanto algum seletor ou estado vazio está aberto; devolve o "parar". */
export function watchPhysical(): () => void {
  watchers += 1;
  if (watchers === 1) {
    watchStartedAt = Date.now();
    lastDurationMs = 0;
    lastTimedOut = false;
    timeoutStreak = 0;
    onVisibilityChange = () => {
      if (watchers === 0) return;
      if (isDocumentHidden()) {
        clearWatchTimer();
        return;
      }
      void runWatchTick();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    if (!isDocumentHidden()) {
      void runWatchTick();
    }
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers -= 1;
    if (watchers === 0) {
      clearWatchTimer();
      if (onVisibilityChange && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      onVisibilityChange = null;
    }
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

/** Aplica o estado que o backend devolveu. `null` quer dizer sem sessão: o último status sai, senão a barra segue
 *  "ao vivo" e o toque fica habilitado sem sessão. */
export function applyMirrorStatus(device: string, status: MirrorStatus | null) {
  if (status) {
    setStatus(status);
    return;
  }
  useIphoneStore.setState((s) => {
    const statuses = { ...s.statuses };
    delete statuses[device];
    return { statuses };
  });
}

/** O estado do espelhamento de `device`, acompanhado (pede o atual ao abrir). */
export function useMirrorStatus(device: string | null): MirrorStatus | undefined {
  useEffect(() => {
    listenMirrorStatus();
    listenMirrorSession();
    if (device) {
      iphoneMirrorStatus(device).then((s) => applyMirrorStatus(device, s)).catch(() => undefined);
      iphoneMirrorSessionPaused(device).then((paused) => setMirrorDisconnected(device, paused)).catch(() => undefined);
    }
  }, [device]);
  return useIphoneStore((s) => (device ? s.statuses[device] : undefined));
}
