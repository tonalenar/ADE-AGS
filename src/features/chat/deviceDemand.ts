import type { DesktopOs } from "@/app/platform";

/** O tipo de aparelho que a superfície está mostrando. */
export type DeviceKind = "ios-simulator" | "ios-physical" | "android";

/** Ações dos painéis. A gravação de tela fica de fora: outro trabalho cobre esse botão. */
export type DeviceToolId =
  | "home"
  | "back"
  | "recents"
  | "rotate"
  | "screenshot"
  | "appearance"
  | "location"
  | "biometric"
  | "keyboard"
  | "clipboard"
  | "boot"
  | "lock"
  | "openUrl"
  | "lightMode"
  | "relaunch"
  | "appSwitcher"
  | "volume"
  | "logcat"
  | "power"
  | "startAvd"
  | "wifiSearch"
  | "sessionPause";

export type DeviceToolReason =
  | "chat.devices.unsupported.iosHost"
  | "chat.devices.unsupported.simulatorOnly"
  | "chat.devices.unsupported.physicalOnly"
  | "chat.devices.unsupported.androidOnly"
  | "chat.devices.unsupported.iosOnly";

/** O que o simulador do Xcode faz no macOS. A busca por Wi-Fi e a pausa da sessão ficam no aparelho físico. */
const SIMULATOR_MAC: readonly DeviceToolId[] = [
  "home", "rotate", "screenshot", "appearance", "location", "biometric", "keyboard",
  "clipboard", "boot", "lock", "openUrl", "lightMode", "relaunch",
];

/** O iPhone ou iPad físico no macOS. Girar por comando continua só no simulador. */
const PHYSICAL_MAC: readonly DeviceToolId[] = [
  "home", "screenshot", "keyboard", "lock", "appSwitcher", "volume", "wifiSearch", "sessionPause",
];

/** Android em qualquer host: o `adb` não depende do macOS. */
const ANDROID: readonly DeviceToolId[] = [
  "back", "home", "recents", "rotate", "screenshot", "keyboard", "volume", "logcat", "power", "startAvd",
];

/**
 * O canvas fica montado atrás do chat para não perder navegadores. Isso não abre o aparelho:
 * busca, conexão e espelho esperam o canvas na tela, ou o painel que a pessoa abriu.
 */
export function canvasDeviceEngaged(workMode: string, chatShell: boolean): boolean {
  return workMode === "canvas" && !chatShell;
}

/** Lista, sessão e quadros só com a superfície aberta. iOS no Windows ou no Linux nem chega a consultar. */
export function shouldProbeDevices(surfaceOpen: boolean, host: DesktopOs, kind: DeviceKind): boolean {
  if (!surfaceOpen) return false;
  if (kind === "android") return true;
  return host === "macos";
}

/** A NSView liga na primeira abertura e permanece montada: esconder a superfície pausa pela visibilidade, sem detach. */
export function mirrorShouldAttach(alreadyAttached: boolean, surfaceOpen: boolean): boolean {
  return alreadyAttached || surfaceOpen;
}

export function deviceTool(host: DesktopOs, kind: DeviceKind, id: DeviceToolId): { supported: boolean; reason: DeviceToolReason | null } {
  const allowed = kind === "android" ? ANDROID : kind === "ios-physical"
    ? (host === "macos" ? PHYSICAL_MAC : [])
    : (host === "macos" ? SIMULATOR_MAC : []);
  if (allowed.includes(id)) return { supported: true, reason: null };
  if (kind !== "android" && host !== "macos" && (SIMULATOR_MAC.includes(id) || PHYSICAL_MAC.includes(id) || ANDROID.includes(id))) {
    return { supported: false, reason: "chat.devices.unsupported.iosHost" };
  }
  if (kind === "android") {
    return {
      supported: false,
      reason: PHYSICAL_MAC.includes(id) && !SIMULATOR_MAC.includes(id)
        ? "chat.devices.unsupported.physicalOnly"
        : "chat.devices.unsupported.iosOnly",
    };
  }
  if (kind === "ios-simulator" && PHYSICAL_MAC.includes(id) && !SIMULATOR_MAC.includes(id)) {
    return { supported: false, reason: "chat.devices.unsupported.physicalOnly" };
  }
  if (kind === "ios-physical" && SIMULATOR_MAC.includes(id) && !PHYSICAL_MAC.includes(id)) {
    return { supported: false, reason: "chat.devices.unsupported.simulatorOnly" };
  }
  if (ANDROID.includes(id)) return { supported: false, reason: "chat.devices.unsupported.androidOnly" };
  return { supported: false, reason: "chat.devices.unsupported.iosHost" };
}

/** O nome da ação, com a razão quando o host ou o tipo de aparelho não a aceitam. */
export function deviceActionTitle(action: string, reason: string | null): string {
  return reason ? `${action} — ${reason}` : action;
}

export function deviceControlEnabled(supported: boolean, ready: boolean): boolean {
  return supported && ready;
}

/** O botão continua visível. `translate` resolve a chave da razão; no host certo o título é só a ação. */
export function presentDeviceTool(
  host: DesktopOs,
  kind: DeviceKind,
  id: DeviceToolId,
  ready: boolean,
  action: string,
  translate: (key: string) => string,
): { disabled: boolean; label: string } {
  const tool = deviceTool(host, kind, id);
  const reason = tool.reason ? translate(tool.reason) : null;
  return { disabled: !deviceControlEnabled(tool.supported, ready), label: deviceActionTitle(action, reason) };
}
