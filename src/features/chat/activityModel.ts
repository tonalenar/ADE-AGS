import type { PlanStep, TimelineItem, ToolKind, ToolStatus } from "./timeline/types";
import { fileName } from "./timeline/timelineModel";

/**
 * "No que o agente está trabalhando" (prancheta 13), tirado dos itens da conversa: a atividade do
 * momento (a ferramenta rodando ou "pensando"), quando o turno começou, os tokens do turno, os
 * últimos comandos e o trecho de raciocínio mais recente. Serve às duas conversas: a lida do
 * transcript (TUI) e a por protocolo. Puro.
 */

/** O que o agente faz agora. `waiting` = parado esperando a pessoa (permissão ou pergunta). */
export type Activity =
  | { kind: "tool"; tool: ToolKind; target: string }
  | { kind: "thinking" }
  | { kind: "waiting" };

export interface RecentTool {
  id: string;
  tool: ToolKind;
  label: string;
  status: ToolStatus;
}

export interface TurnLive {
  /** Quando o turno em aberto começou (a mensagem da pessoa); `null` = não se sabe. */
  startedAt: number | null;
  /** Os tokens do turno (soma dos itens `usage` dele); `null` = o agente não informou. */
  tokens: number | null;
  activity: Activity;
  /** As últimas ferramentas do turno, da mais antiga para a mais nova (no máximo [`RECENT_MAX`]). */
  recent: RecentTool[];
  /** O trecho de raciocínio mais recente do turno, se o agente expõe. */
  reasoning: string | null;
}

/** Quantas ferramentas o "Ver o que está fazendo" mostra. */
export const RECENT_MAX = 2;

/** Os itens do turno em aberto: depois da última mensagem da pessoa (ou do último fim de turno). */
export function openTurnItems(items: TimelineItem[]): TimelineItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const kind = items[i]!.kind;
    if (kind === "turnEnd") return items.slice(i + 1);
    if (kind === "user") return items.slice(i);
  }
  return items;
}

