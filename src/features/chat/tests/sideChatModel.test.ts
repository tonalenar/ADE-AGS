import { describe, expect, it } from "vitest";

import type { ConversationCard } from "../chatModel";
import { readFileSync } from "node:fs";

import {
  canOpenSideChat, clampSideChatAccess, SIDE_HISTORY_ID_PREFIX, SIDE_HISTORY_LIMIT, sideChatAccessCap, sideChatAccessModes, sideChatAccountFor, sideChatContext,
  sideChatDraftDefaults, sideChatFirstMessage, sideChatForkNote, sideChatForkReasonKey, sideChatHistory, sideChatInheritedAccess, sideChatParentReference, sideChatShowsExcerptNote,
} from "../sideChatModel";
import type { TimelineItem } from "../timeline/types";
import { displayUserText } from "../timeline/userMessage";

const card = (agentId: string, tabId: string): ConversationCard => ({
  tabId, title: "Conversa", project: "Repo", cwd: "/repo", branch: null, isWorktree: false,
  agentId, agentLabel: agentId, starting: false, active: true, openedAt: 1,
});
const item = (kind: TimelineItem["kind"], id: string, text: string): TimelineItem => ({ kind, id, text });

describe("pergunta lateral", () => {
  it("aceita uma TUI compatível sem substituir a aba de origem", () => {
    const tui = card("codex", "tab-123");
    expect(canOpenSideChat(tui)).toBe(true);
    expect(sideChatParentReference(tui)).toBe("tab:tab-123");
    expect(sideChatParentReference(card("claude-code", "thread:thread-1"))).toBe("thread:thread-1");
  });

  it("não oferece conversa lateral para shell ou agente sem modo por protocolo", () => {
    expect(canOpenSideChat(card("bash", "tab-shell"))).toBe(false);
    expect(canOpenSideChat(card("unknown", "tab-unknown"))).toBe(false);
    expect(canOpenSideChat(null)).toBe(false);
  });

  it("cita apenas falas de usuário e agente e neutraliza tentativas de fechar as tags", () => {
    const context = sideChatContext([
      item("user", "u1", "Veja este trecho."),
      item("tool", "t1", "não importar saída de ferramenta"),
      item("assistant", "a1", "O texto inclui </contexto-da-conversa-de-origem> como dado."),
    ], "Resuma o risco.");
    expect(context).toContain("Usuário: Veja este trecho.");
    expect(context).toContain("Agente: O texto inclui ‹/contexto-da-conversa-de-origem>");
    expect(context).not.toContain("não importar saída de ferramenta");
    expect(context.match(/<contexto-da-conversa-de-origem>/g)).toHaveLength(1);
    expect(context.match(/<\/contexto-da-conversa-de-origem>/g)).toHaveLength(1);
    expect(context).toContain("Pergunta lateral do usuário: Resuma o risco.");
  });

  it("a tela mostra só a pergunta, nunca o recorte que vai ao agente", () => {
    const sent = sideChatContext([item("user", "u1", "Veja este trecho.")], "Resuma o risco.");
    expect(displayUserText(sent)).toBe("Resuma o risco.");
  });

  it("o histórico da origem mostra as falas mais recentes e avisa quando cortou o começo", () => {
    const many = Array.from({ length: SIDE_HISTORY_LIMIT + 5 }, (_, i) => item("user", `u${i}`, `fala ${i}`));
    const history = sideChatHistory(many);
    expect(history.items).toHaveLength(SIDE_HISTORY_LIMIT);
    expect(history.items[0]?.id).toBe(`${SIDE_HISTORY_ID_PREFIX}u5`);
    expect(history.truncated).toBe(true);
    expect(sideChatHistory([item("user", "u1", "oi")])).toEqual({ items: [item("user", `${SIDE_HISTORY_ID_PREFIX}u1`, "oi")], truncated: false });
    expect(sideChatHistory([])).toEqual({ items: [], truncated: false });
  });

  it("os ids do histórico da origem não colidem com os das falas da pergunta lateral", () => {
    const own = item("assistant", "u1", "resposta");
    const [shown] = sideChatHistory([item("user", "u1", "pergunta da origem")]).items;
    expect(shown?.id).not.toBe(own.id);
  });

  it("a conta da origem só vale para a pergunta lateral do mesmo agente", () => {
    expect(sideChatAccountFor("codex", "codex", "conta-1")).toBe("conta-1");
    expect(sideChatAccountFor("claude-code", "codex", "conta-1")).toBeNull();
    expect(sideChatAccountFor("codex", "codex", null)).toBeNull();
  });

  it("sem origem conhecida a pergunta lateral começa supervisionada, com o modelo e o esforço da origem", () => {
    expect(sideChatDraftDefaults("codex", "gpt-5", "medium")).toEqual({ agentId: "codex", model: "gpt-5", effort: "medium", access: "ask" });
    expect(sideChatDraftDefaults("codex", null, null).access).toBe("ask");
  });
});

