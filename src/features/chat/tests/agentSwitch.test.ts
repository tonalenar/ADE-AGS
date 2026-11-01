import { describe, expect, it } from "vitest";

import { agentSwitchOf, voicesByItem } from "../timeline/agentSwitch";
import { displayUserText } from "../timeline/userMessage";
import type { TimelineItem } from "../timeline/types";

const notice = (id: string, payload: Record<string, unknown> | string): TimelineItem => ({
  kind: "notice", id, label: "agentSwitch", text: typeof payload === "string" ? payload : JSON.stringify(payload),
});
const said = (id: string): TimelineItem => ({ kind: "assistant", id, text: "resposta" });
const SWITCH = { from: "claude-code", to: "codex", fromLabel: "Claude Code", toLabel: "Codex", model: "gpt-6.1-sol", strategy: "full", accessChanged: false };

describe("o aviso «agora com Codex»", () => {
  it("lê o aviso gravado pelo backend", () => {
    expect(agentSwitchOf(notice("n", SWITCH))).toEqual({ from: "claude-code", to: "codex", fromLabel: "Claude Code", toLabel: "Codex", model: "gpt-6.1-sol", strategy: "full", accessChanged: false });
  });

  it("um aviso de outro tipo ou com texto quebrado não é uma troca (nada estoura)", () => {
    expect(agentSwitchOf({ kind: "notice", id: "x", label: "resumeLost", text: "{}" })).toBeNull();
    expect(agentSwitchOf(notice("n", "isto não é json"))).toBeNull();
    expect(agentSwitchOf(notice("n", { from: "a" }))).toBeNull();
    expect(agentSwitchOf({ kind: "assistant", id: "a", text: "x" })).toBeNull();
  });
});

describe("quem falou cada fala depois de trocar de agente", () => {
  const items: TimelineItem[] = [said("a1"), notice("n1", SWITCH), said("a2"), notice("n2", { ...SWITCH, from: "codex", to: "claude-code", fromLabel: "Codex", toLabel: "Claude Code", strategy: "delta" }), said("a3")];

  it("antes da primeira troca é o agente de antes; depois dela, o novo; na volta, o primeiro de novo", () => {
    const voices = voicesByItem(items);
    expect(voices.get("a1")).toEqual({ id: "claude-code", label: "Claude Code" });
    expect(voices.get("a2")).toEqual({ id: "codex", label: "Codex" });
    expect(voices.get("a3")).toEqual({ id: "claude-code", label: "Claude Code" });
  });

  it("sem troca nenhuma, o mapa é vazio (vale o agente da conversa)", () => {
    expect(voicesByItem([said("a1"), said("a2")]).size).toBe(0);
  });
});

describe("o resumo que acompanha a primeira mensagem depois da troca fica escondido", () => {
  const END = "[fim do contexto da conversa anterior]";
  const block = `[ADE AGS] Contexto da conversa anterior: ...\nPedido original: x\n${END}`;

  it("a tela mostra só a fala da pessoa", () => {
    expect(displayUserText(`${block}\n\ncontinue de onde parou`)).toBe("continue de onde parou");
  });

  it("só o resumo, sem fala da pessoa, não mostra nada", () => {
    expect(displayUserText(block)).toBeNull();
  });
});
