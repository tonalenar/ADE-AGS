import { describe, expect, it } from "vitest";

import { applyToolCallVisibility, isToolCallVisibility, type ToolCallVisibility } from "@/features/chat/timeline/toolCallVisibility";
import type { BodyRow, Turn } from "@/features/chat/timeline/timelineModel";
import type { TimelineItem, ToolKind, ToolStatus } from "@/features/chat/timeline/types";

const tool = (id: string, kind: ToolKind, status: ToolStatus, extra: Partial<TimelineItem> = {}): TimelineItem =>
  ({ kind: "tool", id, tool: kind, status, label: id, ...extra });

const fala = (id: string): TimelineItem => ({ kind: "assistant", id, text: id });

/** Um turno encerrado com o corpo dado e uma resposta final. */
function turnWith(body: BodyRow[]): Turn {
  return {
    key: "t1",
    user: { kind: "user", id: "u1", text: "faça" },
    body,
    final: fala("final"),
    end: { durationMs: 1000, interrupted: false, error: null, files: [] },
    plan: null,
  };
}

const work = (tools: TimelineItem[]): BodyRow => ({ type: "work", key: tools[0].id, tools });
const assistant = (item: TimelineItem): BodyRow => ({ type: "assistant", key: item.id, item });

/** Os ids das ferramentas que sobram no corpo, na ordem. */
function idsOf(turns: Turn[]): string[] {
  return turns.flatMap((turn) => turn.body.flatMap((row) => (row.type === "work" || row.type === "infra" ? row.tools.map((t) => t.id) : [])));
}

const mixed = turnWith([
  work([
    tool("ler", "read", "done"),
    tool("cmd-ok", "command", "done"),
    tool("cmd-rodando", "command", "running"),
    tool("cmd-erro", "command", "error"),
    tool("negada", "edit", "denied"),
    tool("plano", "todo", "done"),
    tool("sub", "task", "done"),
  ]),
  assistant(fala("no meio")),
  work([tool("edita", "edit", "done")]),
]);

describe("chamadas de ferramenta: o padrão mostra tudo", () => {
  it("showAll devolve os mesmos turnos, sem mexer", () => {
    const turns = [mixed];
    expect(applyToolCallVisibility(turns, "showAll")).toBe(turns);
  });
});

describe("chamadas de ferramenta: ocultar as bem-sucedidas", () => {
  it("some o que deu certo; falha, em andamento, plano e tarefa ficam", () => {
    const shown = idsOf(applyToolCallVisibility([mixed], "hideSuccessful"));
    expect(shown).toEqual(["cmd-rodando", "cmd-erro", "negada", "plano", "sub"]);
  });

  it("não derruba a fala do meio, que não é ferramenta", () => {
    const rows = applyToolCallVisibility([mixed], "hideSuccessful")[0].body;
    expect(rows.some((row) => row.type === "assistant")).toBe(true);
  });
});

describe("chamadas de ferramenta: ocultar todas", () => {
  it("some comando, edição, leitura e busca, de qualquer estado; erro, negação e plano ficam", () => {
    const shown = idsOf(applyToolCallVisibility([mixed], "hideAll"));
    expect(shown).toEqual(["cmd-erro", "negada", "plano", "sub"]);
  });

  it("uma linha de ferramentas sem nenhuma visível some do corpo", () => {
    const rows = applyToolCallVisibility([mixed], "hideAll")[0].body;
    expect(rows.map((row) => row.type)).toEqual(["work", "assistant"]);
  });

  it("uma pergunta sem resposta aparece sempre", () => {
    const question: TimelineItem = tool("pergunta", "question", "running", { question: { text: "?", options: [] } });
    const turn = turnWith([{ type: "question", key: "pergunta", item: question }]);
    expect(applyToolCallVisibility([turn], "hideAll")[0].body).toEqual(turn.body);
  });
});

describe("chamadas de ferramenta: zen", () => {
  it("mostra só a resposta final: some ferramenta e fala do meio", () => {
    const shown = applyToolCallVisibility([mixed], "zen")[0];
    expect(shown.body.map((row) => row.type)).toEqual(["work"]);
    expect(idsOf([shown])).toEqual(["cmd-erro", "negada", "plano", "sub"]);
    expect(shown.final?.id).toBe("final");
  });

  it("o desfecho e os arquivos alterados continuam no turno", () => {
    const turn: Turn = { ...mixed, end: { durationMs: 42, interrupted: false, error: "falhou", files: [{ path: "a.ts", added: 1, removed: 0 }] } };
    const shown = applyToolCallVisibility([turn], "zen")[0];
    expect(shown.end).toEqual(turn.end);
  });
});

describe("valores salvos de Chamadas de ferramenta", () => {
  it("só os quatro modos são válidos", () => {
    const valid: ToolCallVisibility[] = ["showAll", "hideSuccessful", "hideAll", "zen"];
    for (const mode of valid) expect(isToolCallVisibility(mode)).toBe(true);
    expect(isToolCallVisibility("hidden")).toBe(false);
  });
});

describe("o raciocínio nos modos de chamadas de ferramenta", () => {
  const reasoning = (id: string): BodyRow => ({ type: "reasoning", key: id, item: { kind: "reasoning", id, text: "pensando alto" } });
  const body = turnWith([reasoning("r1"), work([tool("ler", "read", "done")])]);

  it("fica em todos os modos, menos no zen (que mostra só as respostas finais)", () => {
    for (const mode of ["showAll", "hideSuccessful", "hideAll"] as ToolCallVisibility[]) {
      expect(applyToolCallVisibility([body], mode)[0]!.body.map((r) => r.type), mode).toContain("reasoning");
    }
    expect(applyToolCallVisibility([body], "zen")[0]!.body.map((r) => r.type)).toEqual([]);
  });
});