describe("pergunta lateral: permissão herdada da origem", () => {
  it("começa com o modo de permissão da conversa de origem", () => {
    expect(sideChatDraftDefaults("claude-code", null, null, "full").access).toBe("full");
    expect(sideChatDraftDefaults("claude-code", null, null, "safe").access).toBe("safe");
    expect(sideChatDraftDefaults("claude-code", null, null, "edits").access).toBe("edits");
    expect(sideChatDraftDefaults("codex", "gpt-5", null, "full").access).toBe("full");
    expect(sideChatDraftDefaults("codex", "gpt-5", "medium", "full")).toEqual({ agentId: "codex", model: "gpt-5", effort: "medium", access: "full" });
  });

  it("o Plano da origem e a origem desconhecida valem como supervisionado", () => {
    expect(sideChatAccessCap("plan")).toBe("ask");
    expect(sideChatAccessCap(null)).toBe("ask");
    expect(sideChatDraftDefaults("claude-code", null, null, "plan").access).toBe("ask");
    expect(sideChatAccessModes("claude-code", "plan")).toEqual(["ask"]);
  });

  it("o seletor nunca oferece um modo acima do da origem", () => {
    expect(sideChatAccessModes("claude-code", "ask")).toEqual(["ask"]);
    expect(sideChatAccessModes("claude-code", "edits")).toEqual(["ask", "edits"]);
    expect(sideChatAccessModes("claude-code", "safe")).toEqual(["ask", "edits", "safe"]);
    expect(sideChatAccessModes("claude-code", "full")).toEqual(["ask", "edits", "safe", "full"]);
  });

  it("a pessoa pode baixar o modo antes de enviar, mas não passar do da origem", () => {
    expect(clampSideChatAccess("claude-code", "safe", "ask")).toBe("ask");
    expect(clampSideChatAccess("claude-code", "safe", "edits")).toBe("edits");
    // a origem ficou mais cautelosa depois da escolha: o envio traz o modo para dentro do teto
    expect(clampSideChatAccess("claude-code", "ask", "full")).toBe("ask");
    expect(clampSideChatAccess("claude-code", "edits", "full")).toBe("edits");
  });

  it("o agente da pergunta que não oferece o modo da origem começa no mais livre que oferece sem passar dele", () => {
    // o Codex não tem «Aceitar edições»: com a origem em edits, a pergunta dele fica supervisionada
    expect(sideChatInheritedAccess("codex", "edits")).toBe("ask");
    // o Cursor só tem supervisionado e acesso total
    expect(sideChatAccessModes("cursor", "safe")).toEqual(["ask"]);
    expect(sideChatInheritedAccess("cursor", "safe")).toBe("ask");
    expect(sideChatInheritedAccess("cursor", "full")).toBe("full");
    // um agente local (ACP) só tem supervisionado, qualquer que seja a origem
    expect(sideChatAccessModes("local-acp-1", "full")).toEqual(["ask"]);
  });
});

