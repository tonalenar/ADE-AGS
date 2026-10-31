import { withAutonomy } from "@/features/missions/autonomy";
import { withModel } from "@/features/missions/modelFlags";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import type { RepoGroup } from "@/features/workspaces/workspaceTree";

/**
 * O modelo do modo chat, sem React: o que a sidebar lista, como uma conversa se chama e com que
 * comando o agente dela arranca.
 *
 * Nesta etapa uma conversa É uma aba de agente (a TUI de verdade, num PTY). O composer escolhe a
 * pasta, o agente, o modelo, o esforço, a conta e a permissão, e o resto do app trata a aba como
 * qualquer outra: ela aparece nas abas, no canvas e na CLI.
 */

/** Até onde vai o título tirado do prompt. */
export const TITLE_MAX = 60;

/** O título da conversa: a primeira linha com texto do prompt, encurtada. `null` = prompt vazio. Pura. */
export function conversationTitle(prompt: string): string | null {
  const line = prompt.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).find((l) => l.length > 0);
  if (!line) return null;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

/**
 * As permissões da conversa, os quatro modos do T3 Code:
 * - `ask` (Supervisionado): o agente pergunta antes de comandos e edições;
 * - `edits` (Aceitar edições): edita sozinho e pergunta o resto;
 * - `safe` (Auto): o nível seguro das missões (`withAutonomy`);
 * - `full` (Acesso total): comandos e edições sem perguntar.
 */
export type ChatAccess = "ask" | "edits" | "safe" | "full";

export const ACCESS_MODES: ChatAccess[] = ["ask", "edits", "safe", "full"];

/** Os flags de cada modo, por agente, conferidos no `--help` de cada CLI. Sem entrada = o agente não tem o modo. */
const ACCESS_FLAGS: Record<Exclude<ChatAccess, "ask" | "safe">, Record<string, string>> = {
  edits: { "claude-code": "--permission-mode acceptEdits", "gemini-cli": "--approval-mode auto_edit" },
  full: { "claude-code": "--dangerously-skip-permissions", codex: "--dangerously-bypass-approvals-and-sandbox", "gemini-cli": "--yolo" },
};

/** O modo Plano (só planeja, não edita). Só o Claude Code tem flag de lançamento para isso. */
const PLAN_FLAG: Record<string, string> = { "claude-code": "--permission-mode plan" };

/** Os modos que este agente aceita. Supervisionado sempre (é não passar nada). Pura. */
export function accessModesFor(agentId: string): ChatAccess[] {
  return ACCESS_MODES.filter((mode) =>
    mode === "ask" || (mode === "safe" ? withAutonomy(agentId, "x", "safe") !== "x" : !!ACCESS_FLAGS[mode][agentId]));
}

export function planSupported(agentId: string): boolean {
  return agentId in PLAN_FLAG;
}

export interface LaunchChoice {
  /** `null` = o modelo padrão da TUI. */
  model: string | null;
  /** `null` = o esforço padrão da TUI. */
  effort: string | null;
  access: ChatAccess;
  /** Começa no modo Plano (onde o agente suporta). */
  plan?: boolean;
}

/** O comando com o modo de permissão (e o Plano, que no Claude é um modo de permissão e vence). Pura. */
export function withAccess(agentId: string, command: string, access: ChatAccess, plan = false): string {
  if (plan && PLAN_FLAG[agentId]) return `${command} ${PLAN_FLAG[agentId]}`;
  if (access === "ask") return command;
  if (access === "safe") return withAutonomy(agentId, command, "safe");
  const flag = ACCESS_FLAGS[access][agentId];
  // Um modo que o agente não tem cai no mais próximo que ele tem, sem nunca dar MAIS permissão.
  return flag ? `${command} ${flag}` : access === "edits" ? command : withAutonomy(agentId, command, "safe");
}

/** O modo que o comando de uma aba já fixa (o inverso de `withAccess`). Pura. */
export function readAccess(agentId: string, command: string): { access: ChatAccess; plan: boolean } {
  if (PLAN_FLAG[agentId] && command.includes(PLAN_FLAG[agentId])) return { access: "ask", plan: true };
  for (const mode of ["full", "edits"] as const) {
    const flag = ACCESS_FLAGS[mode][agentId];
    if (flag && command.includes(flag)) return { access: mode, plan: false };
  }
  const safe = withAutonomy(agentId, "", "safe").trim();
  return { access: safe && command.includes(safe) ? "safe" : "ask", plan: false };
}

