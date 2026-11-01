/**
 * O cartão "Limites de uso" do Resumo: o que a conta em uso pela conversa já gastou da cota do plano.
 * Sem React e sem `invoke`. Os números vêm de leituras que o ADE já faz (`useUsageStore`: o `/usage` do
 * Claude, as janelas do Codex, os medidores do Antigravity; e o resumo do ledger para o orçamento do
 * dia). O que não tem fonte, ou falhou, é "não medido": nunca se inventa um número.
 */
import type { LiveUsage } from "@/features/accounts/usage";
import type { AccountLimits } from "@/features/accounts/types";
import type { AgyEntry, AntigravityEntry, CodexEntry } from "@/features/canvas/usageStore";

/** Acima disto a barra fica âmbar; em 100 está esgotada. */
export const WARN_ABOVE = 80;

export type LimitLevel = "unknown" | "ok" | "warn" | "full";

export function limitLevel(percent: number | null): LimitLevel {
  if (percent === null) return "unknown";
  if (percent >= 100) return "full";
  return percent > WARN_ABOVE ? "warn" : "ok";
}

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

// ── Renovação ────────────────────────────────────────────────────────

export type Renewal =
  | { kind: "passed" }
  /** Falta isto (a janela de 5 h): "renova em 2 h 14 min". */
  | { kind: "in"; seconds: number }
  /** Renova neste instante (a semanal, ou o que está longe): "renova seg 09:00". */
  | { kind: "at"; epoch: number };

export type WindowKind = "session" | "week" | "model";

/** Como a janela renova. `null` = o horário não é conhecido. Pura. */
export function renewal(kind: WindowKind, resetsAt: number | null, now: number): Renewal | null {
  if (resetsAt === null) return null;
  if (resetsAt <= now) return { kind: "passed" };
  const left = resetsAt - now;
  return kind !== "week" && left < 24 * 3600 ? { kind: "in", seconds: left } : { kind: "at", epoch: resetsAt };
}

// ── Leituras ─────────────────────────────────────────────────────────

export interface LimitWindow {
  kind: WindowKind;
  /** O nome do modelo (só em `model`). */
  label: string | null;
  /** 0–100; `null` = a janela já renovou e o uso novo não se sabe. */
  percent: number | null;
  /** Quando renova, em segundos (Codex e Antigravity informam). */
  resetsAt: number | null;
  /** O texto de renovação que a TUI deu (Claude: "3pm (America/Sao_Paulo)"). */
  resetsText: string | null;
  /** Passou a hora de renovar: a porcentagem guardada é velha e não se mostra. */
  expired: boolean;
}

export type UnmeasuredReason = "loading" | "failed" | "notLoggedIn" | "apiKey" | "noWindows" | "noSource";

export type AccountReading =
  | { state: "measured"; windows: LimitWindow[]; /** O servidor recusou por limite. */ rejected: boolean }
  | { state: "unmeasured"; reason: UnmeasuredReason };

const unmeasured = (reason: UnmeasuredReason): AccountReading => ({ state: "unmeasured", reason });

function measured(windows: (LimitWindow | null)[], rejected = false): AccountReading {
  const list = windows.filter((w): w is LimitWindow => w !== null);
  return list.length > 0 || rejected ? { state: "measured", windows: list, rejected } : unmeasured("noWindows");
}

/** Claude Code: as barras do `/usage`, com o texto de renovação da própria TUI. */
export function readClaude(live: LiveUsage | null, loggedIn: boolean, _now: number): AccountReading {
  if (!loggedIn) return unmeasured("notLoggedIn");
  if (live === null) return unmeasured("loading");
  if (!live.available) return unmeasured("failed");
  const meter = (kind: WindowKind, m: { percent: number; resets: string | null } | null): LimitWindow | null =>
    m ? { kind, label: null, percent: clamp(m.percent), resetsAt: null, resetsText: m.resets, expired: false } : null;
  return measured([meter("session", live.session), meter("week", live.week)]);
}

/** Uma janela com horário (0–1 de uso): se já renovou, a porcentagem velha não vale. */
function timed(kind: WindowKind, utilization: number, resetsAt: number | null, now: number, label: string | null = null, percent = clamp(utilization * 100)): LimitWindow {
  const expired = resetsAt !== null && resetsAt <= now;
  return { kind, label, percent: expired ? null : percent, resetsAt, resetsText: null, expired };
}

/** Codex: janelas de 5 h e de 7 dias, com horário. Por API key não há janela de plano. */
export function readCodex(entry: CodexEntry | undefined, loggedIn: boolean, now: number): AccountReading {
  if (!loggedIn) return unmeasured("notLoggedIn");
  if (!entry) return unmeasured("loading");
  const usage = entry.usage;
  if (!usage) return unmeasured(entry.failed ? "failed" : "loading");
  if (usage.auth === "apiKey") return unmeasured("apiKey");
  const q = usage.quota;
  if (!q) return unmeasured("noWindows");
  return measured([
    q.fiveHour ? timed("session", q.fiveHour.utilization, q.fiveHour.resetsAt, now) : null,
    q.sevenDay ? timed("week", q.sevenDay.utilization, q.sevenDay.resetsAt, now) : null,
  ], q.rejected);
}

/** Antigravity: o cupo é por modelo; mostra o mais gasto. */
export function readAntigravity(entry: AntigravityEntry | undefined, loggedIn: boolean, now: number): AccountReading {
  if (!loggedIn) return unmeasured("notLoggedIn");
  if (!entry || entry.meters === null) return unmeasured(entry?.failed ? "failed" : "loading");
  const top = entry.meters[0];
  return measured([top ? timed("model", top.percent / 100, top.resetsAt, now, top.name, clamp(top.percent)) : null]);
}

