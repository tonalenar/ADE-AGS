import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { installInputMarks } from "../terminalMarks";

/** Terminal de mentira: o Enter é disparado pelo teste, e cada marcador e decoração fica registrado para conferir o descarte. */
function falsoTerminal() {
  const marcadores: { dispose: ReturnType<typeof vi.fn> }[] = [];
  let aoDigitar: ((data: string) => void) | null = null;
  const buffer = { active: { type: "normal", baseY: 0, cursorY: 0 } };
  const term = {
    cols: 80,
    buffer,
    onData: (cb: (data: string) => void) => {
      aoDigitar = cb;
      return { dispose: vi.fn() };
    },
    registerMarker: () => {
      const marcador = { dispose: vi.fn() };
      marcadores.push(marcador);
      return marcador;
    },
    registerDecoration: () => ({ dispose: vi.fn(), onRender: vi.fn() }),
  };
  return {
    term: term as unknown as Terminal,
    enter(linha: number) {
      buffer.active.cursorY = linha;
      aoDigitar?.("\r");
    },
    marcadores,
  };
}

describe("marcas de Enter", () => {
  it("desmontar descarta o marcador de cada raia, e não só a decoração", () => {
    const t = falsoTerminal();
    const desmontar = installInputMarks(t.term, { line: "x" } as never);
    t.enter(0);
    t.enter(1);
    expect(t.marcadores).toHaveLength(2);
    desmontar();
    // Decoração e marcador são registros separados no xterm: soltar só a decoração deixa o marcador no buffer.
    for (const marcador of t.marcadores) expect(marcador.dispose).toHaveBeenCalled();
  });
});
