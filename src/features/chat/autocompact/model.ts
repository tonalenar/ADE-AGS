import type { TimelineItem } from "@/features/chat/timeline/types";

/**
 * Autocompact de contexto, lado da tela (espelho de `src-tauri/src/conversa/autocompact.rs`): a configuração, a medida
 * de contexto de uma conversa, o estado da compactação na timeline e a regra da fila. Tudo puro, sem DOM.
 */

/** A chave em `settings` (a mesma que o backend lê). */
export const AUTOCOMPACT_SETTING = "chat.autocompact";
/** O limiar padrão (% da janela): o ponto em que o Claude Code compacta sozinho numa janela de 200k. */
export const DEFAULT_PCT = 83;
export const MIN_PCT = 50;
export const MAX_PCT = 95;
/** Uma compactação «em curso» que não termina deixa de segurar a fila depois disto (como o backend). */
export const COMPACTION_TTL_MS = 10 * 60_000;
const CLAUDE_WINDOW = 200_000;
const CLAUDE_WINDOW_1M = 1_000_000;

export interface AgentAutoCompact {
  enabled?: boolean;
  thresholdPct?: number;
}

export interface AutoCompactConfig {
  enabled: boolean;
  agents: Record<string, AgentAutoCompact>;
}

export const DEFAULT_CONFIG: AutoCompactConfig = { enabled: true, agents: {} };

export const clampPct = (n: number): number => Math.min(MAX_PCT, Math.max(MIN_PCT, Math.round(n)));

/** Lê a configuração guardada. Qualquer lixo volta ao padrão (ligado): a pessoa pediu o autocompact ligado. */
export function parseAutoCompactConfig(raw: string | null | undefined): AutoCompactConfig {
  if (!raw) return { ...DEFAULT_CONFIG, agents: {} };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_CONFIG, agents: {} };
    const obj = value as { enabled?: unknown; agents?: unknown };
    const agents: Record<string, AgentAutoCompact> = {};
    if (obj.agents && typeof obj.agents === "object" && !Array.isArray(obj.agents)) {
      for (const [id, cfg] of Object.entries(obj.agents as Record<string, unknown>)) {
        if (!cfg || typeof cfg !== "object") continue;
        const c = cfg as { enabled?: unknown; thresholdPct?: unknown };
        const entry: AgentAutoCompact = {};
        if (typeof c.enabled === "boolean") entry.enabled = c.enabled;
        if (typeof c.thresholdPct === "number" && Number.isFinite(c.thresholdPct)) entry.thresholdPct = clampPct(c.thresholdPct);
        agents[id] = entry;
      }
    }
    return { enabled: typeof obj.enabled === "boolean" ? obj.enabled : true, agents };
  } catch {
    return { ...DEFAULT_CONFIG, agents: {} };
  }
}

/** Ligado para o agente: o interruptor global manda; o do agente só desliga um agente específico. */
export const autoCompactEnabledFor = (cfg: AutoCompactConfig, agentId: string): boolean =>
  cfg.enabled && (cfg.agents[agentId]?.enabled ?? true);

/** O limiar em vigor: o escolhido, ou o padrão. */
export const effectivePct = (cfg: AutoCompactConfig, agentId: string): number => cfg.agents[agentId]?.thresholdPct ?? DEFAULT_PCT;

/** Um agente da tabela do backend (`chat_autocompact_plans`). */
export interface AutoCompactPlan {
  agentId: string;
  surface: "chat" | "tui" | "fleet";
  measure: string;
  mechanism: "nativeAuto" | "adeCommand" | "unsupported";
  supported: boolean;
  adeTypes: boolean;
  reason: string;
}

// ── medida de contexto ───────────────────────────────────────────────────

export interface ContextUsage {
  used: number;
  window: number;
  /** 0–100, limitado a 100. */
  pct: number;
  /** A janela veio do provedor (senão é a estimativa pelo modelo: 200k, ou 1M com `[1m]`). */
  windowKnown: boolean;
}

/**
 * O contexto da conversa: o último item `usage` com a entrada de contexto. Sem a janela do provedor, o Claude usa a do
 * modelo (200k, ou 1M com `[1m]` ou se o uso já passou de 200k); outros agentes sem janela ficam sem medida (não se inventa).
 */
export function contextUsageOf(items: readonly TimelineItem[], agentId: string, model?: string | null): ContextUsage | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== "usage" || !item.contextTokens || item.contextTokens <= 0) continue;
    const used = item.contextTokens;
    let window = item.contextWindow && item.contextWindow > 0 ? item.contextWindow : null;
    const windowKnown = window !== null;
    if (window === null && agentId === "claude-code") {
      window = (model ?? "").toLowerCase().includes("[1m]") || used > CLAUDE_WINDOW ? CLAUDE_WINDOW_1M : CLAUDE_WINDOW;
    }
    if (window === null) return null;
    return { used, window, pct: Math.min(100, (used / window) * 100), windowKnown };
  }
  return null;
}

export type MeterTone = "ok" | "near" | "over";

/** A cor do medidor: «over» passou do limiar de compactação; «near» está a 10 pontos dele. */
export function meterTone(pct: number, thresholdPct: number): MeterTone {
  if (pct >= thresholdPct) return "over";
  return pct >= thresholdPct - 10 ? "near" : "ok";
}

/** 182.400 → «182k», 1.250.000 → «1,25M» (sem locale: a tela usa `Intl` quando precisa). */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2).replace(/\.?0+$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

// ── estado na timeline ───────────────────────────────────────────────────

export type CompactionState = "running" | "done" | "error";
export type CompactionTrigger = "auto" | "manual" | "ade";

export interface Compaction {
  id: string;
  state: CompactionState;
  trigger: CompactionTrigger;
  before: number | null;
  after: number | null;
  at: number | null;
  /** O motivo da falha, quando houve. */
  error: string | null;
}

/** O item é o aviso de compactação do app (`Notice` com o código `compaction`)? */
export const isCompactionItem = (item: TimelineItem): boolean => item.kind === "notice" && item.label === "compaction";

/** Lê o aviso de compactação de um item. */
export function compactionOf(item: TimelineItem): Compaction | null {
  if (!isCompactionItem(item)) return null;
  const state: CompactionState = item.status === "running" ? "running" : item.status === "error" ? "error" : "done";
  const trigger: CompactionTrigger = item.text === "manual" ? "manual" : item.text === "ade" ? "ade" : "auto";
  return { id: item.id, state, trigger, before: item.contextTokens ?? null, after: item.tokens ?? null, at: item.at ?? null, error: item.output ?? null };
}

/** A conversa está compactando agora? O último aviso de compactação está «em andamento» e não expirou. */
export function isCompacting(items: readonly TimelineItem[], now: number): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const compaction = compactionOf(items[i]);
    if (!compaction) continue;
    return compaction.state === "running" && (compaction.at === null || now - compaction.at < COMPACTION_TTL_MS);
  }
  return false;
}

/**
 * A mensagem enviada agora espera na fila? Com a conversa compactando, sim, mesmo que o motor aceitasse entrar no turno:
 * a compactação não é um turno que se guia. Sai quando o aviso «Contexto compactado» fecha (a fila do composer).
 */
export const holdsForCompaction = (compacting: boolean): boolean => compacting;
