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
});
