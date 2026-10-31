import { describe, expect, it } from "vitest";

import { popPlacementCls } from "../DevicesPane";

describe("o painelzinho dos controles do aparelho", () => {
  it("o botão «mais», no pé da coluna, abre para cima (nunca para fora da janela)", () => {
    const cls = popPlacementCls("bottom", false);
    expect(cls).toContain("bottom-0");
    expect(cls).not.toContain("top-0");
  });

  it("os botões de cima abrem para baixo", () => {
    const cls = popPlacementCls("top", false);
    expect(cls).toContain("top-0");
    expect(cls).not.toContain("bottom-0");
  });

  it("a altura se limita à janela e rola por dentro, sem barra", () => {
    const cls = popPlacementCls("bottom", true);
    expect(cls).toContain("max-h-[calc(100vh-96px)]");
    expect(cls).toContain("overflow-y-auto");
    expect(cls).toContain("cc-scroll-hidden");
    expect(cls).toContain("w-[440px]");
  });
});
