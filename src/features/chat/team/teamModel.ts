/**
 * O modelo puro do time de agentes do modo chat (pranchetas 15 e 16): quem está no time, em que
 * estado, o que o fio do orquestrador mostra, para quem vai a mensagem do composer, o que a sidebar
 * agrupa e o que o canvas precisa ter. Sem React, sem `invoke`.
 *
 * Uma conversa é referida pela chave do cartão da sidebar: o id da aba (TUI) ou `thread:<id>`
 * (conversa por protocolo). É a mesma chave que o backend usa no canvas e no `peer`.
 */
import type { TeamFeedItem, TeamMember, TeamPolicy, TeamView } from "./ipc";

/** O prefixo de uma conversa por protocolo (o mesmo de `structured/model.ts` e de `canvas/board.ts`). */
export const THREAD_REF = "thread:";

export function isThreadRef(ref: string): boolean {
  return ref.startsWith(THREAD_REF) && ref.length > THREAD_REF.length;
}

/** Os papéis que o formulário oferece, na ordem da prancheta (ids do catálogo, `src-tauri/src/roles.rs`). */
export const TEAM_ROLES = ["frontend", "backend", "qa", "reviewer", "researcher", "devops", "generalist"] as const;

/** As políticas, da que mais deixa à que menos deixa (como o menu mostra). */
export const POLICIES: TeamPolicy[] = ["full", "edits", "ask", "read"];

/** Quem só olha nasce só leitura (espelho de `chat_team::model::default_policy`). */
export function defaultPolicy(role: string): TeamPolicy {
  return role === "reviewer" || role === "researcher" ? "read" : "ask";
}

/** A branch do worktree de um integrante novo (espelho de `chat_team::model::branch_for`). */
export function branchFor(role: string): string {
  const slug = role.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const name = slug === "frontend" ? "ui" : slug === "qa" ? "tests" : slug || "membro";
  return `team/${name}`;
}

/**
 * O acesso da conversa nova aberta para um integrante (os modos do chat). Só leitura no Claude Code é
 * o Plano (não edita); nos outros, supervisionado: nunca mais do que a política deixa.
 */
export function conversationAccess(policy: TeamPolicy, agentId: string): { access: "ask" | "edits" | "full"; plan: boolean } {
  if (policy === "read") return { access: "ask", plan: agentId === "claude-code" };
  if (policy === "ask") return { access: "ask", plan: false };
  return { access: policy, plan: false };
}

// ── Quem é quem ──────────────────────────────────────────────────────

export interface TeamPlace {
  team: TeamView;
  /** `null` = é o orquestrador. */
  member: TeamMember | null;
}

/** O time de uma conversa (como orquestrador ou integrante), ou `null`. */
export function placeOf(teams: TeamView[], ref: string | null | undefined): TeamPlace | null {
  if (!ref) return null;
  for (const team of teams) {
    if (team.orchestrator === ref) return { team, member: null };
    const member = team.members.find((m) => m.member === ref);
    if (member) return { team, member };
  }
  return null;
}

/** O time que esta conversa coordena. */
export function teamLedBy(teams: TeamView[], ref: string | null | undefined): TeamView | null {
  return ref ? teams.find((t) => t.orchestrator === ref) ?? null : null;
}

/** Todas as conversas que estão em algum time (para o formulário não oferecer de novo). */
export function takenRefs(teams: TeamView[]): Set<string> {
  return new Set(teams.flatMap((t) => [t.orchestrator, ...t.members.map((m) => m.member)]));
}

// ── Estado ao vivo ───────────────────────────────────────────────────

/** O que se sabe agora de uma conversa (do canal da aba ou dos eventos da conversa por protocolo). */
export interface LiveInput {
  /** A aba (ou a conversa) ainda existe e está ativa. */
  open: boolean;
  working: boolean;
  /** Um pedido de aprovação esperando a pessoa. */
  awaiting: boolean;
  /** Uma pergunta de fim de turno esperando a pessoa. */
  question: boolean;
}

