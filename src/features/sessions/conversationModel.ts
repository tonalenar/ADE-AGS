/**
 * O modelo puro de uma "conversa" de projeto: um canvas com vários terminais. Sem React e sem
 * `invoke`. Trocar de conversa salva a lista de terminais (`ConversationSnapshot`) e abrir a
 * conversa reabre cada um no mesmo lugar do canvas.
 */

import type { Box } from "@/features/canvas/geometry";
import type { PrelaunchStep } from "@/features/prelaunch/types";
import { SHELL_AGENT_ID, type Tab } from "@/features/tabs/types";

/** Separa a chave do canvas da carpeta (ou da missão) do id da conversa. */
export const CONV_SEP = "#c:";

/** Limite de terminais de uma conversa ao ler o que foi guardado. */
const MAX_TERMINALS = 24;
/** Limite de conexões de uma conversa ao ler o que foi guardado. */
const MAX_LINKS = 64;
const TITLE_MAX = 60;
const CUSTOM_MAX = 120;
const FALLBACK_TITLE = "Nova conversa";

/** Um terminal de agente tal como vai para o snapshot da conversa. */
export interface TerminalSnapshot {
  agentId: string;
  agentLabel: string;
  command: string;
  title: string;
  titleIsCustom: boolean;
  sessionId: string | null;
  accountId: string | null;
  prelaunch: PrelaunchStep[];
  skillIds: string[];
  box: Box | null;
  role: string | null;
  /** Era a coroa (orquestrador) no canvas. */
  orchestrator: boolean;
}

/** Uma conversa guardada: os terminais e as conexões entre eles, por índice em `terminals`. */
export interface ConversationSnapshot {
  terminals: TerminalSnapshot[];
  /** Pares de índices de `terminals`, com `a < b`, sem repetição. */
  links: [number, number][];
}

/** Uma linha de conversa, espelho do JSON do backend. */
export interface ConversationRow {
  id: string;
  workspaceId: string;
  projectKey: string;
  cwd: string;
  title: string | null;
  customTitle: string | null;
  pinned: boolean;
  hidden: boolean;
  state: "active" | "saved";
  terminals: unknown;
  createdAt: number;
  lastActiveAt: number;
}

// ── Chaves do canvas ────────────────────────────────────────────────

/** A chave do canvas de uma conversa: a da carpeta (ou missão) com o id da conversa pegado. */
export function conversationBoardKey(baseKey: string, conversationId: string): string {
  return `${baseKey}${CONV_SEP}${conversationId}`;
}

/** O id da conversa de uma chave de canvas, ou `null` se a chave não é de conversa. */
export function conversationIdOfKey(key: string | null): string | null {
  if (!key) return null;
  const at = key.lastIndexOf(CONV_SEP);
  if (at < 0) return null;
  const id = key.slice(at + CONV_SEP.length);
  return id === "" ? null : id;
}

export function isConversationKey(key: string | null): boolean {
  return conversationIdOfKey(key) !== null;
}

// ── Texto ───────────────────────────────────────────────────────────

/** Corta por caracteres (não por unidades de código) e põe reticências no fim. */
function cut(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

/** Aparado e cortado; vazio se não for texto. */
function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? cut(v.trim(), max) : "";
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function copyBox(b: Box | null | undefined): Box | null {
  return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
}

// ── Snapshot ────────────────────────────────────────────────────────

/**
 * Os terminais de agente das abas, na ordem recebida (a shell não entra). `box` é a posição
 * no canvas. `orchestrators` são os ids de abas que eram coroa.
 */
export function snapshotTerminals(
  tabs: Tab[],
  nodes: Record<string, Box>,
  skillIdsOf: (tabId: string) => string[],
  roles: Record<string, string> = {},
  orchestrators: string[] = [],
): TerminalSnapshot[] {
  const coroas = new Set(orchestrators);
  return tabs
    .filter((tab) => tab.agentId !== SHELL_AGENT_ID)
    .map((tab) => ({
      agentId: tab.agentId,
      agentLabel: tab.agentLabel,
      command: tab.command,
      title: tab.title,
      titleIsCustom: tab.titleIsCustom === true,
      sessionId: tab.sessionId || null,
      accountId: tab.accountId || null,
      prelaunch: (tab.prelaunch ?? []).map((step) => ({ ...step })),
      skillIds: [...skillIdsOf(tab.id)],
      box: copyBox(nodes[tab.id]),
      role: roles[tab.id] ?? null,
      orchestrator: coroas.has(tab.id),
    }));
}

/**
 * O snapshot de uma conversa: os terminais de agente e as conexões entre eles. Uma conexão só
 * entra se os dois lados são terminais do snapshot; vira um par `[a, b]` de índices, `a < b`,
 * sem repetição, na ordem das conexões recebidas.
 */
export function snapshotConversation(
  tabs: Tab[],
  nodes: Record<string, Box>,
  skillIdsOf: (tabId: string) => string[],
  roles: Record<string, string>,
  edges: { a: string; b: string }[],
  orchestrators: string[],
): ConversationSnapshot {
  const agentTabs = tabs.filter((tab) => tab.agentId !== SHELL_AGENT_ID);
  const terminals = snapshotTerminals(agentTabs, nodes, skillIdsOf, roles, orchestrators);
  const indexOf = new Map<string, number>();
  agentTabs.forEach((tab, i) => indexOf.set(tab.id, i));

  const seen = new Set<string>();
  const links: [number, number][] = [];
  for (const edge of edges) {
    const a = indexOf.get(edge.a);
    const b = indexOf.get(edge.b);
    if (a === undefined || b === undefined || a === b) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}-${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push([lo, hi]);
  }
  return { terminals, links };
}

// ── Leitura tolerante ───────────────────────────────────────────────

function parseBox(v: unknown): Box | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.w) || !Number.isFinite(o.h)) return null;
  return { x: o.x as number, y: o.y as number, w: o.w as number, h: o.h as number };
}

