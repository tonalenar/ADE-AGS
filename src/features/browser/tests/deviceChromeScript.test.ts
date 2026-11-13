// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import source from "../../../../src-tauri/src/real_browser/device_chrome.js?raw";

const labels = { back: "Voltar", reload: "Recarregar", menu: "Menu", tabs: "Abas", address: "Endereço", share: "Copiar", desktop: "Desktop" };
const run = (platform: "ios" | "android") =>
  new Function(source.split("__AGS_PLATFORM__").join(platform).split("__AGS_LABELS__").join(JSON.stringify(labels)))();
const stop = () => (window as { __agsDeviceChromeStop?: () => void }).__agsDeviceChromeStop?.();

afterEach(() => stop());

describe("moldura do aparelho dentro da página", () => {
  it("entra e sai ao vivo, sem deixar a margem nem o hospedeiro para trás", () => {
    run("ios");
    expect(document.getElementById("__ags-device-chrome")).not.toBeNull();
    stop();
    expect(document.getElementById("__ags-device-chrome")).toBeNull();
    expect(document.querySelectorAll("style").length).toBe(0);
  });

  it("trocar de aparelho substitui a moldura anterior", () => {
    run("ios");
    run("android");
    expect(document.querySelectorAll("#__ags-device-chrome").length).toBe(1);
  });
});
