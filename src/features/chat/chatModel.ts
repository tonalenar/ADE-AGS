import { withAutonomy } from "@/features/missions/autonomy";
import { withModel } from "@/features/missions/modelFlags";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import type { RepoGroup } from "@/features/workspaces/workspaceTree";
import { matrixProviderForAgent, readHarnessCapability, type HarnessSurface } from "./harnessCapabilities";

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

/** As TUI cuja saída a ADE lê e mostra como timeline, em vez de um PTY bruto. */
const TIMELINE_AGENTS = new Set(["claude-code", "codex"]);

/** Flags específicos declarados pelo adapter de lançamento da TUI. */
const REASONING_EFFORT_AGENTS = new Set(["claude-code", "codex", "antigravity"]);

export function hasTimeline(agentId: string): boolean {
  return TIMELINE_AGENTS.has(agentId);
}

export function reasoningEffortSupported(agentId: string | null): boolean {
  return agentId !== null && REASONING_EFFORT_AGENTS.has(agentId);
}

export function fastModeSupported(agentId: string | null | undefined, surface: HarnessSurface = "tui"): boolean {
  if (!agentId) return false;
  return readHarnessCapability(surface, matrixProviderForAgent(agentId) ?? "", "fast_mode").support === "supported";
}

/** Os flags de cada modo, por agente, conferidos no `--help` de cada CLI. Sem entrada = o agente não tem o modo. */
const ACCESS_FLAGS: Record<Exclude<ChatAccess, "ask" | "safe">, Record<string, string>> = {
  edits: { "claude-code": "--permission-mode acceptEdits", "gemini-cli": "--approval-mode auto_edit" },
  full: { "claude-code": "--dangerously-skip-permissions", codex: "--dangerously-bypass-approvals-and-sandbox", "gemini-cli": "--yolo" },
};

/** O modo Plano (só planeja, não edita). Só o Claude Code tem flag de lançamento para isso. */
const PLAN_FLAG: Record<string, string> = { "claude-code": "--permission-mode plan" };

/**
 * Os agentes que conversam por protocolo, sem TUI (espelho de `conversa::api::Engine`), e o que o
 * protocolo de cada um suporta. Os acessos e o Plano de um agente por protocolo são os do motor,
 * não os flags da TUI:
 * - Codex (`app-server`): a política de aprovação e o sandbox; sem Plano;
 * - Claude Code (`claude -p`): `--permission-mode`, com o Plano;
 * - OpenCode (`opencode acp`): a política de permissões no ambiente do processo e o agente `plan`;
 * - Antigravity (`agy --print`): `--mode accept-edits|auto|plan` e `--dangerously-skip-permissions`;
 *   no `-p` ele não pergunta, então Supervisionado é só leitura na prática;
 * - Cursor (`cursor-agent -p`): `--mode plan` e `--force`; também não pergunta. Aceitar edições e Auto não têm flag
 *   documentada, então ficam de fora.
 */
/**
 * `midTurn`: o que o «enviar agora» faz com o agente trabalhando.
 * - `steer`: a mensagem entra no turno em andamento (o `turn/steer` do Codex; o stdin do `claude -p`, que a lê no meio
 *   do turno ou logo depois dele, sem parar nada);
 * - `interrupt`: o motor não aceita entrada no meio do turno (um processo por turno no Cursor e no Antigravity; o
 *   `session/prompt` do OpenCode): o turno para e a mensagem vai como o próximo, com a mesma sessão (nada do que
 *   foi feito se perde).
 */
export type MidTurn = "steer" | "interrupt";

export const PROTOCOL_AGENTS: Record<string, { access: ChatAccess[]; midTurn: MidTurn }> = {
  codex: { access: ["ask", "safe", "full"], midTurn: "steer" },
  "claude-code": { access: ["ask", "edits", "safe", "full"], midTurn: "steer" },
  opencode: { access: ["ask", "edits", "safe", "full"], midTurn: "interrupt" },
  antigravity: { access: ["ask", "edits", "safe", "full"], midTurn: "interrupt" },
  cursor: { access: ["ask", "full"], midTurn: "interrupt" },
};

/** O «enviar agora» deste agente por protocolo (ver [`MidTurn`]). Um motor desconhecido para o turno: é o que
 * nunca promete o que não faz. Pura. */
export function midTurnOf(agentId: string): MidTurn {
  return PROTOCOL_AGENTS[agentId]?.midTurn ?? "interrupt";
}

