import { describe, expect, it } from "vitest";

import { activityOf, joinParts, summarizeTools } from "../timeline/workSummary";
import type { TimelineItem } from "../timeline/types";

const tool = (id: string, kind: TimelineItem["tool"], extra: Partial<TimelineItem> = {}): TimelineItem => ({ kind: "tool", id, tool: kind, status: "done", ...extra });
const cmd = (id: string, label: string, extra: Partial<TimelineItem> = {}) => tool(id, "command", { label, ...extra });

describe("o resumo do grupo de ferramentas", () => {
  it("conta por tipo, na ordem em que aparecem (o caso do print: 1 leitura que falhou e 14 comandos)", () => {
    const items = [
      tool("0", "read", { path: "/r/accountConnect.ts", status: "error" }),
      ...Array.from({ length: 14 }, (_, i) => cmd(String(i + 1), `git log -n ${i}`)),
    ];
    const s = summarizeTools(items);
    expect(s.parts).toEqual([{ kind: "read", count: 1 }, { kind: "command", count: 14 }]);
    expect(s.failed).toBe(1);
    expect(s.running).toBe(0);
  });

  it("a ordem é a da primeira aparição de cada tipo, não a da quantidade", () => {
    const s = summarizeTools([cmd("1", "ls"), tool("2", "edit", { path: "/a" }), cmd("3", "pwd"), tool("4", "read", { path: "/b" })]);
    expect(s.parts.map((p) => p.kind)).toEqual(["command", "edit", "read"]);
    expect(s.parts[0]).toEqual({ kind: "command", count: 2 });
  });

  it("arquivos contam uma vez cada, mesmo lidos ou editados várias vezes", () => {
    const s = summarizeTools([tool("1", "read", { path: "/a" }), tool("2", "read", { path: "/a" }), tool("3", "read", { path: "/b" }), tool("4", "edit", { path: "/a" }), tool("5", "edit", { path: "/a" })]);
    expect(s.parts).toEqual([{ kind: "read", count: 2 }, { kind: "edit", count: 1 }]);
  });

  it("erro e recusa contam como falha; o que ainda roda conta à parte", () => {
    const s = summarizeTools([cmd("1", "a", { status: "error" }), cmd("2", "b", { status: "denied" }), cmd("3", "c", { status: "running" }), cmd("4", "d")]);
    expect(s.failed).toBe(2);
    expect(s.running).toBe(1);
    expect(s.last?.id).toBe("4");
  });

  it("sem ferramentas não há partes", () => {
    expect(summarizeTools([])).toEqual({ parts: [], failed: 0, running: 0, last: null });
  });
});

describe("o texto do resumo", () => {
  it("junta com vírgula e põe a primeira letra em maiúscula", () => {
    expect(joinParts(["leu 1 arquivo", "rodou 13 comandos"])).toBe("Leu 1 arquivo, rodou 13 comandos");
    expect(joinParts(["rodou 2 comandos"])).toBe("Rodou 2 comandos");
    expect(joinParts([])).toBe("");
  });
});

describe("a atividade atual", () => {
  it("o último comando sem o invólucro do shell, numa linha só", () => {
    expect(activityOf(cmd("1", `/bin/zsh -lc "git log --all --oneline"`))).toBe("git log --all --oneline");
    expect(activityOf(cmd("1", `/bin/zsh -lc "python3 - <<'PY'\nprint(1)\nPY"`))).toBe("python3");
  });
  it("arquivo mostra só o nome; sem nada, vazio", () => {
    expect(activityOf(tool("1", "edit", { path: "/r/src/a.ts", label: "src/a.ts" }))).toBe("a.ts");
    expect(activityOf(tool("2", "search", { label: "TODO" }))).toBe("TODO");
    expect(activityOf(null)).toBe("");
  });
});