function isPrelaunchStep(v: unknown): v is PrelaunchStep {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.presetId === "string" || typeof o.command === "string";
}

/** Um terminal válido, com os padrões preenchidos; `null` se faltar `agentId` ou `command`. */
function parseTerminal(item: unknown): TerminalSnapshot | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  if (!nonEmpty(o.agentId) || !nonEmpty(o.command)) return null;
  const agentLabel = nonEmpty(o.agentLabel) ? o.agentLabel : o.agentId;
  return {
    agentId: o.agentId,
    agentLabel,
    command: o.command,
    title: nonEmpty(o.title) ? o.title : agentLabel,
    titleIsCustom: o.titleIsCustom === true,
    sessionId: nonEmpty(o.sessionId) ? o.sessionId : null,
    accountId: nonEmpty(o.accountId) ? o.accountId : null,
    prelaunch: Array.isArray(o.prelaunch) ? o.prelaunch.filter(isPrelaunchStep) : [],
    skillIds: Array.isArray(o.skillIds) ? o.skillIds.filter((s): s is string => typeof s === "string") : [],
    box: parseBox(o.box),
    role: nonEmpty(o.role) ? o.role : null,
    orchestrator: o.orchestrator === true,
  };
}

/**
 * Lê uma lista de terminais guardada. Ignora o que não é válido, preenche os padrões e para
 * em 24. Nunca lança.
 */
export function parseTerminals(raw: unknown): TerminalSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const out: TerminalSnapshot[] = [];
  for (const item of raw) {
    if (out.length >= MAX_TERMINALS) break;
    const terminal = parseTerminal(item);
    if (terminal) out.push(terminal);
  }
  return out;
}

function isIndex(v: unknown, n: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < n;
}

/** Lê as conexões: pares de índices válidos dentro de `n`, com `a != b`, sem repetição, até 64. */
function parseLinks(raw: unknown, n: number): [number, number][] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const item of raw) {
    if (out.length >= MAX_LINKS) break;
    if (!Array.isArray(item) || item.length !== 2) continue;
    const [a, b] = item as unknown[];
    if (!isIndex(a, n) || !isIndex(b, n) || a === b) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}-${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([lo, hi]);
  }
  return out;
}

/**
 * Lê uma conversa guardada. Aceita o formato antigo (um array puro de terminais, sem
 * conexões) e o novo (`{ terminals, links }`). Tolerante: nunca lança.
 */
export function parseConversationSnapshot(raw: unknown): ConversationSnapshot {
  if (Array.isArray(raw)) return { terminals: parseTerminals(raw), links: [] };
  if (!raw || typeof raw !== "object") return { terminals: [], links: [] };
  const o = raw as Record<string, unknown>;
  const terminals = parseTerminals(o.terminals);
  return { terminals, links: parseLinks(o.links, terminals.length) };
}

// ── Abas e ordem ────────────────────────────────────────────────────

/** As abas de agente que estão trabalhando agora (para pedir confirmação antes de fechar). */
export function activeAgentWork(tabs: Tab[], isWorking: (tabId: string) => boolean): Tab[] {
  return tabs.filter((tab) => tab.agentId !== SHELL_AGENT_ID && isWorking(tab.id));
}

/**
 * Título de uma conversa: o título personalizado (aparado, até 120) > o título (aparado) >
 * o título do primeiro terminal (até 60) > "Nova conversa". Nunca vazio.
 */
export function conversationTitle(row: ConversationRow, terminals: TerminalSnapshot[]): string {
  const custom = cleanText(row.customTitle, CUSTOM_MAX);
  if (custom) return custom;
  const title = typeof row.title === "string" ? row.title.trim() : "";
  if (title) return title;
  return cleanText(terminals[0]?.title, TITLE_MAX) || FALLBACK_TITLE;
}

/**
 * A ordem de reabrir: a coroa (orquestrador) vai primeiro e o resto mantém a ordem. Sem coroa,
 * a ordem não muda. Devolve uma cópia.
 */
export function pickRestoreOrder(terminals: TerminalSnapshot[]): TerminalSnapshot[] {
  const idx = terminals.findIndex((t) => t.orchestrator);
  if (idx <= 0) return [...terminals];
  return [terminals[idx], ...terminals.slice(0, idx), ...terminals.slice(idx + 1)];
}

/** O índice do primeiro terminal a ativar: `0` se há algum, `-1` se a lista está vazia. */
export function firstToActivate(terminals: TerminalSnapshot[]): number {
  return terminals.length === 0 ? -1 : 0;
}
