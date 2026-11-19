import { describe, expect, it } from "vitest";

import { settleAnchorSpace } from "../anchorSpace";

/** Aplica o cálculo como o efeito faz: cada mudança roda de novo, com o layout respondendo ao espaço. */
function run(layout: (space: number) => number, max = 50): { space: number; steps: number } {
  let space = 0;
  const seen: number[] = [];
  for (let steps = 0; steps < max; steps++) {
    const next = settleAnchorSpace(space, layout(space), seen);
    if (next === null) return { space, steps };
    seen.push(next);
    space = next;
  }
  return { space, steps: max };
}

describe("espaço da âncora do pedido enviado", () => {
  it("converge num passo quando o layout é estável", () => {
    expect(run(() => 300)).toEqual({ space: 300, steps: 1 });
  });

  it("não fica alternando quando o layout responde ao espaço (React #185)", () => {
    // Com espaço 0 o pedido precisa de 300; com 300 o layout sobe e pede 0 de novo.
    const result = run((space) => (space > 0 ? 0 : 300));
    expect(result.steps).toBeLessThan(50);
    expect(result.space).toBe(300);
  });

  it("para depois de muitos ajustes mesmo sem repetir valores", () => {
    expect(run((space) => space + 10).steps).toBeLessThanOrEqual(8);
  });

  it("ignora diferenças de até 2 px", () => {
    expect(settleAnchorSpace(100, 101.5, [])).toBeNull();
  });
});
