import type { ThreadRow } from "../structured/ipc";

/** O estado real que o backend calcula (`chat_team/watch.rs::RealState`); a interface só o mostra. */
export type RealState = "working" | "waiting_input" | "ended_without_delivery" | "failed" | "idle";

/** Uma linha de `chat_team_states`. */
export interface MemberStateRow {
  member: string;
  parent: string;
  state: RealState;
  since: number;
}

export interface LineageEntry {
  threadId: string;
  title: string;
  agentId: string;
  state: RealState;
  /** Desde quando está nesse estado (ms). */
  since: number;
  /** Quando o filho foi aberto (ms). */
  startedAt: number;
  settled: boolean;
}

export interface Lineage {
  /** Trabalhando ou esperando entrada, os mais antigos primeiro. */
  running: LineageEntry[];
  /** Os que acabaram (ociosos, encerrados sem entregar, com erro ou concluídos), os mais novos primeiro. */
  previous: LineageEntry[];
  failed: number;
}

const ACTIVE: ReadonlySet<RealState> = new Set(["working", "waiting_input"]);

/**
 * A linhagem de uma conversa: os filhos nativos (`parent_ref`) e os integrantes do time que respondem a ela, cada um
 * com o estado real do backend. Sem linha de estado (conversa recém-aberta), vale o da fase ao vivo. Pura.
 */
export function buildLineage(parentThreadId: string, threads: readonly ThreadRow[], states: readonly MemberStateRow[], livePhase: (id: string) => "working" | "idle" | undefined): Lineage {
  const parentRef = `thread:${parentThreadId}`;
  const byId = new Map(threads.map((t) => [t.id, t]));
  const stateOf = new Map(states.filter((s) => s.parent === parentRef).map((s) => [s.member, s]));
  const ids = new Set<string>(threads.filter((t) => t.parentRef === parentRef && t.id !== parentThreadId).map((t) => t.id));
  for (const member of stateOf.keys()) if (member.startsWith("thread:")) ids.add(member.slice("thread:".length));
  const entries: LineageEntry[] = [];
  for (const id of ids) {
    const thread = byId.get(id);
    if (!thread) continue;
    const row = stateOf.get(`thread:${id}`);
    const phase = livePhase(id);
    const state: RealState = phase === "working" ? "working" : row?.state ?? "idle";
    entries.push({ threadId: id, title: thread.title, agentId: thread.agentId, state, since: phase === "working" && row?.state !== "working" ? thread.updatedAt : row?.since ?? thread.updatedAt, startedAt: thread.createdAt, settled: thread.state === "settled" });
  }
  const running = entries.filter((e) => ACTIVE.has(e.state) && !e.settled).sort((a, b) => a.startedAt - b.startedAt);
  const previous = entries.filter((e) => !running.includes(e)).sort((a, b) => b.startedAt - a.startedAt);
  return { running, previous, failed: previous.filter((e) => e.state === "failed").length };
}

/** "2h 35m 50s", "4m 05s", "12s". Pura. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** A chave de i18n do rótulo curto do estado. */
export function stateLabelKey(state: RealState): string {
  return `chat.lineage.state.${state}`;
}

/** O resumo "Aguardando N subagentes · nomes" quando mais de um roda. Pura. */
export function waitingSummary(running: readonly LineageEntry[]): { count: number; names: string } {
  return { count: running.length, names: running.map((e) => e.title).join(" · ") };
}

/** Uma tarefa da fila do time (`chat_team::awareness::queue::Item` + o motivo de agora). */
export interface QueueRow {
  id: string;
  title: string;
  /** Por que ainda espera, na ordem; vazio = pronta (a ADE a lança no próximo passo). */
  waitingOn: string[];
  areas: string[];
  createdAt: number;
}

/** O que `chat_team_queue` devolve: `{items, maxAgents}`. Tolera qualquer outra forma (backend antigo, erro). Pura. */
export function parseQueue(raw: unknown): { rows: QueueRow[]; maxAgents: number | null } {
  const value = raw as { items?: unknown; maxAgents?: unknown } | null;
  const items = Array.isArray(value?.items) ? value.items : [];
  const rows: QueueRow[] = [];
  for (const item of items as Record<string, unknown>[]) {
    if (!item || item.status !== "pending" || typeof item.id !== "string") continue;
    rows.push({
      id: item.id,
      title: typeof item.title === "string" && item.title ? item.title : item.id,
      waitingOn: Array.isArray(item.waitingOn) ? item.waitingOn.filter((r): r is string => typeof r === "string") : [],
      areas: Array.isArray(item.areas) ? item.areas.filter((r): r is string => typeof r === "string") : [],
      createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
    });
  }
  return { rows, maxAgents: typeof value?.maxAgents === "number" ? value.maxAgents : null };
}

/** O limite de agentes simultâneos pela configuração (`team.max_agents`): padrão 3, faixa 1–12. Pura. */
export function parseMaxAgents(raw: string | null | undefined): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_AGENTS;
  return Math.min(MAX_MAX_AGENTS, Math.max(MIN_MAX_AGENTS, n));
}

export const MAX_AGENTS_SETTING = "team.max_agents";
export const DEFAULT_MAX_AGENTS = 3;
export const MIN_MAX_AGENTS = 1;
export const MAX_MAX_AGENTS = 12;
