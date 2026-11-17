/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";

import { createPrefStore } from "../prefStore";

describe("createPrefStore", () => {
  it("rele a chave quando outra aba dispara storage", () => {
    localStorage.clear();
    const store = createPrefStore({
      key: "cc-test-pref",
      defaults: { n: 1 },
      parse: (raw) => {
        if (raw && typeof raw === "object" && "n" in raw && typeof (raw as { n: unknown }).n === "number") {
          return { n: (raw as { n: number }).n };
        }
        return { n: 1 };
      },
    });
    store.save({ n: 2 });
    expect(store.read()).toEqual({ n: 2 });
    localStorage.setItem("cc-test-pref", JSON.stringify({ n: 9 }));
    window.dispatchEvent(new StorageEvent("storage", { key: "cc-test-pref", newValue: JSON.stringify({ n: 9 }) }));
    expect(store.read()).toEqual({ n: 9 });
  });
});
