import { describe, expect, it } from "vitest";

import { portalStateOf } from "../portalState";

const load = (over: Partial<{ loadCount: number; ready: boolean; navigatingForMs: number | null }> = {}) =>
  ({ load: { loadCount: 2, ready: true, navigatingForMs: null, ...over } });

describe("estado do portal (1.6)", () => {
  it("cada situação tem seu estado e uma dica do que fazer", () => {
    expect(portalStateOf(load(), false).state).toBe("pronto");
    expect(portalStateOf(load({ navigatingForMs: 500 }), false).state).toBe("carregando");
    expect(portalStateOf(load({ ready: false }), false).state).toBe("carregando");
    expect(portalStateOf(load({ loadCount: 0 }), false)).toMatchObject({ state: "sem runtime" });
    expect(portalStateOf(undefined, false).state).toBe("oculto");
    expect(portalStateOf(load(), true).state).toBe("oculto");
  });

  it("a janela oculta vence qualquer outro estado", () => {
    expect(portalStateOf(load({ loadCount: 0 }), true).hint).toMatch(/traz/);
  });
});
