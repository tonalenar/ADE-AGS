/**
 * O chat unificado da equipe de uma missão: as mensagens entre os agentes e os pedidos de
 * permissão da frota, numa linha do tempo só. Lógica pura; a tela é `TeamFeed.tsx`.
 */
import type { PendingApproval } from "@/features/runs/types";

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
export function buildFeed(messages: TeamMessage[], approvals: { approval: PendingApproval; who: string }[], notes: UserNote[] = []): FeedItem[] {
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
    ...notes.map((n): FeedItem => ({ type: "user", key: n.key, atMs: n.atMs, toName: n.toName, text: n.text })),
  ];
  return items.sort((a, b) => a.atMs - b.atMs || a.key.localeCompare(b.key));
}