export const CLOSED: LiveInput = { open: false, working: false, awaiting: false, question: false };

export type MemberState = "coordinating" | "working" | "approval" | "question" | "delivered" | "queued" | "idle" | "closed";

/**
 * O estado de um integrante, como a lista e os cartões mostram. O que pede a pessoa vem primeiro; uma
 * entrega só conta se veio depois da última tarefa. Pura.
 */
export function memberState(live: LiveInput, feed: TeamFeedItem[], member: string): MemberState {
  if (!live.open) return "closed";
  if (live.awaiting) return "approval";
  if (live.question) return "question";
  if (live.working) return "working";
  const mine = feed.filter((f) => f.member === member);
  const last = mine[mine.length - 1];
  if (last?.kind === "delivery") return "delivered";
  const lastTask = [...mine].reverse().find((f) => f.kind === "delegation");
  if (lastTask && (lastTask.state === "queued" || lastTask.state === "delivering")) return "queued";
  return "idle";
}

/** O estado do orquestrador: coordena enquanto ele ou alguém do time trabalha. Pura. */
export function orchestratorState(live: LiveInput, members: MemberState[]): MemberState {
  if (!live.open) return "closed";
  if (live.awaiting) return "approval";
  if (live.question) return "question";
  return live.working || members.some((s) => s === "working" || s === "approval" || s === "queued") ? "coordinating" : "idle";
}

/** A cor do estado (classes do tema, nunca um hex): laranja trabalha, âmbar pede, verde entregou. Pura. */
export function stateTone(state: MemberState): string {
  switch (state) {
    case "working":
    case "coordinating":
      return "text-orange-700 dark:text-orange-400";
    case "approval":
    case "question":
      return "text-amber-700 dark:text-amber-400";
    case "delivered":
      return "text-emerald-700 dark:text-emerald-400";
    default:
      return "text-gray-500 dark:text-white/45";
  }
}

