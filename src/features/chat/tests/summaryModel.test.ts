import { describe, expect, it } from "vitest";

import type { ForgeItem } from "@/features/forge/types";

import {
  connectorsOf, contextOf, diffTotals, environmentOf, homeRelative, outputsFromItems, pickOutputs, pullTone, pullsOfBranch,
  SUMMARY_KEY,
} from "../summary/summaryModel";
import { PANEL_ENTRIES } from "../panelMenu";
import type { TimelineItem } from "../timeline/types";

const tool = (id: string, kind: TimelineItem["tool"], path?: string): TimelineItem => ({ kind: "tool", id, tool: kind, path, status: "done" });
const pull = (number: number, extra: Partial<ForgeItem> = {}): ForgeItem => ({
  number, title: `PR ${number}`, state: "open", draft: false, author: null, webUrl: `https://x/${number}`, createdAt: null, updatedAt: null,
  comments: null, labels: [], sourceBranch: "feat/a", targetBranch: "dev", ...extra,
});

describe("as saídas da conversa", () => {
  it("vêm dos arquivos que o agente criou ou editou, sem repetir, o mais novo primeiro", () => {
    const items = [
      tool("1", "write", "/r/docs/PLANO.md"),
      tool("2", "edit", "/r/src/a.ts"),
      tool("3", "read", "/r/src/lido.ts"),
      tool("4", "edit", "/r/docs/PLANO.md"),
      tool("5", "command"),
    ];
    expect(outputsFromItems(items)).toEqual([
      { path: "/r/docs/PLANO.md", name: "PLANO.md", kind: "doc", created: true },
      { path: "/r/src/a.ts", name: "a.ts", kind: "code", created: false },
    ]);
  });

  it("ignora ferramenta sem caminho e item que não é ferramenta", () => {
    expect(outputsFromItems([tool("1", "edit"), { kind: "assistant", id: "2", text: "oi" }])).toEqual([]);
  });

  it("mostra poucas e deixa o resto para o Mostrar mais", () => {
    const list = Array.from({ length: 7 }, (_, i) => ({ path: `/r/${i}.ts`, name: `${i}.ts`, kind: "code" as const, created: false }));
    expect(pickOutputs(list, false)).toMatchObject({ shown: list.slice(0, 4), hidden: 3 });
    expect(pickOutputs(list, true)).toMatchObject({ shown: list, hidden: 0 });
    expect(pickOutputs(list.slice(0, 4), false)).toMatchObject({ hidden: 0 });
  });
});

describe("as alterações", () => {
  it("somam as linhas do diff do worktree", () => {
    expect(diffTotals([{ added: 3, removed: 1 }, { added: 5, removed: 0 }])).toEqual({ files: 2, added: 8, removed: 1 });
    expect(diffTotals([])).toEqual({ files: 0, added: 0, removed: 0 });
  });

  it("os PRs da branch: só os dela, o número maior primeiro", () => {
    const list = [pull(1), pull(3), pull(2, { sourceBranch: "outra" }), pull(4, { sourceBranch: null })];
    expect(pullsOfBranch(list, "feat/a").map((p) => p.number)).toEqual([3, 1]);
    expect(pullsOfBranch(list, null)).toEqual([]);
  });

  it("o tom do PR pelo estado", () => {
    expect(pullTone(pull(1))).toBe("open");
    expect(pullTone(pull(1, { draft: true }))).toBe("draft");
    expect(pullTone(pull(1, { state: "merged" }))).toBe("merged");
    expect(pullTone(pull(1, { state: "closed" }))).toBe("closed");
  });
});

describe("o ambiente", () => {
  it("a pasta com o pai relativo à home e a branch", () => {
    expect(environmentOf({ cwd: "/Users/ton/Projects/ADE-AGS", branch: "combo/x", isWorktree: false }, "/Users/ton")).toEqual({
      place: "computer", folder: "ADE-AGS", parent: "~/Projects", branch: "combo/x",
    });
  });
  it("worktree é dito como worktree; sem branch, nada", () => {
    expect(environmentOf({ cwd: "/w/modo-chat", branch: "", isWorktree: true }, null)).toEqual({ place: "worktree", folder: "modo-chat", parent: "/w", branch: null });
  });
  it("homeRelative só troca a home inteira, com fronteira de pasta", () => {
    expect(homeRelative("/Users/ton/Projects", "/Users/ton")).toBe("~/Projects");
    expect(homeRelative("/Users/ton", "/Users/ton")).toBe("~");
    expect(homeRelative("/Users/tonalencar/x", "/Users/ton")).toBe("/Users/tonalencar/x");
    expect(homeRelative("C:\\Users\\ton\\p", "C:\\Users\\ton")).toBe("~/p");
  });
});

describe("o contexto e os conectores (sem inventar)", () => {
  it("sem número da conversa é 'não medido'; com tokens, os tokens (nunca uma porcentagem)", () => {
    expect(contextOf(null)).toEqual({ measured: false, tokens: null });
    expect(contextOf(0)).toEqual({ measured: false, tokens: null });
    expect(contextOf(88600)).toEqual({ measured: true, tokens: 88600 });
  });

  it("os conectores: o app (ags, navegador) só vale onde o agente recebe o MCP; o resto não é lido", () => {
    expect(connectorsOf(true)).toEqual([{ id: "ags", on: true }, { id: "browser", on: true }]);
    expect(connectorsOf(false)).toEqual([{ id: "ags", on: false }, { id: "browser", on: false }]);
  });
});

describe("o atalho do Resumo", () => {
  it("é o primeiro do menu e a tecla não conflita com nenhuma outra", () => {
    expect(PANEL_ENTRIES[0]).toMatchObject({ id: "summary", key: SUMMARY_KEY });
    expect(new Set(PANEL_ENTRIES.map((e) => e.key)).size).toBe(PANEL_ENTRIES.length);
  });
});
