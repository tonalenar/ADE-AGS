/**
 * O chat unificado da equipe de uma missão: as mensagens entre os agentes e os pedidos de
 * permissão da frota, numa linha do tempo só. Lógica pura; a tela é `TeamFeed.tsx`.
 */
import type { PendingApproval } from "@/features/runs/types";

import type { PermissionPrompt } from "./terminalPrompts";

/** Um pedido de permissão aberto no terminal de um agente (ver `useTerminalPrompts`). */
export interface TerminalPromptItem {
  tabId: string;
  who: string;
  prompt: PermissionPrompt;
  atMs: number;
}

/** Uma mensagem entre dois agentes (`mission_messages`). */
export interface TeamMessage {
  id: number;
  missionId: string;
  atMs: number;
  kind: "tell" | "ask";
  fromTabId: string;
  fromName: string;
  toTabId: string;
  toName: string;
  text: string;
}

export type FeedItem =
  | { type: "message"; key: string; atMs: number; message: TeamMessage }
  | { type: "approval"; key: string; atMs: number; approval: PendingApproval; who: string }
  /** Um pedido de permissão que o TUI de um agente está mostrando agora no terminal dele. */
  | { type: "prompt"; key: string; atMs: number; tabId: string; who: string; prompt: PermissionPrompt }
  /** O que a pessoa mandou a um agente por este chat. */
  | { type: "user"; key: string; atMs: number; toName: string; text: string };

export interface UserNote {
  key: string;
  atMs: number;
  toName: string;
  text: string;
}

/** Quem pode receber: o nome do agente na equipe. */
export interface Addressee {
  id: string;
  name: string;
}

/** O que o compositor da equipe entendeu do texto: ver `resolveMention`. */
export type MentionResult =
  | { kind: "none" }
  | { kind: "ok"; to: Addressee; text: string }
  /** `@Nome` sem mensagem: o agente existe, falta o texto. */
  | { kind: "empty"; to: Addressee }
  /** O nome casa com mais de um agente (mesma primeira palavra): não se sabe a quem mandar. */
  | { kind: "ambiguous"; names: string[] }
  | { kind: "unknown" };

/**
 * `@Backend faça X` → { to: Backend, text: "faça X" }. Casa o nome inteiro (`@QA / Tests`) ou só a
 * primeira palavra dele (`@QA`), sem diferenciar maiúsculas; vale o rótulo mais longo. Depois do nome vale
 * espaço, `,`, `:` ou `;` (`@QA: x`). A menção tem de ser o começo da mensagem: um `@` no meio do texto é só
 * texto. Pura.
 */
export function resolveMention(input: string, team: Addressee[]): MentionResult {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("@")) return { kind: "none" };
  const body = trimmed.slice(1);
  const lower = body.toLowerCase();
  const matches = team
    .flatMap((member) => {
      const full = member.name.trim();
      const first = full.split(/\s+/)[0] ?? full;
      return [full, first].filter(Boolean).map((label) => ({ member, label: label.toLowerCase() }));
    })
    .filter(({ label }) => {
      if (!lower.startsWith(label)) return false;
      const next = body.charAt(label.length);
      return next === "" || /[\s,:;]/.test(next);
    });
  if (matches.length === 0) return { kind: "unknown" };
  const longest = Math.max(...matches.map((m) => m.label.length));
  const best = new Map<string, Addressee>();
  for (const m of matches) if (m.label.length === longest) best.set(m.member.id, m.member);
  if (best.size > 1) return { kind: "ambiguous", names: [...best.values()].map((m) => m.name) };
  const to = [...best.values()][0];
  const text = body.slice(longest).replace(/^[\s,:;]+/, "").trim();
  return text ? { kind: "ok", to, text } : { kind: "empty", to };
}

/** Só o caso `ok` de `resolveMention`; qualquer outro, `null`. Pura. */
export function parseMention(input: string, team: Addressee[]): { to: Addressee; text: string } | null {
  const r = resolveMention(input, team);
  return r.kind === "ok" ? { to: r.to, text: r.text } : null;
}

