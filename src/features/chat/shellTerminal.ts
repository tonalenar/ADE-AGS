import { agentSearchPath } from "@/features/agents/ipc";
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

/**
 * O comando do shell de login da pessoa (`"$SHELL" -l`, o zsh no macOS), ou `null` se o sistema não tem um (Windows:
 * fica o terminal padrão do app). O agente de shell do app roda `bash`, e no macOS isso abria o bash 3.2 com o aviso
 * «The default interactive shell is now zsh». Lido uma vez (é o mesmo `$SHELL` que montou o PATH do app).
 */
let loginShell: Promise<string | null> | null = null;
export function loginShellCommand(): Promise<string | null> {
  loginShell ??= agentSearchPath().then((r) => (r.shell ? `"${r.shell}" -l` : null), () => null);
  return loginShell;
}

/** Esquece o shell lido (testes). */
export function resetLoginShell(): void {
  loginShell = null;
}

// Uma criação por pasta de cada vez: dois pedidos seguidos (o efeito montando duas vezes, o Rodar logo depois de
// abrir) davam duas abas de shell, e o painel mostrava duas cópias do banner.
const creating = new Map<string, Promise<string>>();

/** A aba de shell da pasta, criada se ainda não houver. Criar não troca a conversa aberta (a aba ativa fica). */
export function ensureShellTab(cwd: string): Promise<string> {
  const inFlight = creating.get(cwd);
  if (inFlight) return inFlight;
  const made = loginShellCommand().then((command) => {
    const tabs = useTabsStore.getState();
    const existing = findShellTab(tabs.tabs, cwd, command);
    if (existing) return existing;
    const before = tabs.activeTabId;
    const base: AgentInfo = tabs.detectedAgents.find((a) => a.id === SHELL_AGENT_ID)
      ?? { id: SHELL_AGENT_ID, label: "Terminal", command: SHELL_AGENT_ID, available: true };
    const agent: AgentInfo = command ? { ...base, label: "Terminal", command } : base;
    const id = tabs.addTab({ cwd, agent });
    // O `addTab` ativa a aba nova; no chat a aba ativa é a conversa aberta, que não muda por isso.
    if (before !== null) useTabsStore.setState({ activeTabId: before });
    return id;
  }).finally(() => creating.delete(cwd));
  creating.set(cwd, made);
  return made;
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
  openShellPanel();
  void ensureShellTab(cwd).then((tabId) => {
    // Shell já vivo: vai direto. Recém-criado: espera o prompt aparecer e assentar.
    if (!runInTerminal(tabId, command)) sendWhenReady(tabId, command);
  });
}
