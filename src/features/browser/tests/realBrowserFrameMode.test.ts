// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { loadRuntime } from "./runtimeHarness";

describe("modo do runtime no frame nativo", () => {
  it("não instala os shims de storage do proxy quando a ponte existe sem binding de entrada", async () => {
    const nativeSetItem = Storage.prototype.setItem;
    Object.defineProperty(window, "__ags_bridge", { configurable: true, value: true });

    try {
      await loadRuntime("<main>login</main>");
      expect(Storage.prototype.setItem).toBe(nativeSetItem);
    } finally {
      delete (window as { __ags_bridge?: boolean }).__ags_bridge;
    }
  });

  it("no Chrome real, um fetch de outra origem sai como a página pediu, sem o desvio do proxy", async () => {
    const urls: string[] = [];
    const fake = ((input: RequestInfo | URL) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    Object.defineProperty(window, "__ags_bridge", { configurable: true, value: true });

    try {
      await loadRuntime("<main>login</main>", { fetch: fake });
      await window.fetch("https://unpkg.apple.com/@olympus/idms-login/asset-manifest.js");
      expect(urls).toEqual(["https://unpkg.apple.com/@olympus/idms-login/asset-manifest.js"]);
    } finally {
      delete (window as { __ags_bridge?: boolean }).__ags_bridge;
    }
  });
});
