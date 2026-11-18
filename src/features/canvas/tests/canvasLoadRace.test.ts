import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => fake.invoke(...args),
}));

import { canvasActions, initCanvasSync, useCanvasStore } from "../store";
import type { Board } from "../board";

describe("edição enquanto o canvas carrega", () => {
  beforeEach(() => {
    fake.invoke.mockReset();
    useCanvasStore.setState({ boards: {}, loaded: false, loadError: null, saveError: null });
  });

  afterEach(() => vi.clearAllTimers());

  it("edicao_antes_do_load_preserva_dados_lidos", async () => {
    let finishLoad!: (boards: Record<string, Board>) => void;
    fake.invoke.mockImplementation((command: string) => {
      if (command === "canvas_load") return new Promise<Record<string, Board>>((resolve) => { finishLoad = resolve; });
      return Promise.resolve(undefined);
    });
    const key = "main|/projeto";
    const dispose = initCanvasSync("main");
    canvasActions.addThread(key, "thread:1");

    finishLoad({ [key]: { nodes: { salvo: { x: 1, y: 2 } }, notes: { "note-1": { name: "salva", content: "conteúdo", box: {} } } } as unknown as Board });
    await Promise.resolve();
    await Promise.resolve();

    const board = useCanvasStore.getState().boards[key];
    expect(board.nodes).toHaveProperty("salvo");
    expect(board.notes).toHaveProperty("note-1");
    expect(board.threads).toHaveProperty("thread:1");
    dispose();
  });
});
