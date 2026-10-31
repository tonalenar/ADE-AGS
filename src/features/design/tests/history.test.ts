import { describe, expect, it } from "vitest";

import { createHistory } from "../history";

describe("desfazer e refazer", () => {
  it("desfaz e refaz em ordem; operação nova apaga o futuro", async () => {
    const log: string[] = [];
    const h = createHistory();
    const entry = (n: string) => ({ label: n, undo: async () => { log.push(`-${n}`); }, redo: async () => { log.push(`+${n}`); } });
    h.push(entry("a"));
    h.push(entry("b"));
    await h.undo();
    await h.undo();
    expect(await h.undo()).toBeNull();
    await h.redo();
    expect(log).toEqual(["-b", "-a", "+a"]);
    h.push(entry("c"));
    expect(h.canRedo()).toBe(false);
    expect(h.size).toEqual({ past: 2, future: 0 });
  });

  it("uma falha devolve a entrada à pilha de onde saiu", async () => {
    const h = createHistory();
    let fail = true;
    h.push({ label: "x", undo: async () => { if (fail) throw new Error("rede"); }, redo: async () => undefined });
    await expect(h.undo()).rejects.toThrow("rede");
    expect(h.canUndo()).toBe(true);
    fail = false;
    await h.undo();
    expect(h.canRedo()).toBe(true);
  });

  it("guarda no máximo o limite", () => {
    const h = createHistory(2);
    for (const n of ["a", "b", "c"]) h.push({ label: n, undo: async () => undefined, redo: async () => undefined });
    expect(h.size.past).toBe(2);
  });
});
