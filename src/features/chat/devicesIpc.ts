// Os controles dos aparelhos do painel direito (pranchetas 9 e 10). Ver `src-tauri/src/simulator/commands.rs`,
// `src-tauri/src/android.rs` e `src-tauri/src/ipc/commands/devices.rs` (o que os agentes podem usar).
import { invoke } from "@tauri-apps/api/core";

import type { AndroidInfo, SharedDevice } from "./devicesModel";

export const simulatorType = (udid: string, text: string) => invoke<void>("simulator_type", { udid, text });
/** Sem `mode` só lê; devolve a aparência atual. */
export const simulatorAppearance = (udid: string, mode?: "light" | "dark") => invoke<"light" | "dark">("simulator_appearance", { udid, mode: mode ?? null });
/** Sem coordenadas, limpa a localização simulada. */
export const simulatorLocation = (udid: string, lat: number | null, lon: number | null) => invoke<void>("simulator_location", { udid, lat, lon });
/** Devolve se o Face ID está cadastrado. */
export const simulatorBiometric = (udid: string, action: "state" | "enroll" | "unenroll" | "match" | "nomatch") =>
  invoke<boolean>("simulator_biometric", { udid, action });
export const simulatorForegroundApp = (udid: string) => invoke<string | null>("simulator_foreground_app", { udid });
export const simulatorRelaunch = (udid: string, bundle: string) => invoke<void>("simulator_relaunch", { udid, bundle });
/** A orientação que a ADE mandou por último (`portrait`, `landscapeLeft`…). */
export const simulatorOrientation = (udid: string) => invoke<string>("simulator_orientation", { udid });
export const simulatorRotate = (udid: string, direction: "left" | "right") => invoke<string>("simulator_rotate", { udid, direction });

export const androidInfo = (serial: string) => invoke<AndroidInfo>("android_info", { serial });
export const androidRotate = (serial: string) => invoke<number>("android_rotate", { serial });
export const androidLogcat = (serial: string, lines: number) => invoke<string>("android_logcat", { serial, lines });
export const androidScreenshot = (serial: string) => invoke<string>("android_screenshot", { serial });

/** Os aparelhos que o painel mostra, para os agentes alcançarem (`ags device`); `control` = a chave do painel. */
export const devicesShare = (devices: SharedDevice[], control: boolean) => invoke<void>("devices_share", { devices, control });
