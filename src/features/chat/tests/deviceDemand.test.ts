import { describe, expect, it } from "vitest";

import {
  canvasDeviceEngaged, deviceActionTitle, deviceControlEnabled, deviceTool, mirrorShouldAttach, shouldProbeDevices,
} from "../deviceDemand";

describe("aparelho sob demanda", () => {
  it("não busca nem conecta com o app montado e a superfície fechada", () => {
    expect(canvasDeviceEngaged("canvas", true)).toBe(false);
    expect(canvasDeviceEngaged("tabs", false)).toBe(false);
    expect(shouldProbeDevices(false, "macos", "ios-simulator")).toBe(false);
    expect(shouldProbeDevices(false, "macos", "ios-physical")).toBe(false);
    expect(shouldProbeDevices(false, "linux", "android")).toBe(false);
    expect(mirrorShouldAttach(false, false)).toBe(false);
  });

  it("começa quando a pessoa abre o canvas ou o painel", () => {
    expect(canvasDeviceEngaged("canvas", false)).toBe(true);
    expect(shouldProbeDevices(true, "macos", "ios-simulator")).toBe(true);
    expect(shouldProbeDevices(true, "macos", "ios-physical")).toBe(true);
    expect(shouldProbeDevices(true, "windows", "android")).toBe(true);
    expect(mirrorShouldAttach(false, true)).toBe(true);
  });

  it("depois de aberto, esconder não desliga o espelho já montado", () => {
    expect(mirrorShouldAttach(true, false)).toBe(true);
  });

  it("iOS fora do macOS não consulta o Xcode nem o CoreDevice", () => {
    expect(shouldProbeDevices(true, "windows", "ios-simulator")).toBe(false);
    expect(shouldProbeDevices(true, "linux", "ios-physical")).toBe(false);
  });
});

describe("ferramentas por host e tipo de aparelho", () => {
  it("no macOS o simulador gira e o físico busca Wi-Fi e pausa a sessão", () => {
    expect(deviceTool("macos", "ios-simulator", "rotate")).toEqual({ supported: true, reason: null });
    expect(deviceTool("macos", "ios-simulator", "wifiSearch").reason).toBe("chat.devices.unsupported.physicalOnly");
    expect(deviceTool("macos", "ios-physical", "wifiSearch")).toEqual({ supported: true, reason: null });
    expect(deviceTool("macos", "ios-physical", "sessionPause")).toEqual({ supported: true, reason: null });
    expect(deviceTool("macos", "ios-physical", "rotate").reason).toBe("chat.devices.unsupported.simulatorOnly");
  });

  it("no Windows e no Linux as ações de iOS ficam indisponíveis com a razão, e o Android segue", () => {
    expect(deviceTool("windows", "ios-simulator", "boot")).toEqual({ supported: false, reason: "chat.devices.unsupported.iosHost" });
    expect(deviceTool("linux", "ios-physical", "home")).toEqual({ supported: false, reason: "chat.devices.unsupported.iosHost" });
    expect(deviceTool("windows", "android", "back")).toEqual({ supported: true, reason: null });
    expect(deviceTool("linux", "android", "logcat")).toEqual({ supported: true, reason: null });
    expect(deviceTool("macos", "android", "biometric").reason).toBe("chat.devices.unsupported.iosOnly");
    expect(deviceTool("macos", "ios-simulator", "logcat").reason).toBe("chat.devices.unsupported.androidOnly");
  });

  it("o botão continua visível: o título junta a ação e a razão, e o clique fica desligado", () => {
    const tool = deviceTool("windows", "ios-simulator", "home");
    expect(deviceActionTitle("Início", "precisa do macOS")).toBe("Início — precisa do macOS");
    expect(deviceActionTitle("Início", null)).toBe("Início");
    expect(deviceControlEnabled(tool.supported, true)).toBe(false);
    expect(deviceControlEnabled(true, true)).toBe(true);
    expect(deviceControlEnabled(true, false)).toBe(false);
  });
});