/** Os nomes que o `@` oferece enquanto se digita: `@b` → Backend. Só enquanto a palavra não acabou. Pura. */
export function suggestMentions(input: string, team: Addressee[]): Addressee[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("@")) return [];
  const word = trimmed.slice(1);
  if (/\s/.test(word)) return [];
  const q = word.toLowerCase();
  return team.filter((member) => {
    const name = member.name.toLowerCase();
    return name.startsWith(q) || (name.split(/\s+/)[0] ?? name).startsWith(q);
  });
}

/** Aviso do Vigia (gravado em `mission_messages` com `from_name` "Vigia"): vai discreto, não como fala de agente. Pura. */
export function isVigiaMessage(message: Pick<TeamMessage, "fromName">): boolean {
  return message.fromName.trim().toLowerCase() === "vigia";
}

/** Junta as mensagens novas às já vistas sem repetir `id` (duas leituras com o mesmo `afterId` trazem as mesmas linhas). Pura. */
export function mergeMessages(all: TeamMessage[], fresh: TeamMessage[]): TeamMessage[] {
  const seen = new Set(all.map((m) => m.id));
  const added = fresh.filter((m) => !seen.has(m.id));
  return added.length === 0 ? all : [...all, ...added];
}

/** Mensagens e pedidos de permissão em ordem de chegada. Pura. */
export function buildFeed(messages: TeamMessage[], approvals: { approval: PendingApproval; who: string }[], notes: UserNote[] = [], prompts: TerminalPromptItem[] = []): FeedItem[] {
  const items: FeedItem[] = [
    ...messages.map((message): FeedItem => ({ type: "message", key: `m${message.id}`, atMs: message.atMs, message })),
    ...approvals.map(({ approval, who }): FeedItem => ({
      type: "approval",
      key: `a${approval.id}`,
      // `askedAt` vem em segundos ou em ms conforme a origem: normaliza para ms.
      atMs: approval.askedAt < 1e12 ? approval.askedAt * 1000 : approval.askedAt,
      approval,
      who,
    })),
    ...prompts.map((p): FeedItem => ({ type: "prompt", key: `p${p.tabId}`, atMs: p.atMs, tabId: p.tabId, who: p.who, prompt: p.prompt })),
    ...notes.map((n): FeedItem => ({ type: "user", key: n.key, atMs: n.atMs, toName: n.toName, text: n.text })),
  ];
  return items.sort((a, b) => a.atMs - b.atMs || a.key.localeCompare(b.key));
}

/** O filtro da linha do tempo: tudo, só pedidos de permissão ou só o que envolve um agente (pelo nome). */
export type FeedFilter = "all" | "approvals" | `agent:${string}`;

export function filterFeed(items: FeedItem[], filter: FeedFilter): FeedItem[] {
  if (filter === "all") return items;
  if (filter === "approvals") return items.filter((i) => i.type === "approval" || i.type === "prompt");
  const name = filter.slice("agent:".length);
  return items.filter((i) => (i.type === "message" ? i.message.fromName === name || i.message.toName === name : i.type === "user" ? i.toName === name : i.type === "prompt" ? i.who === name : false));
}

/** Os nomes que aparecem nas mensagens (na ordem em que surgem) e quantos pedidos esperam. Pura. */
export function feedFilterOptions(items: FeedItem[]): { names: string[]; approvals: number } {
  const names: string[] = [];
  let approvals = 0;
  for (const item of items) {
    if (item.type === "approval" || item.type === "prompt") approvals += 1;
    else if (item.type === "message") for (const n of [item.message.fromName, item.message.toName]) if (!names.includes(n)) names.push(n);
  }
  return { names, approvals };
}

/** Uma mensagem logo depois de outra do mesmo remetente para o mesmo destino (até 2 min) vira continuação: sem cabeçalho. Pura. */
export function isContinuation(prev: FeedItem | undefined, item: FeedItem): boolean {
  if (!prev || prev.type !== "message" || item.type !== "message") return false;
  const a = prev.message;
  const b = item.message;
  return a.fromTabId === b.fromTabId && a.toTabId === b.toTabId && a.kind === b.kind && b.atMs - a.atMs <= 120_000;
}

