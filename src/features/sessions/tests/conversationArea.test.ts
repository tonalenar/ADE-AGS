import { describe, expect, it } from "vitest";

import { emptyBoard, moveTerminals, type Board } from "@/features/canvas/board";
import { conversationTitle, titleSources, type ConversationRow, type TerminalSnapshot } from "../conversationModel";
import { sameProject } from "../conversationsStore";

/** A conversa é a área de trabalho: o título vem do orquestrador e os terminais mudam de canvas inteiros. */

const tab = (id: string, openedAt: number, agentId = "claude-code") => ({ id, agentId, openedAt });

describe("de quem vem o título da conversa", () => {
  it("só do orquestrador, mesmo que um subagente tenha aberto antes", () => {
    const tabs = [tab("sub", 1), tab("orq", 2), tab("outro", 3)];
    expect(titleSources(tabs, { orchestrators: ["orq"], subagents: ["sub"] }).map((t) => t.id)).toEqual(["orq"]);
  });

  it("sem coroa, do primeiro agente aberto que não é subagente; nunca do shell", () => {
    const tabs = [tab("sh", 0, "bash"), tab("sub", 1), tab("b", 3), tab("a", 2)];
    expect(titleSources(tabs, { orchestrators: [], subagents: ["sub"] }).map((t) => t.id)).toEqual(["a"]);
    expect(titleSources([tab("sh", 0, "bash")], undefined)).toEqual([]);
  });

  it("ao salvar, sem título gravado, vale o do orquestrador e não o do primeiro terminal", () => {
    const base = { agentLabel: "", command: "", titleIsCustom: false, sessionId: null, accountId: null, prelaunch: [], skillIds: [], box: null, role: null };
    const terminals: TerminalSnapshot[] = [
      { ...base, agentId: "codex", title: "Tarefa: subir o MVP", orchestrator: false },
      { ...base, agentId: "claude-code", title: "Refatorar o checkout", orchestrator: true },
    ];
    const row = { title: null, customTitle: null } as unknown as ConversationRow;
    expect(conversationTitle(row, terminals)).toBe("Refatorar o checkout");
  });
});

describe("mover terminais para a conversa", () => {
  const box = (x: number) => ({ x, y: 0, w: 100, h: 80 });
  const from: Board = {
    ...emptyBoard(),
    nodes: { a: box(0), b: box(200), fica: box(400) },
    edges: [{ id: "e1", a: "a", b: "b" }, { id: "e2", a: "fica", b: "nota" }],
    orchestrators: ["a"],
    roles: { b: "Backend" },
    subagents: ["b"],
    viewport: { x: 10, y: 20, zoom: 0.8 },
  };

  it("leva lugar, ligações, coroa, papel e subagente; o que fica não muda", () => {
    const moved = moveTerminals(from, emptyBoard(), ["a", "b"]);
    expect(moved.to.nodes).toEqual({ a: box(0), b: box(200) });
    expect(moved.to.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(moved.to.orchestrators).toEqual(["a"]);
    expect(moved.to.roles).toEqual({ b: "Backend" });
    expect(moved.to.subagents).toEqual(["b"]);
    expect(moved.to.viewport).toEqual(from.viewport);
    expect(Object.keys(moved.from.nodes)).toEqual(["fica"]);
    expect(moved.from.edges.map((e) => e.id)).toEqual(["e2"]);
    expect(moved.from.orchestrators).toEqual([]);
  });

  it("num canvas que já tem terminais, a vista dele fica e nada se duplica", () => {
    const to: Board = { ...emptyBoard(), nodes: { x: box(0) }, edges: [{ id: "old", a: "b", b: "a" }], viewport: { x: 1, y: 1, zoom: 1 } };
    const moved = moveTerminals(from, to, ["a", "b"]);
    expect(moved.to.viewport).toEqual({ x: 1, y: 1, zoom: 1 });
    expect(moved.to.edges.map((e) => e.id)).toEqual(["old"]);
  });

  it("sem nada a mover, devolve os mesmos canvases", () => {
    const to = emptyBoard();
    const moved = moveTerminals(from, to, ["nao-existe"]);
    expect(moved.from).toBe(from);
    expect(moved.to).toBe(to);
  });
});

describe("a mesma área, venha a chave como vier", () => {
  it("a pasta com \\ e a raiz que o git devolve com / são o mesmo projeto", () => {
    expect(sameProject("C:\\Users\\eu\\proj", "c:/Users/eu/proj")).toBe(true);
    expect(sameProject("C:\\Users\\eu\\proj", "C:/Users/eu/outro")).toBe(false);
  });
});
