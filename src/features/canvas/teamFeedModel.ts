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

/**
 * `@Backend faça X` → { to: Backend, text: "faça X" }. Casa o nome inteiro (`@QA / Tests`) ou só a
 * primeira palavra dele (`@QA`), sem diferenciar maiúsculas; vale o mais longo. Sem menção, `null`.
 * A menção tem de ser o começo da mensagem: um `@` no meio do texto é só texto. Pura.
 */
export function parseMention(input: string, team: Addressee[]): { to: Addressee; text: string } | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("@")) return null;
  const body = trimmed.slice(1);
  const lower = body.toLowerCase();
  const candidates = team
    .flatMap((member) => {
      const full = member.name.trim();
      const first = full.split(/\s+/)[0] ?? full;
      return [full, first].filter(Boolean).map((label) => ({ member, label }));
    })
    .sort((a, b) => b.label.length - a.label.length);
  for (const { member, label } of candidates) {
    const l = label.toLowerCase();
    if (!lower.startsWith(l)) continue;
    const next = body.charAt(l.length);
    if (next !== "" && !/\s/.test(next)) continue;
    const text = body.slice(l.length).trim();
    return text ? { to: member, text } : null;
  }
  return null;
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
