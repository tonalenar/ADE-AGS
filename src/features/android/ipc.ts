import { invoke } from "@tauri-apps/api/core";

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

/** Aparelhos e AVDs vistos pelo `adb` (`ipc/commands/android.rs`, `android_list`). */
export const androidList = () => invoke<AndroidList>("android_list");

/** Um quadro da tela (`screencap`) em PNG base64. */
export const androidFrame = (serial: string) => invoke<AndroidFrame>("android_frame", { serial });

export const androidSwipe = (serial: string, x1: number, y1: number, x2: number, y2: number) =>
  invoke<void>("android_swipe", { serial, x1, y1, x2, y2 });

export const androidTap = (serial: string, x: number, y: number) => invoke<void>("android_tap", { serial, x, y });

export const androidKey = (serial: string, keyName: string) => invoke<void>("android_key", { serial, keyName });

export const androidText = (serial: string, text: string) => invoke<void>("android_text", { serial, text });

export const androidStartAvd = (name: string) => invoke<void>("android_start_avd", { name });