/** A letra do quadradinho do agente, como na prancheta (o Codex é "X"). Pura. */
export function agentMono(agentId: string, label: string): string {
  if (agentId.startsWith("codex")) return "X";
  const first = (label || agentId).trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

// ── A lista do painel ────────────────────────────────────────────────

export interface RosterRow {
  ref: string;
  name: string;
  agentId: string;
  /** O modelo e o esforço ("Opus 5.5 · alto"), ou `null` = o padrão do agente. */
  model: string | null;
  /** `orchestrator` ou o id do papel. */
  role: string;
  state: MemberState;
  policy: TeamPolicy | null;
  branch: string | null;
  isThread: boolean;
  /** Marcado como subagente (só os integrantes; o orquestrador não é). */
  subagent: boolean;
}

export interface RosterContext {
  /** O nome de agora (título da aba ou da conversa); `null` = não está aberta. */
  nameOf: (ref: string) => string | null;
  liveOf: (ref: string) => LiveInput;
  modelOf: (ref: string) => string | null;
  branchOf: (ref: string) => string | null;
  /** O acesso da conversa do orquestrador, como política. */
  orchestratorPolicy: TeamPolicy | null;
}

/** O orquestrador primeiro, depois os integrantes na ordem em que entraram. Pura. */
export function rosterRows(team: TeamView, feed: TeamFeedItem[], ctx: RosterContext): RosterRow[] {
  const members = team.members.map((m): RosterRow => ({
    ref: m.member,
    name: ctx.nameOf(m.member) ?? (m.label || m.agentId),
    agentId: m.agentId,
    // O de agora (modelo · esforço, da conversa ou da aba) vale mais que o gravado ao ligar (só o modelo).
    model: ctx.modelOf(m.member) ?? m.model,
    role: m.role,
    state: memberState(ctx.liveOf(m.member), feed, m.member),
    policy: m.policy,
    branch: m.branch ?? ctx.branchOf(m.member),
    isThread: isThreadRef(m.member),
    subagent: m.subagent,
  }));
  const lead: RosterRow = {
    ref: team.orchestrator,
    name: ctx.nameOf(team.orchestrator) ?? (team.label || team.agentId),
    agentId: team.agentId,
    model: ctx.modelOf(team.orchestrator),
    role: "orchestrator",
    state: orchestratorState(ctx.liveOf(team.orchestrator), members.map((m) => m.state)),
    policy: ctx.orchestratorPolicy,
    branch: ctx.branchOf(team.orchestrator),
    isThread: isThreadRef(team.orchestrator),
    subagent: false,
  };
  return [lead, ...members];
}

// ── O fio do orquestrador ────────────────────────────────────────────

export interface DelegationCard {
  member: string;
  memberName: string;
  task: string;
  /** O id da mensagem da delegação. */
  id: number;
  at: number;
  /** O estado do integrante para esta tarefa: entregou depois dela, ou o estado de agora. */
  state: MemberState;
  /** A entrega que respondeu a esta tarefa, se houve. */
  handoff: number | null;
}

/**
 * Um cartão por integrante com a última tarefa que o orquestrador deu, na ordem em que foram dadas; uma
 * entrega depois dela marca "entregou". Pura.
 */
export function delegationCards(feed: TeamFeedItem[], stateOf: (member: string) => MemberState): DelegationCard[] {
  const latest = new Map<string, TeamFeedItem>();
  for (const item of feed) if (item.kind === "delegation") latest.set(item.member, item);
  return [...latest.values()]
    .sort((a, b) => a.id - b.id)
    .map((task) => {
      const delivery = feed.find((f) => f.kind === "delivery" && f.member === task.member && f.id > task.id);
      return {
        member: task.member,
        memberName: task.memberName,
        task: task.task,
        id: task.id,
        at: task.at,
        state: delivery ? "delivered" : stateOf(task.member),
        handoff: delivery?.handoff ?? null,
      };
    });
}

/** As entregas (Handoff v1) que voltaram, das mais velhas para as mais novas. Pura. */
export function deliveries(feed: TeamFeedItem[]): TeamFeedItem[] {
  return feed.filter((f) => f.kind === "delivery");
}

// ── O composer: Time | Só o orquestrador e o @agente ────────────────

export type ComposerTarget = "team" | "lead";

/** O apelido de um agente para o @ (sem espaços, minúsculo, sem acento). Pura. */
export function mentionSlug(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** O que está sendo escrito depois de um `@` no cursor, ou `null`. Pura. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([\p{L}\p{N}_-]*)$/u.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, query };
}

/** Troca o `@consulta` no cursor pelo apelido escolhido. Devolve o texto e o cursor novo. Pura. */
export function applyMention(text: string, caret: number, name: string): { text: string; caret: number } {
  const found = mentionQuery(text, caret);
  if (!found) return { text, caret };
  const insert = `@${mentionSlug(name)} `;
  const next = text.slice(0, found.start) + insert + text.slice(caret);
  return { text: next, caret: found.start + insert.length };
}

export interface MentionOption {
  ref: string;
  name: string;
  agentId: string;
  role: string;
}

/** Quem combina com a consulta, pelo nome ou pelo agente. Pura. */
export function mentionOptions(options: MentionOption[], query: string): MentionOption[] {
  const q = mentionSlug(query);
  return options.filter((o) => !q || mentionSlug(o.name).includes(q) || mentionSlug(o.agentId).includes(q) || mentionSlug(o.role).includes(q));
}

/** Para onde vai uma mensagem do composer e com que texto. */
export interface Routed {
  to: string;
  text: string;
  /** Foi direto a um integrante pelo @. */
  direct: boolean;
}

/** O texto com que uma mensagem chega ao orquestrador no modo "Só o orquestrador". */
export const LEAD_ONLY_PREFIX = "[Só o orquestrador] Responda você mesmo, sem delegar ao time:";

