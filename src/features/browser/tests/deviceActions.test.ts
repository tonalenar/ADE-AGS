import { describe, expect, it, vi } from "vitest";

import { deviceAction, runDeviceAction, type PhoneActions } from "../deviceActions";

const actions = (): PhoneActions => ({ back: vi.fn(), reload: vi.fn(), navigate: vi.fn(), newTab: vi.fn(), share: vi.fn(), desktop: vi.fn() });

describe("deviceAction", () => {
  it("aceita só os tipos da moldura, vindos do canal da ponte", () => {
    expect(deviceAction({ source: "ags-preview", type: "device:navigate", text: "  gatos " })).toEqual({ type: "navigate", text: "gatos" });
    expect(deviceAction({ source: "ags-preview", type: "device:tabs" })).toEqual({ type: "tabs" });
    expect(deviceAction({ source: "ags-preview", type: "device:desktop" })).toEqual({ type: "desktop" });
    expect(deviceAction({ source: "ags-preview", type: "device:share", url: "https://a.com/x" })).toEqual({ type: "share", url: "https://a.com/x" });
  });

  it("recusa o resto: outro canal, tipo desconhecido, texto vazio ou longo, link que não é http", () => {
    expect(deviceAction({ source: "site", type: "device:tabs" })).toBeNull();
    expect(deviceAction({ source: "ags-preview", type: "device:close" })).toBeNull();
    expect(deviceAction({ source: "ags-preview", type: "device:navigate", text: "   " })).toBeNull();
    expect(deviceAction({ source: "ags-preview", type: "device:navigate", text: "a".repeat(3000) })).toBeNull();
    expect(deviceAction({ source: "ags-preview", type: "device:share", url: "file:///etc/passwd" })).toBeNull();
    expect(deviceAction("device:tabs")).toBeNull();
    expect(deviceAction({ source: "ags-preview", type: "pick:on" })).toBeNull();
  });

  it("encaminha cada ação ao handler certo", () => {
    const a = actions();
    const copy = vi.fn();
    runDeviceAction({ type: "navigate", text: "gatos" }, a, copy);
    runDeviceAction({ type: "tabs" }, a, copy);
    runDeviceAction({ type: "share", url: "https://a.com" }, a, copy);
    runDeviceAction({ type: "desktop" }, a, copy);
    expect(a.navigate).toHaveBeenCalledWith("gatos");
    expect(a.newTab).toHaveBeenCalledOnce();
    expect(copy).toHaveBeenCalledWith("https://a.com");
    expect(a.desktop).toHaveBeenCalledOnce();
  });
});
