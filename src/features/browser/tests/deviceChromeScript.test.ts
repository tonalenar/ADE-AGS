// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import source from "../../../../src-tauri/src/real_browser/device_chrome.js?raw";

const labels = { back: "Voltar", reload: "Recarregar", menu: "Menu", tabs: "Abas", address: "Endereço", share: "Copiar", desktop: "Desktop" };
const run = (platform: "ios" | "android") =>
  new Function(source.split("__AGS_PLATFORM__").join(platform).split("__AGS_LABELS__").join(JSON.stringify(labels)))();
const stop = () => (window as { __agsDeviceChromeStop?: () => void }).__agsDeviceChromeStop?.();

afterEach(() => { stop(); document.body.innerHTML = ""; });

/** O conteúdo da moldura vive num shadow DOM fechado: o teste o lê pelo `innerHTML` capturado no attachShadow. */
function capture<T>(fn: () => T): { result: T; html: () => string } {
  let shadow: ShadowRoot | null = null;
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { shadow = original.call(this, { ...init, mode: "open" }); return shadow; };
  try {
    const result = fn();
    return { result, html: () => shadow?.innerHTML ?? "" };
  } finally {
    Element.prototype.attachShadow = original;
  }
}
const resize = (w: number, h: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: h });
  window.dispatchEvent(new Event("resize"));
};

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

  it("não desenha cantos pretos próprios: o recorte é só da máscara nativa", () => {
    for (const platform of ["ios", "android"] as const) {
      const { html } = capture(() => run(platform));
      expect(html()).not.toContain('class="corner"');
      stop();
    }
  });

  it("deitado, o iPhone mantém a barra de início e leva a ilha para a lateral esquerda", () => {
    const { html } = capture(() => run("ios"));
    resize(874, 402);
    const css = html();
    expect(css).toContain('class="home"');
    expect(css).not.toMatch(/\.land[^{]*\.home[^{]*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.land \.island\s*\{[^}]*left:\s*11px/);
    expect(css).toMatch(/\.land \.island\s*\{[^}]*width:\s*37px/);
    expect(css).toMatch(/\.land \.island\s*\{[^}]*height:\s*126px/);
    expect(css).toMatch(/\.land \.home\s*\{[^}]*width:\s*209px/);
    expect(document.getElementById("__ags-device-chrome")).not.toBeNull();
  });

  it("deitado, a alça de gestos do Android continua visível e a barra do Safari não estoura", () => {
    const { html } = capture(() => run("android"));
    resize(924, 412);
    expect(html()).not.toMatch(/\.land[^{]*\.gesture[^{]*\{[^}]*display:\s*none/);
    const ios = capture(() => { stop(); run("ios"); });
    expect(ios.html()).toMatch(/\.land \.bar\s*\{[^}]*width:\s*min\(420px,\s*calc\(100% - /);
  });
});
