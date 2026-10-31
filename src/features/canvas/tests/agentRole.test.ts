import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MESSAGE_RULES, roleBriefing, type CanvasRole } from "../agentRole";

const roles: CanvasRole[] = [{ id: "qa", label: "QA", instructions: "Rode os testes." }];

describe("o briefing do papel e do subagente", () => {
  it("não manda responder o ask por `peer tell` nem avisar prontidão sem ser pedido", () => {
    for (const choice of [{ roleId: "qa", subagent: false }, { roleId: "qa", subagent: true }, { roleId: null, subagent: true }]) {
      const text = roleBriefing(roles, choice) ?? "";
      expect(text, JSON.stringify(choice)).not.toContain("responda com `ags peer tell`");
      expect(text, JSON.stringify(choice)).toContain("VOLTA SOZINHA a quem perguntou");
      expect(text, JSON.stringify(choice)).toContain("NÃO mande mensagens de prontidão, ciência ou progresso sem ser pedido");
      expect(text, JSON.stringify(choice)).toContain("O resumo da entrega vai uma vez só");
    }
  });

  it("mantém o papel e a frase do subagente", () => {
    const text = roleBriefing(roles, { roleId: "qa", subagent: true }) ?? "";
    expect(text).toContain("Seu papel neste time: QA — Rode os testes.");
    expect(text).toContain("Você é um subagente: execute as tarefas que o orquestrador enviar.");
    expect(roleBriefing(roles, { roleId: null, subagent: false })).toBeNull();
  });

  it("é a mesma regra do briefing do backend (chat_team/model.rs)", () => {
    const rust = readFileSync(join(__dirname, "../../../../src-tauri/src/chat_team/model.rs"), "utf8");
    const joined = rust.replace(/\\\n\s*/g, "");
    expect(joined).toContain(MESSAGE_RULES);
  });
});