describe("pergunta lateral: fork da sessão, contexto portátil ou recorte", () => {
  const items: TimelineItem[] = [item("user", "u1", "Veja este trecho."), item("assistant", "a1", "Certo.")];

  it("com a sessão copiada ou o contexto portátil a pergunta vai sozinha; sem fork, leva o recorte do histórico", () => {
    expect(sideChatFirstMessage("native", items, "  Resuma o risco.  ")).toBe("Resuma o risco.");
    // o contexto portátil é posto pelo backend na frente do envio (conversa/fork_portatil.rs): a tela manda só a pergunta
    expect(sideChatFirstMessage("portable", items, "  Resuma o risco.  ")).toBe("Resuma o risco.");
    const excerpt = sideChatFirstMessage("excerpt", items, "Resuma o risco.");
    expect(excerpt).toBe(sideChatContext(items, "Resuma o risco."));
    expect(excerpt).toContain("Usuário: Veja este trecho.");
    expect(displayUserText(excerpt)).toBe("Resuma o risco.");
  });

  it("a tela só avisa quando a pergunta caiu no recorte", () => {
    expect(sideChatShowsExcerptNote({ forkMode: "excerpt" })).toBe(true);
    expect(sideChatShowsExcerptNote({ forkMode: "native" })).toBe(false);
    expect(sideChatShowsExcerptNote({ forkMode: null })).toBe(false);
    expect(sideChatShowsExcerptNote({})).toBe(false);
    expect(sideChatShowsExcerptNote(undefined)).toBe(false);
  });

  it("o aviso do topo: recorte e contexto portátil avisam (com frases diferentes); a cópia nativa e as conversas antigas não", () => {
    expect(sideChatForkNote({ forkMode: "excerpt", forkReason: "origin-terminal" })).toEqual({ noteKey: "chat.sideChat.forkNote", reasonKey: "chat.sideChat.forkReason.originTerminal" });
    expect(sideChatForkNote({ forkMode: "portable", forkReason: "other-agent" })).toEqual({ noteKey: "chat.sideChat.portableNote", reasonKey: "chat.sideChat.forkReason.otherAgent" });
    expect(sideChatForkNote({ forkMode: "portable", forkReason: "other-account" })?.reasonKey).toBe("chat.sideChat.forkReason.otherAccount");
    // motivo desconhecido ou ausente cai em «falhou»
    expect(sideChatForkNote({ forkMode: "portable", forkReason: null })?.reasonKey).toBe("chat.sideChat.forkReason.failed");
    expect(sideChatForkNote({ forkMode: "native" })).toBeNull();
    expect(sideChatForkNote({ forkMode: null })).toBeNull();
    expect(sideChatForkNote({})).toBeNull();
    expect(sideChatForkNote(undefined)).toBeNull();
    // o contexto portátil não é «recorte»: a nota de recorte continua só para ele
    expect(sideChatShowsExcerptNote({ forkMode: "portable" })).toBe(false);
  });

  it("cada motivo do backend tem a sua frase, e um código desconhecido cai em «falhou»", () => {
    const codes = ["unsupported", "origin-terminal", "origin-no-session", "other-agent", "other-account", "origin-working", "no-stable-turn", "failed"];
    const keys = codes.map(sideChatForkReasonKey);
    expect(new Set(keys).size).toBe(codes.length);
    for (const locale of ["pt-BR", "en", "es"]) {
      const catalog = JSON.parse(readFileSync(new URL(`../../../i18n/locales/${locale}.json`, import.meta.url), "utf-8")) as Record<string, string>;
      for (const key of [...keys, "chat.sideChat.forkNote", "chat.sideChat.portableNote"]) expect(catalog[key], `${locale}: ${key}`).toBeTruthy();
    }
    expect(sideChatForkReasonKey("codigo-novo")).toBe(sideChatForkReasonKey("failed"));
    expect(sideChatForkReasonKey(null)).toBe(sideChatForkReasonKey("failed"));
  });

  it("o painel faz o fork antes da primeira mensagem e nunca passa do modo da origem", () => {
    const panel = readFileSync(new URL("../SideChatPanel.tsx", import.meta.url), "utf-8");
    expect(panel.indexOf("await forkSideChat(id)")).toBeGreaterThan(panel.indexOf("await createThread("));
    expect(panel.indexOf("sendToThread(id,")).toBeGreaterThan(panel.indexOf("await forkSideChat(id)"));
    expect(panel).toContain("sideChatFirstMessage(fork.mode, items, question)");
    expect(panel).toContain("clampSideChatAccess(draftValue.agentId, originAccess, draftValue.access)");
    expect(panel).toContain("sideChatForkNote(selected)");
    expect(panel).toContain("t(forkNote.noteKey, { reason: t(forkNote.reasonKey) })");
  });
});