/** O alvo curto de uma ferramenta: o arquivo, ou a primeira linha do comando/consulta. */
export function toolTarget(item: Pick<TimelineItem, "path" | "label">, max = 60): string {
  if (item.path) return fileName(item.path);
  const label = (item.label ?? "").split("\n")[0]!.trim();
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/** O estado ao vivo do turno em aberto. `waiting` = há um pedido esperando a pessoa. */
export function turnLive(items: TimelineItem[], waiting = false): TurnLive {
  const turn = openTurnItems(items);
  const first = turn[0];
  const startedAt = first?.kind === "user" ? first.at ?? null : null;
  let tokens: number | null = null;
  let reasoning: string | null = null;
  const tools: TimelineItem[] = [];
  for (const item of turn) {
    if (item.kind === "usage" && typeof item.tokens === "number") tokens = (tokens ?? 0) + item.tokens;
    else if (item.kind === "reasoning" && item.text) reasoning = item.text;
    else if (item.kind === "tool") tools.push(item);
  }
  const running = [...tools].reverse().find((t) => t.status === "running" && t.tool !== "question");
  const activity: Activity = waiting
    ? { kind: "waiting" }
    : running
      ? { kind: "tool", tool: running.tool ?? "other", target: toolTarget(running) }
      : { kind: "thinking" };
  const recent = tools.slice(-RECENT_MAX).map((t) => ({ id: t.id, tool: t.tool ?? "other", label: (t.label ?? t.path ?? "").split("\n")[0]!, status: t.status ?? "done" }));
  return { startedAt, tokens, activity, recent, reasoning };
}

/** O tipo de uma ferramenta pelo nome (o estado do canal só traz o nome e o resumo). */
export function toolKindOfName(name: string): ToolKind {
  switch (name) {
    case "Bash": case "PowerShell": case "shell": case "exec_command": case "local_shell": case "local_shell_call": case "unified_exec":
      return "command";
    case "Read": return "read";
    case "Edit": case "MultiEdit": case "NotebookEdit": case "apply_patch": return "edit";
    case "Write": return "write";
    case "Grep": case "Glob": return "search";
    case "WebFetch": case "WebSearch": case "web_search": return "web";
    case "Task": case "Agent": return "task";
    case "TodoWrite": case "update_plan": return "todo";
    case "AskUserQuestion": case "request_user_input": return "question";
    default: return "other";
  }
}

/** A atividade de uma aba pelo estado do canal: a última ferramenta pendente, ou "pensando". */
export function snapshotActivity(tools: { name: string; summary: string }[], waiting = false): Activity {
  if (waiting) return { kind: "waiting" };
  const last = tools[tools.length - 1];
  if (!last) return { kind: "thinking" };
  const tool = toolKindOfName(last.name);
  const summary = last.summary || last.name;
  return { kind: "tool", tool, target: tool === "read" || tool === "edit" || tool === "write" ? fileName(summary) : toolTarget({ label: summary }) };
}

/** Comandos que têm nome próprio na linha viva ("Rodando testes"), na ordem em que se testam. */
const COMMAND_PHRASES: [RegExp, string][] = [
  [/\b(vitest|jest|pytest|mocha|playwright|cargo\s+test|(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test|go\s+test|ags\s+test)\b/i, "chat.live.tests"],
  [/\b(tsc|typecheck|cargo\s+check|mypy|pyright)\b/i, "chat.live.typecheck"],
  [/\b(eslint|clippy|biome|ruff|check:[\w-]+|lint)\b/i, "chat.live.lint"],
  [/\b((?:bun|npm|pnpm|yarn)\s+(?:add|install|i)|pip3?\s+install|cargo\s+(?:add|install)|brew\s+install)\b/i, "chat.live.install"],
  [/\b(build|cargo\s+b\b|vite\s+build|make)\b/i, "chat.live.build"],
  [/^\s*git\s+/i, "chat.live.git"],
];

/** A frase de um comando conhecido; `null` = vale o genérico "Rodando <comando>". */
export function commandPhrase(command: string): string | null {
  for (const [re, key] of COMMAND_PHRASES) if (re.test(command)) return key;
  return null;
}

/** A chave i18n da atividade e o alvo para `{{target}}`. */
export function activityPhrase(activity: Activity): { key: string; target?: string } {
  if (activity.kind === "thinking") return { key: "chat.live.thinking" };
  if (activity.kind === "waiting") return { key: "chat.live.waiting" };
  if (activity.tool === "command") {
    const named = commandPhrase(activity.target);
    return named ? { key: named, target: activity.target } : { key: "chat.live.command", target: activity.target };
  }
  if (activity.tool === "todo" || activity.tool === "question") return { key: `chat.live.${activity.tool}` };
  return { key: `chat.live.${activity.tool}`, target: activity.target };
}

/** O tempo como a prancheta escreve: `52 s`, `1 min 12 s`, `1 h 3 min`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return s > 0 ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}

/** O número de tokens curto no idioma da tela: `88,6 mil` (pt-BR), `88.6K` (en). */
export function formatTokens(n: number, lang: string): string {
  try {
    return new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}

/** O andamento do plano: quantos passos concluídos, o total e o passo atual (`-1` = nenhum). */
export function planProgress(plan: PlanStep[]): { done: number; total: number; current: number } {
  const done = plan.filter((s) => s.status === "completed").length;
  let current = plan.findIndex((s) => s.status === "inProgress");
  if (current < 0 && done < plan.length) current = plan.findIndex((s) => s.status !== "completed");
  return { done, total: plan.length, current };
}

/**
 * A fila do composer: com o turno acabando (trabalhando → ocioso, sem pedido esperando a pessoa),
 * sai a próxima mensagem. Uma por turno: a seguinte espera o próximo fim.
 */
export function shouldFlushQueue(wasWorking: boolean | undefined, working: boolean, waiting: boolean, queued: number): boolean {
  return queued > 0 && wasWorking === true && !working && !waiting;
}
