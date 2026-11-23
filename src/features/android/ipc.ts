/**
 * Comandos Tauri e observador compartilhado de dispositivos Android (`src-tauri/src/android.rs`).
 *
 * Um único relógio alimenta `DevicesPane` e todos os `DeviceNode` do canvas, com single-flight,
 * pausa quando a janela fica oculta e backoff quando o `adb`/`emulator` demora sob carga.
 */
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { startVisiblePolling, type VisiblePollHandle } from "@/shared/visiblePolling";

export interface AndroidDevice {
  serial: string;
  state: string;
  model: string;
}

export interface AndroidList {
  devices: AndroidDevice[];
  avds: string[];
  adb: boolean;
}

export interface AndroidFrame {
  png: string;
  width: number;
  height: number;
}

export const androidList = () => invoke<AndroidList>("android_list");
export const androidStartAvd = (name: string) => invoke<void>("android_start_avd", { name });
export const androidFrame = (serial: string) => invoke<AndroidFrame>("android_frame", { serial });
export const androidTap = (serial: string, x: number, y: number) =>
  invoke<void>("android_tap", { serial, x, y });
export const androidSwipe = (serial: string, x1: number, y1: number, x2: number, y2: number) =>
  invoke<void>("android_swipe", { serial, x1, y1, x2, y2 });
export const androidKey = (serial: string, keyName: string) =>
  invoke<void>("android_key", { serial, keyName });
export const androidText = (serial: string, text: string) =>
  invoke<void>("android_text", { serial, text });

export const ANDROID_LIST_BASE_MS = 4000;
export const ANDROID_LIST_SLOW_MS = 1500;
export const ANDROID_LIST_MAX_MS = 30_000;

/** Próximo intervalo da lista Android: 4 s normal; backoff até 30 s quando demora ou falha. */
export function nextAndroidListPollMs(info: { elapsedMs: number; failed: boolean; streak: number }): number {
  const { elapsedMs, failed, streak } = info;
  if (!failed && elapsedMs < ANDROID_LIST_SLOW_MS) return ANDROID_LIST_BASE_MS;
  const step = Math.max(1, streak);
  const exp = ANDROID_LIST_BASE_MS * 2 ** Math.min(step, 3);
  const proportional = elapsedMs >= ANDROID_LIST_SLOW_MS ? Math.round(elapsedMs * 3) : 0;
  return Math.min(ANDROID_LIST_MAX_MS, Math.max(exp, proportional));
}

interface AndroidListState {
  list: AndroidList | null;
  loaded: boolean;
}

export const useAndroidListStore = create<AndroidListState>(() => ({ list: null, loaded: false }));

let inflight: Promise<void> | null = null;

/** Relê `android_list` com single-flight; `force` agenda uma leitura fresca após a atual. */
export function refreshAndroidList(force = false): Promise<void> {
  if (inflight && !force) return inflight;
  const previous = inflight;
  let request!: Promise<void>;
  request = (async () => {
    if (previous) await previous.catch(() => undefined);
    const list = await androidList();
    useAndroidListStore.setState({ list, loaded: true });
  })().finally(() => {
    if (inflight === request) inflight = null;
  });
  inflight = request;
  return request;
}

let watchers = 0;
let pollHandle: VisiblePollHandle | null = null;

/** Mantém `android_list` atualizado enquanto houver pelo menos um painel ou nó Android ativo. */
export function watchAndroidList(): () => void {
  watchers += 1;
  if (watchers === 1) {
    pollHandle = startVisiblePolling(
      () => refreshAndroidList(),
      nextAndroidListPollMs,
      { immediate: true, isSlow: (ms) => ms >= ANDROID_LIST_SLOW_MS },
    );
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers -= 1;
    if (watchers === 0) {
      pollHandle?.stop();
      pollHandle = null;
    }
  };
}

/** Lista compartilhada de dispositivos e AVDs Android; só mantém o polling enquanto `active`. */
export function useAndroidList(active = true): AndroidList | null {
  useEffect(() => (active ? watchAndroidList() : undefined), [active]);
  return useAndroidListStore((s) => s.list);
}