/**
 * Para onde vai a mensagem: começando com `@apelido` de um integrante, só para ele (sem o @); senão para
 * o orquestrador, com o resumo do time quando ele mudou (`notice`) no modo Time, ou com o aviso de não
 * delegar no "Só o orquestrador". Pura.
 */
export function routeMessage(text: string, target: ComposerTarget, team: TeamView, options: MentionOption[], notice: string | null): Routed {
  const clean = text.trim();
  const mention = /^@([\p{L}\p{N}_-]+)\s+([\s\S]+)$/u.exec(clean);
  if (mention) {
    const slug = mentionSlug(mention[1]!);
    const hits = options.filter((o) => o.ref !== team.orchestrator && (mentionSlug(o.name) === slug || mentionSlug(o.agentId) === slug));
    if (hits.length === 1) return { to: hits[0]!.ref, text: mention[2]!.trim(), direct: true };
  }
  if (target === "lead") return { to: team.orchestrator, text: `${LEAD_ONLY_PREFIX}\n${clean}`, direct: false };
  return { to: team.orchestrator, text: notice ? `${notice}\n\n${clean}` : clean, direct: false };
}

/** O que identifica a composição do time (quem, papel e política): mudou, o orquestrador recebe o resumo de novo. Pura. */
export function rosterSignature(team: TeamView): string {
  return team.members.map((m) => `${m.member}:${m.role}:${m.policy}`).join("|");
}

/**
 * O resumo do time para o orquestrador (espelho de `chat_team::model::roster_notice`). `roleLabel` é o
 * nome do papel; os nomes são os de agora. Pura.
 */
export function rosterNotice(team: TeamView, nameOf: (ref: string) => string | null, roleLabel: (role: string) => string, policyLabel: (p: TeamPolicy) => string): string {
  if (team.members.length === 0) {
    return "[ADE AGS] Você é o orquestrador deste time, mas ainda não há ninguém ligado. Peça à pessoa para ligar agentes no painel Time.";
  }
  const list = team.members.map((m) => {
    const branch = m.branch ? `, ${m.branch}` : "";
    return `${nameOf(m.member) ?? (m.label || m.member)} (${m.agentId}; ${roleLabel(m.role)}; ${policyLabel(m.policy)}${branch})`;
  }).join(", ");
  return `[ADE AGS] Você é o orquestrador deste time: ${list}. Delegue em ~2 min com \`ags peer tell <nome> --task "..." --expecting "..."\` `
    + "e encerre o turno; as entregas voltam como mensagem. Use `ags team list` para ver o time.";
}

// ── A sidebar ────────────────────────────────────────────────────────

export interface SidebarGrouping {
  /** As conversas que aparecem indentadas sob o orquestrador (e saem da lista principal). */
  nested: Set<string>;
  /** Por orquestrador, os integrantes na ordem do time (só os que têm cartão). */
  groups: Record<string, string[]>;
}

/**
 * Agrupa o time sob a conversa do orquestrador: os integrantes saem da lista e aparecem indentados
 * embaixo dele. Só quando o orquestrador tem cartão (senão o integrante continua solto). Pura.
 */
export function sidebarGrouping(cardKeys: string[], teams: TeamView[]): SidebarGrouping {
  const present = new Set(cardKeys);
  const nested = new Set<string>();
  const groups: Record<string, string[]> = {};
  for (const team of teams) {
    if (!present.has(team.orchestrator)) continue;
    const members = team.members.map((m) => m.member).filter((ref) => present.has(ref) && ref !== team.orchestrator);
    groups[team.orchestrator] = members;
    for (const ref of members) nested.add(ref);
  }
  return { nested, groups };
}

// ── Arrastar uma conversa da sidebar para o painel ───────────────────

/** O tipo do dado arrastado: a chave do cartão. */
export const CONVERSATION_DRAG_MIME = "application/x-ade-conversation";
