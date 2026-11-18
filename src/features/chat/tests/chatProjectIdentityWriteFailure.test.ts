// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { useBotToastStore } from "@/shared/brand/botToastStore";

import { setChatProjectIdentity } from "../chatProjectIdentity";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); useBotToastStore.setState({ toasts: [] }); });

describe("a identidade do projeto avisa quando o armazenamento local recusa a gravação", () => {
  it("localStorage cheio: a pessoa vê um aviso de que a mudança não ficou salva", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("cheio", "QuotaExceededError"); });
    setChatProjectIdentity("/p/a", { known: true, name: "Alfa" });
    expect(useBotToastStore.getState().toasts).toContainEqual(expect.objectContaining({ tone: "warning" }));
  });
});
