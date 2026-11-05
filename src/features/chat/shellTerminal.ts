import { runInTerminal, sendWhenReady } from "@/features/terminal/terminalRegistry";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID, type AgentInfo } from "@/features/tabs/types";

import { findShellTab } from "./codeRun";
import { setRightPanel, useChatStore } from "./store";

/**
 * O terminal da conversa: uma aba de shell de verdade (PTY) na pasta da conversa, desenhada na aba Terminal do
 * painel direito. Como toda aba, quem a desenha é o `TerminalPanel` (ela nunca é montada no painel, só posicionada
 * por cima dele): trocar de conversa ou fechar o painel não mata o shell.
 */

/** A aba de shell da pasta, criada se ainda não houver. Criar não troca a conversa aberta (a aba ativa fica). */
export function ensureShellTab(cwd: string): string {
  const tabs = useTabsStore.getState();
  const existing = findShellTab(tabs.tabs, cwd);
  if (existing) return existing;
  const before = tabs.activeTabId;
  const agent: AgentInfo = tabs.detectedAgents.find((a) => a.id === SHELL_AGENT_ID)
    ?? { id: SHELL_AGENT_ID, label: "Terminal", command: SHELL_AGENT_ID, available: true };
  const id = tabs.addTab({ cwd, agent });
  // O `addTab` ativa a aba nova; no chat a aba ativa é a conversa aberta, que não muda por isso.
  if (before !== null) useTabsStore.setState({ activeTabId: before });
  return id;
}

/** Abre a aba Terminal do painel (o shell nasce nela, na pasta da conversa). */
export function openShellPanel(): void {
  if (useChatStore.getState().panel !== "shell") setRightPanel("shell");
}

/**
 * «Rodar» de um bloco de código: abre o terminal da conversa e manda o comando, com Enter. Só sai de um clique da
 * pessoa no botão do bloco; nada roda sozinho.
 */
export function runInShell(cwd: string, command: string): void {
  const tabId = ensureShellTab(cwd);
  openShellPanel();
  // Shell já vivo: vai direto. Recém-criado: espera o prompt aparecer e assentar.
  if (!runInTerminal(tabId, command)) sendWhenReady(tabId, command);
}