/** Texto comprido demais para mostrar inteiro: o chat dobra e deixa "Ver mais". Pura. */
export function needsCollapse(text: string): boolean {
  return text.length > 480 || text.split("\n").length > 7;
}

// ── Formatação do texto das mensagens ──────────────────────────────────

/** Caminhos, branches e arquivos: o que vale mostrar em fonte de código. */
const ADDRESS = /[A-Za-z]:[\\/][^\s`,;)"'*]+|~\/[^\s`,;)"'*]+|\bcc\/[\w./-]+|\b(?:[\w.-]+\/)+[\w.-]+\.(?:md|tsx?|jsx?|rs|json|toml|cjs|mjs|txt|css|ya?ml|db|exe)\b|\b[\w.-]+\.(?:md|tsx?|rs|json|toml)\b/g;
/** O que já é código (bloco ou trecho entre crases) não se mexe. */
const CODE_SPLIT = /(```[\s\S]*?```|`[^`\n]*`|https?:\/\/[^\s)>\]]+|\]\([^)]*\))/;

/** Põe os endereços (caminhos, branches, arquivos) entre crases, para saírem em fonte de código. Pura. */
export function codeAddresses(text: string): string {
  return text
    .split(CODE_SPLIT)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(ADDRESS, (match) => {
        const trail = /[.:]+$/.exec(match)?.[0] ?? "";
        const core = trail ? match.slice(0, -trail.length) : match;
        return core ? `\`${core}\`${trail}` : match;
      });
    })
    .join("");
}

/** A primeira linha de uma mensagem em várias linhas (o título da tarefa) vira negrito. Pura. */
export function emphasizeTitle(text: string): string {
  const lines = text.split("\n");
  const first = lines[0]?.trim() ?? "";
  if (lines.length < 2 || !first || first.length > 140) return text;
  if (/^(#|\*|-|>|\||\d+[.)]\s|```)/.test(first) || first.includes("**")) return text;
  return [`**${first}**`, "", ...lines.slice(1).filter((l, i) => !(i === 0 && l.trim() === ""))].join("\n");
}

/** O texto como o chat da equipe mostra: título em negrito e endereços em fonte de código. Pura. */
export function formatMessageText(text: string): string {
  return codeAddresses(emphasizeTitle(text.trim()));
}

// ── Avisos do Vigia ────────────────────────────────────────────────────

export type VigiaTone = "warn" | "stuck" | "info";

export interface VigiaNote {
  tone: VigiaTone;
  /** A palavra que o Vigia usou (`aviso`, `travado`…), se houver. */
  label: string | null;
  /** O que ele viu. */
  body: string;
  /** O que ele fez ("Feito: …"), se disse. */
  action: string | null;
}

/**
 * O texto do Vigia vem como `**Vigia** — aviso: o Backend parou. Feito: avisei você na tela.`
 * (às vezes sem o negrito). Tira o prefixo, separa a palavra de gravidade, o que ele viu e o que fez. Pura.
 */
export function parseVigiaText(text: string): VigiaNote {
  let rest = text.replace(/\*\*/g, "").trim().replace(/^vigia\s*[—–-]\s*/i, "");
  let label: string | null = null;
  const head = /^(aviso|travado|aten[cç][aã]o|lembrete|poss[ií]vel la[cç]o):\s+/i.exec(rest);
  if (head && head[1].toLowerCase() !== "feito") {
    label = head[1].toLowerCase();
    rest = rest.slice(head[0].length);
  }
  const split = /\s*\bFeito:\s*/i.exec(rest);
  const body = (split ? rest.slice(0, split.index) : rest).trim();
  const action = split ? rest.slice(split.index + split[0].length).trim() || null : null;
  const tone: VigiaTone = label === "travado" ? "stuck" : label !== null && label !== "lembrete" ? "warn" : "info";
  return { tone, label, body, action };
}
