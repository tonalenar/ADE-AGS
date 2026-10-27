/**
 * Comandos do painel lateral da aba ativa. Ver `src-tauri/src/session/panel.rs`.
 *
 * Como os `ipc.ts`, é o único lugar que conhece o nome dos comandos e a forma dos argumentos.
 * A conta vai como id (`tab.accountId`): o backend resolve a pasta dela, como em
 * `get_session_title`.
 */
import { invoke } from "@tauri-apps/api/core";

/** Quanto da janela de contexto a conversa atual ocupa. Só Claude Code e Codex. */
export interface ContextUsage {
  usedTokens: number;
  windowTokens: number;
  /** 0–100 (pode passar de 100 se a janela foi deduzida para baixo). */
  percent: number;
  model: string | null;
  updatedAtMs: number | null;
}

export type ConnectorScope = "user" | "project" | "local" | "ade";
export type ConnectorTransport = "stdio" | "http" | "sse";

/** Um servidor MCP configurado (configuração, não estado ao vivo). Sem env, headers nem args. */
export interface Connector {
  name: string;
  scope: ConnectorScope;
  transport: ConnectorTransport;
  /** Nome do binário (sem pasta) ou host da URL. */
  detail: string | null;
}

/** `null` para outros agentes, sessão sem transcript ou transcript ainda sem uso. */
export const tabContextUsage = (
  agentId: string,
  cwd: string,
  sessionId: string,
  accountId?: string | null,
) => invoke<ContextUsage | null>("tab_context_usage", { agentId, cwd, sessionId, accountId: accountId ?? null });

/**
 * Os MCP do agente nesta pasta. `tabId` deixa o backend achar o `--mcp-config` que o ADE
 * escreveu para a aba (escopo `ade`, só Claude Code). Agente desconhecido → `[]`.
 */
export const tabConnectors = (
  agentId: string,
  cwd: string,
  accountId?: string | null,
  tabId?: string | null,
) => invoke<Connector[]>("tab_connectors", { agentId, cwd, accountId: accountId ?? null, tabId: tabId ?? null });
