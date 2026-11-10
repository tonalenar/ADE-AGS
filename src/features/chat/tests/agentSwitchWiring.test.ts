import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf-8");

describe("a conversa por protocolo liga a troca de agente ao seletor", () => {
  const view = read("../structured/StructuredConversationView.tsx");

  it("o seletor mostra o trilho de agentes (não só o da conversa) e fica travado durante o turno", () => {
    expect(view).toMatch(/<AgentModelPicker agents=\{switchable\} showAccount=\{false\} disabled=\{locked\}/);
    expect(view).toContain("const locked = working || !!request;");
  });

  it("escolher OUTRO agente abre a confirmação (nada muda antes); o mesmo agente só troca o modelo", () => {
    expect(view).toMatch(/if \(v\.agentId && v\.agentId !== thread\.agentId\) \{ setSwitchError\(null\); setSwitchTo\(/);
    expect(view).toMatch(/retuneThread\(thread\.id, v\.model, v\.effort, thread\.access\);/);
  });

  it("confirmar chama a troca com o acesso atual (o backend corrige o que o agente novo não tem)", () => {
    expect(view).toMatch(/switchThreadAgent\(thread\.id, switchTo\.agentId, switchTo\.model, null, thread\.access\)/);
  });

  it("o comando existe no backend e está registrado", () => {
    expect(read("../structured/ipc.ts")).toContain('invoke<ThreadRow>("chat_thread_switch_agent"');
    expect(read("../../../../src-tauri/src/app/run.rs")).toContain("crate::conversa::chat_thread_switch_agent");
  });
});

describe("a TUI abre uma nova sessão ao trocar de provedor", () => {
  const view = read("../ConversationView.tsx");

  it("lista TUIs instaladas e prepara handoff somente a partir da timeline disponível", () => {
    expect(view).toContain("const available = detectedAgents.filter((candidate) => candidate.available && candidate.id !== \"bash\")");
    expect(view).toContain("handoff: timeline ? buildTuiAgentHandoff(items, card.agentLabel, target.label) : null");
  });

  it("pede confirmação e abre outra aba sem reiniciar nem fechar a sessão de origem", () => {
    expect(view).toContain('mode="newTui" hasContext={!!switchTo.handoff}');
    expect(view).toContain("startConversation({");
    expect(view).toContain("agent: switchTo.agent,");
    expect(view).not.toContain("closeTab(card.tabId)");
    expect(view).not.toContain("restartAgent(card.tabId)");
  });
});