/**
 * O comando da TUI com a escolha do composer: permissão (os flags das missões e os do T3), modelo
 * e esforço (`withModel`). Pura.
 */
export function chatCommand(agentId: string, command: string, choice: LaunchChoice): string {
  return withModel(agentId, withAccess(agentId, command, choice.access, choice.plan), choice.model, choice.effort);
}

/** Uma cor estável por projeto, para o quadradinho com a inicial (tokens do tema, nunca hex). Pura. */
const PROJECT_TONES = ["bg-accent-600", "bg-emerald-600", "bg-violet-600", "bg-amber-600", "bg-rose-600", "bg-sky-600"];
export function projectTone(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PROJECT_TONES[h % PROJECT_TONES.length]!;
}

export interface ChatProject {
  cwd: string;
  /** O nome da pasta, como o painel de workspaces chama. */
  name: string;
  branch: string | null;
}

/**
 * As pastas onde se pode abrir uma conversa: as com agentes abertos primeiro, depois as fechadas
 * que o painel ainda lembra. Sem repetir pasta. Pura.
 */
export function chatProjects(groups: RepoGroup[]): ChatProject[] {
  const open: ChatProject[] = [];
  const closed: ChatProject[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const ws of group.workspaces) {
      if (seen.has(ws.cwd)) continue;
      seen.add(ws.cwd);
      (ws.closed ? closed : open).push({ cwd: ws.cwd, name: ws.title, branch: ws.branch });
    }
  }
  return [...open, ...closed];
}

export interface ConversationCard {
  tabId: string;
  title: string;
  project: string;
  cwd: string;
  branch: string | null;
  /** A pasta é um worktree (não o checkout principal do repo). */
  isWorktree: boolean;
  agentId: string;
  agentLabel: string;
  /** Sem PTY ainda: o agente está subindo. */
  starting: boolean;
  active: boolean;
  openedAt: number;
}

/**
 * As conversas da sidebar: os agentes abertos (não os terminais de shell), as mais novas primeiro.
 * Pura.
 */
export function conversationCards(groups: RepoGroup[]): ConversationCard[] {
  const cards: ConversationCard[] = [];
  for (const group of groups) {
    for (const ws of group.workspaces) {
      if (ws.closed) continue;
      for (const agent of ws.agents) {
        if (agent.agentId === SHELL_AGENT_ID) continue;
        cards.push({
          tabId: agent.tabId,
          title: agent.title,
          project: ws.title,
          cwd: ws.cwd,
          branch: ws.branch,
          isWorktree: ws.isWorktree,
          agentId: agent.agentId,
          agentLabel: agent.agentLabel,
          starting: agent.status === "starting",
          active: agent.isActive,
          openedAt: agent.openedAt,
        });
      }
    }
  }
  return cards.sort((a, b) => b.openedAt - a.openedAt);
}

/** Flags que `chatCommand` põe (e o que mais fixar modelo, esforço ou permissão): os que levam valor e os soltos. */
const VALUED = new Set(["--model", "-m", "--effort", "--permission-mode", "--approval-mode"]);
const BARE = new Set(["--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--yolo", "--approve-for-me"]);
const CONFIG_KEYS = /^(model_reasoning_effort|service_tier|features\.fast_mode)=/;

/** O comando sem modelo, esforço, Fast e permissão: o que sobra é o agente com o resto dos flags. Pura. */
export function stripChatFlags(command: string): string {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const next = parts[i + 1];
    if (VALUED.has(part) && next !== undefined) { i += 1; continue; }
    if (BARE.has(part)) continue;
    if (part === "-c" && next && CONFIG_KEYS.test(next)) { i += 1; continue; }
    out.push(part);
  }
  return out.join(" ");
}

/** O comando de uma conversa aberta com a escolha nova (modelo, esforço, permissão). Pura. */
export function retuneConversation(agentId: string, command: string, choice: LaunchChoice): string {
  return chatCommand(agentId, stripChatFlags(command), choice);
}
