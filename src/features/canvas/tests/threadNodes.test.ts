import { describe, expect, it } from "vitest";

import { addThreadNode, emptyBoard, overlaps, reconcile, removeThreadNode, THREAD_SIZE, type Board } from "../board";

const box = (x: number, y: number, w = 760, h = 460) => ({ x, y, w, h });

describe("nó de conversa por protocolo no canvas", () => {
  it("o canvas vazio nasce com `threads` vazio", () => {
    expect(emptyBoard().threads).toEqual({});
  });

  it("addThreadNode cria o nó com o tamanho padrão e é idempotente", () => {
    const once = addThreadNode(emptyBoard(), "thread:a");
    expect(once.threads["thread:a"]).toMatchObject({ w: THREAD_SIZE.w, h: THREAD_SIZE.h });
    expect(addThreadNode(once, "thread:a")).toBe(once);
  });

  it("não sobrepõe terminais, notas, portais nem outras conversas", () => {
    let b: Board = { ...emptyBoard(), nodes: { t1: box(0, 0), t2: box(816, 0) } };
    b = { ...b, notes: { "note-1": { name: "n", content: "", box: box(0, 516, 300, 200) } } };
    b = { ...b, portals: { "portal-1": { name: "p", url: "", box: box(1632, 0, 400, 300) } } };
    for (const id of ["thread:a", "thread:b", "thread:c"]) b = addThreadNode(b, id);
    const boxes = [
      ...Object.values(b.nodes), ...Object.values(b.notes).map((n) => n.box), ...Object.values(b.portals).map((p) => p.box),
      ...Object.values(b.threads),
    ];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false);
    expect(Object.keys(b.threads)).toHaveLength(3);
  });

  it("removeThreadNode tira só o nó", () => {
    const b = addThreadNode(emptyBoard(), "thread:a");
    const gone = removeThreadNode(b, "thread:a");
    expect(gone.threads).toEqual({});
    expect(removeThreadNode(gone, "thread:a")).toBe(gone);
  });

  it("reconcile mantém o nó e a corda de thread: sem aba nenhuma", () => {
    let b = addThreadNode({ ...emptyBoard(), nodes: { t1: box(0, 0) } }, "thread:a");
    b = { ...b, edges: [{ id: "e", a: "t1", b: "thread:a" }], orchestrators: ["thread:a"] };
    const next = reconcile(b, ["t1"]);
    expect(next.threads["thread:a"]).toEqual(b.threads["thread:a"]);
    expect(next.edges).toHaveLength(1);
    expect(next.orchestrators).toEqual(["thread:a"]);
  });

  it("reconcile não coloca uma aba nova em cima do nó da conversa", () => {
    const b = addThreadNode(emptyBoard(), "thread:a");
    const next = reconcile(b, ["t1"]);
    expect(overlaps(next.nodes.t1, next.threads["thread:a"])).toBe(false);
    expect(next.threads).toEqual(b.threads);
  });

  it("reconcile com `liveThreads` descarta o nó de conversa que não existe mais, mas não a de fora", () => {
    let b = addThreadNode(addThreadNode(emptyBoard(), "thread:a"), "thread:b");
    b = { ...b, edges: [{ id: "e", a: "thread:a", b: "thread:b" }] };
    const next = reconcile(b, [], [], new Set(["thread:a"]));
    expect(Object.keys(next.threads)).toEqual(["thread:a"]);
    // Sem a lista (ainda não carregou): nada some.
    expect(reconcile(b, [], [])).toBe(b);
  });
});