/**
 * Antigravity sem perfil (o login local do `agy`): a cota por grupo de modelos, cada grupo com a janela de 5 horas e a
 * semanal, como o `agy /usage` informa. É a mesma leitura do canvas (`useUsageStore.agy`). Pura.
 */
export function readAgy(entry: AgyEntry, loggedIn: boolean, now: number): AccountReading {
  if (!loggedIn) return unmeasured("notLoggedIn");
  const usage = entry.usage;
  if (!usage) return unmeasured(entry.failed ? "failed" : "loading");
  if (!usage.installed) return unmeasured("noSource");
  const toEpoch = (iso?: string): number | null => {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  };
  const windows: LimitWindow[] = [];
  for (const group of usage.groups) {
    for (const w of group.windows) {
      const kind: WindowKind = w.kind === "session" ? "session" : w.kind === "weekly" ? "week" : "model";
      windows.push(timed(kind, w.usedPct / 100, toEpoch(w.resetsAt), now, group.name, clamp(w.usedPct)));
    }
  }
  return measured(windows);
}

/** O destaque do cabeçalho: a janela mais gasta (100 se o servidor recusou). `null` = nenhum número. */
export function headlineOf(reading: AccountReading): number | null {
  if (reading.state !== "measured") return null;
  const numbers = reading.windows.map((w) => w.percent).filter((p): p is number => p !== null);
  if (reading.rejected) return 100;
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

// ── Orçamento do dia ─────────────────────────────────────────────────

export interface Budget {
  spent: number;
  budget: number;
  percent: number;
}

/** O gasto das últimas 24 h contra o teto configurado da conta. `null` = sem teto (nada a mostrar). */
export function budgetOf(summary: { limits: AccountLimits; spent24h: number } | undefined): Budget | null {
  const budget = summary?.limits.dailyBudgetUsd;
  if (!summary || budget === null || budget === undefined || budget <= 0) return null;
  return { spent: summary.spent24h, budget, percent: clamp((summary.spent24h / budget) * 100) };
}

// ── Contas da conversa e do time ─────────────────────────────────────

/** A chave da conta nos stores de uso: o id, ou `system:<agente>` para a principal. */
export const accountKeyOf = (agentId: string, accountId: string | null | undefined): string => accountId ?? `system:${agentId}`;

export interface UsedAccount {
  key: string;
  agentId: string;
  /** `null` = a conta principal do agente. */
  accountId: string | null;
  /** Quem da conversa usa esta conta. */
  who: string[];
}

/** As contas distintas que a conversa (e o time) usam, na ordem em que aparecem. Pura. */
export function usedAccounts(members: { name: string; agentId: string; accountId: string | null | undefined }[]): UsedAccount[] {
  const out: UsedAccount[] = [];
  for (const m of members) {
    const key = accountKeyOf(m.agentId, m.accountId);
    const found = out.find((a) => a.key === key);
    if (found) found.who.push(m.name);
    else out.push({ key, agentId: m.agentId, accountId: m.accountId ?? null, who: [m.name] });
  }
  return out;
}

// ── Todas as contas conectadas ───────────────────────────────────────────────────────────────────────────────

/** O que se precisa de uma conta do ADE para listá-la (o `AgentAccount` tem mais campos). */
export interface AccountLike {
  id: string;
  agentId: string;
  name: string;
  label: string | null;
  loggedIn: boolean;
}

export interface AccountEntry {
  key: string;
  agentId: string;
  /** `null` = a conta principal do agente. */
  accountId: string | null;
  /** A conta do ADE; `null` quando só se sabe do agente (o `agy` local, ou um agente sem conta). */
  account: AccountLike | null;
  /** Quem da conversa (e do time) a usa; vazio = outra conta conectada. */
  who: string[];
}

/**
 * As contas que o cartão lista: TODAS as conectadas dos agentes que expõem a cota (`measured`), não só as da conversa.
 * As da conversa vêm primeiro (e uma conta que a conversa usa entra mesmo sem login, ou de um agente sem cota, para dizer
 * «não medido» com o motivo). O `agy` local entra como a conta principal do Antigravity quando instalado. Pura.
 */
export function connectedAccounts(input: {
  accounts: AccountLike[];
  systemAccounts: AccountLike[];
  used: UsedAccount[];
  measured: ReadonlySet<string>;
  agyInstalled?: boolean;
}): AccountEntry[] {
  const all = [...input.systemAccounts, ...input.accounts];
  const byKey = new Map<string, AccountEntry>();
  const add = (agentId: string, account: AccountLike | null, who: string[]) => {
    const accountId = account && !account.id.startsWith("system:") ? account.id : null;
    const key = accountKeyOf(agentId, accountId);
    if (!byKey.has(key)) byKey.set(key, { key, agentId, accountId, account, who });
  };
  const order = [...input.measured];
  const agentRank = (id: string) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
  // As da conversa primeiro, na ordem em que ela as usa.
  for (const u of input.used) {
    const account = all.find((a) => (u.accountId ? a.id === u.accountId : a.id === `system:${u.agentId}` || (a.agentId === u.agentId && a.id.startsWith("system:")))) ?? null;
    add(u.agentId, account, u.who);
  }
  const rest = all
    .filter((a) => input.measured.has(a.agentId) && a.loggedIn)
    .sort((a, b) => agentRank(a.agentId) - agentRank(b.agentId) || Number(b.id.startsWith("system:")) - Number(a.id.startsWith("system:")) || a.name.localeCompare(b.name));
  for (const account of rest) add(account.agentId, account, []);
  if (input.agyInstalled && input.measured.has("antigravity") && !byKey.has("system:antigravity")) add("antigravity", null, []);
  return [...byKey.values()];
}