/**
 * A chave de i18n do aviso do composer ao enviar com o agente trabalhando. `Unknown` usa um texto neutro;
 * só uma capability provada escolhe entre a frase de steer e a de interrupção.
 */
export function queueHintKey(
  agentId: string,
  followUpBehavior: "steer" | "queue" | "send" = "steer",
  steerSupport = readHarnessCapability("chat", agentId, "steer").support,
  interruptSupport = readHarnessCapability("chat", agentId, "interrupt").support,
): string {
  const queued = followUpBehavior === "queue";
  if (steerSupport === "unknown" || (steerSupport === "unsupported" && interruptSupport !== "supported")) {
    return queued ? "chat.composer.queueHintUnknownQueue" : "chat.composer.queueHintUnknown";
  }
  const midTurn: MidTurn = steerSupport === "supported" ? "steer" : "interrupt";
  if (midTurn === "steer") {
    return queued ? "chat.composer.queueHintSteerQueue" : "chat.composer.queueHintSteer";
  }
  return queued ? "chat.composer.queueHintInterruptQueue" : "chat.composer.queueHintInterrupt";
}

/**
 * Os modos que este agente aceita. Supervisionado sempre (é não passar nada). Com `protocol`
 * (a conversa vai por protocolo), os do motor do agente. Pura.
 */
export function accessModesFor(agentId: string, protocol = false): ChatAccess[] {
  if (protocol && agentId.startsWith("local-acp-")) return ["ask"];
  const engine = protocol ? PROTOCOL_AGENTS[agentId] : undefined;
  if (engine) return ACCESS_MODES.filter((mode) => engine.access.includes(mode));
  return ACCESS_MODES.filter((mode) =>
    mode === "ask" || (mode === "safe" ? withAutonomy(agentId, "x", "safe") !== "x" : !!ACCESS_FLAGS[mode][agentId]));
}

/** O modo Plano só pode ser iniciado quando a matriz prova o suporte na superfície escolhida. */
export function planSupported(agentId: string, protocol = false, support = readHarnessCapability(
  protocol ? "chat" : "tui",
  agentId.startsWith("local-acp-") ? "local-acp" : agentId,
  "plan",
).support): boolean {
  // Plano só aparece quando a matriz prova o caminho; Unknown não habilita um modo novo.
  return support === "supported";
}

/** Remove uma ocorrência explícita de comando ADE do texto, sem confundir `/planner` com `/plan`. */
export function extractSlashCommand(text: string, command: string): { found: boolean; rest: string } {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\s)\\/${escaped}(?=$|\\s)`, "i");
  let found = false;
  const rest = text.replace(pattern, (_match, before: string) => { found = true; return before; }).trim();
  return { found, rest };
}

export interface LaunchChoice {
  /** `null` = o modelo padrão da TUI. */
  model: string | null;
  /** `null` = o esforço padrão da TUI. */
  effort: string | null;
  access: ChatAccess;
  /** Modo Fast do agente selecionado, quando a matriz e o modelo oferecem suporte. */
  fastMode?: boolean;
  /** Começa no modo Plano (onde o agente suporta). */
  plan?: boolean;
}

/** Comando anunciado pela sessão ACP ativa do provedor. `kind: "skill"` quando o agente o anuncia como skill (Codex). */
export interface ProviderSlashCommand {
  name: string;
  description: string;
  inputHint: string | null;
  kind?: "skill" | "command";
}

/** Uma opção `select` que o provedor ACP anunciou para a sessão atual. */
export interface ProviderConfigOption {
  id: string;
  label: string;
  currentValue: string | null;
  options: { value: string; label: string }[];
}

/** Recorte do catálogo ACP usado pelo seletor de modelo e raciocínio da conversa. */
export interface ProviderRuntimeConfig {
  model: ProviderConfigOption | null;
  effort: ProviderConfigOption | null;
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
  return withModel(agentId, withAccess(agentId, command, choice.access, choice.plan), choice.model, choice.effort, choice.fastMode);
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
  /** A raiz do repositório, quando a barra agrupa os checkouts dele numa seção só (ver `sidebar/projectGrouping`). */
  repoKey?: string;
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
    if (part === "--settings" && next && /"(?:fastMode|ultracode)"/.test(next)) { i += 1; continue; }
    if (part === "--append-system-prompt" && next === "Ultrathink:") { i += 1; continue; }
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
