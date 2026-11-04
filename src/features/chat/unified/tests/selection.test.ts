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
  it("o canvas que já tem o nó dela", () => {
    const boards = { "main|/a": withThreads(["thread:x"]), "main|/b": emptyBoard() };
    expect(homeBoardKey("thread:x", { boards, cwd: "/b", cwdKey })).toBe("main|/a");
  });
  it("o canvas especial (missão) vence o da pasta", () => {
    const boards = { "main|/a": withNodes(["t1"]), "main|/a#m:9": withNodes(["t1"]) };
    expect(homeBoardKey("t1", { boards, cwd: "/a", cwdKey })).toBe("main|/a#m:9");
  });
  it("sem nó, onde está a coroa do time", () => {
    expect(homeBoardKey("thread:x", { boards: {}, cwd: "/b", teamBoardKey: "main|/a#c:1", cwdKey })).toBe("main|/a#c:1");
  });
  it("sem nada, a pasta do cwd", () => {
    expect(homeBoardKey("thread:x", { boards: {}, cwd: "/b", cwdKey })).toBe("main|/b");
  });
});
