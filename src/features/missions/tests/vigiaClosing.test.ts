import { describe, expect, it } from "vitest";

import { asksToClose, prematureClosing } from "../vigiaClosing";

const ask = [
  "  - Google: os termos permitem guardar o endereço por no máximo 30 dias.",
  "",
  "  Posso fazer o commit, enviar a branch e abrir o PR?",
  "",
  "✻ Sautéed for 24s · done 10:15",
  "",
  "❯ pode fazer o commit, push e abrir o PR",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
];

describe("fechamento antecipado (Vigia)", () => {
  it("reconhece o Orquestrador pedindo o OK para commit/PR com o turno encerrado", () => {
    expect(asksToClose(ask)).toBe(true);
    expect(asksToClose(["Do you want me to proceed? Shall I commit and push?", "✻ Cooked for 3s · done 9:00"])).toBe(true);
  });

  it("não reconhece enquanto o Orquestrador ainda trabalha, nem texto comum", () => {
    expect(asksToClose([...ask, "✢ Perusing… (5m 14s · ↓ 23.7k tokens)", "  esc to interrupt"])).toBe(false);
    expect(asksToClose(["Corrigido: o lote recusado volta a ficar reservado.", "✻ Cooked for 7s · done 10:34"])).toBe(false);
    expect(asksToClose(null)).toBe(false);
  });

  it("a sugestão cinza da caixa de entrada não conta como pedido", () => {
    expect(asksToClose(["Resultado salvo.", "✻ Cooked for 2s · done 10:01", "❯ pode fazer o commit e abrir o PR"])).toBe(false);
  });

  it("avisa quando há integrante trabalhando ou devendo relatório", () => {
    const finding = prematureClosing({ leadLines: ask, members: [{ name: "Codex", working: true, owesReport: true }, { name: "QA", working: false, owesReport: false }] });
    expect(finding?.names).toEqual(["Codex"]);
    expect(finding?.nudge).toContain("Codex");
    expect(finding?.nudge).toContain("ags peer check");
    expect(finding?.stuck).toContain("ainda trabalha");
  });

  it("devendo relatório sem estar trabalhando, o aviso diz isso; vários nomes vão juntos", () => {
    const owes = prematureClosing({ leadLines: ask, members: [{ name: "Codex", working: false, owesReport: true }] });
    expect(owes?.stuck).toContain("ainda não entregou o relatório");
    const many = prematureClosing({ leadLines: ask, members: [{ name: "A", working: true, owesReport: true }, { name: "B", working: false, owesReport: true }] });
    expect(many?.names).toEqual(["A", "B"]);
    expect(many?.stuck).toContain("A, B");
  });

  it("não avisa se todos entregaram ou se o Orquestrador não pediu o OK", () => {
    expect(prematureClosing({ leadLines: ask, members: [{ name: "Codex", working: false, owesReport: false }] })).toBeNull();
    expect(prematureClosing({ leadLines: ["Trabalhando na tarefa."], members: [{ name: "Codex", working: true, owesReport: true }] })).toBeNull();
  });
});
