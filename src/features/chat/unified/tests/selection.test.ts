import { describe, expect, it } from "vitest";

import { emptyBoard, type Board } from "@/features/canvas/board";

import { homeBoardKey, selectedRef } from "../selection";

const withThreads = (refs: string[]): Board => ({ ...emptyBoard(), threads: Object.fromEntries(refs.map((r) => [r, { x: 0, y: 0, w: 1, h: 1 }])) });
const withNodes = (ids: string[]): Board => ({ ...emptyBoard(), nodes: Object.fromEntries(ids.map((r) => [r, { x: 0, y: 0, w: 1, h: 1 }])) });
const cwdKey = (cwd: string) => `main|${cwd}`;

describe("selectedRef: a seleção única", () => {
  it("a conversa por protocolo aberta vence a aba ativa", () => {
    expect(selectedRef({ thread: "abc", activeTabId: "t1" })).toBe("thread:abc");
  });
  it("sem protocolo, a seleção é a aba ativa", () => {
    expect(selectedRef({ thread: null, activeTabId: "t1" })).toBe("t1");
  });
  it("nada aberto, nada selecionado", () => {
    expect(selectedRef({ thread: null, activeTabId: null })).toBeNull();
  });
});

describe("homeBoardKey: onde a conversa mora", () => {
  it("um canvas especial legado com o nó vence o canvas da pasta", () => {
    const boards = { "main|/a#c:old": withThreads(["thread:x"]), "main|/b": emptyBoard() };
    expect(homeBoardKey("thread:x", { boards, cwd: "/b", cwdKey })).toBe("main|/a#c:old");
  });
  it("(a) missão/projeto/comparação existentes vencem time e sessão", () => {
    for (const special of ["main|/a#m:9", "main|/a#c:project", "main|/a#cmp:run"]) {
      const boards = { "main|/a#s:t1": withNodes(["t1"]), [special]: withNodes(["t1"]) };
      expect(homeBoardKey("t1", { boards, cwd: "/a", teamBoardKey: "main|/a#s:lead", cwdKey })).toBe(special);
    }
  });
  it("(b) a conversa integrante herda o canvas da coroa antes de uma sessão antiga", () => {
    const boards = { "main|/b#s:thread:x": withThreads(["thread:x"]) };
    expect(homeBoardKey("thread:x", { boards, cwd: "/b", teamBoardKey: "main|/a#s:lead", cwdKey })).toBe("main|/a#s:lead");
  });
  it("(c) conserva uma sessão já existente", () => {
    const boards = { "main|/b#s:thread:x": withThreads(["thread:x"]) };
    expect(homeBoardKey("thread:x", { boards, cwd: "/b", cwdKey })).toBe("main|/b#s:thread:x");
  });
  it("(d) cria canvas próprios para duas conversas da mesma pasta", () => {
    expect(homeBoardKey("thread:x", { boards: {}, cwd: "/b", cwdKey })).toBe("main|/b#s:thread:x");
    expect(homeBoardKey("thread:y", { boards: {}, cwd: "/b", cwdKey })).toBe("main|/b#s:thread:y");
  });
});
