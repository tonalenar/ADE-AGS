import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { linkedPeers } from "@/features/canvas/orchestratorNotice";
import { boardKeyOfTab, conversationOfKey, useCanvasStore } from "@/features/canvas/store";
import type { Board } from "@/features/canvas/board";
import { conversationTitle, parseTerminals } from "@/features/sessions/conversationModel";
import { useConversationsStore } from "@/features/sessions/conversationsStore";
import type { Tab } from "@/features/tabs/types";
import { useTabsStore } from "@/features/tabs/store";
import { lastOutputAt } from "@/features/terminal/activity";
import { screenOf, sendWhenReady } from "@/features/terminal/terminalRegistry";
import { structuredOf, structuredVerdict, workingWith } from "@/features/terminal/structuredState";
import { showBotToast } from "@/shared/brand/botToastStore";
import { missionIndex, tabsByMission } from "./groups";
import { useMissionsStore } from "./store";
import { isWorking } from "./stalled";
import { prematureClosing } from "./vigiaClosing";
import { LOOP_DONE, loopStep, loopStuck, type LoopWatch } from "./vigiaLoop";
import { isFinalReport, memberFinished, pokeAllowed } from "./vigiaPoke";
import { repeatAfterEach } from "./repeatAfterEach";
import { vigiaActive } from "./vigiaSwitch";
import { conversationWatchable, freshEntries, PEERS_KEEP_MS, userDecisionAllowed } from "./vigiaConversation";

/**
 * O Vigia: um vigia BARATO, em segundo plano e SEM TERMINAL, que destrava a missão e conta no chat
 * o que travou e o que foi feito. Tudo começa no Orquestrador: o Vigia só o lembra de agir.
 *
 * Duas camadas, da mais barata para a mais cara:
 * 1. Regras sem modelo (`watchdogFinding`): o Orquestrador não delega há tempo com integrantes sem
 *    tarefa, ou a equipe inteira parou sem ninguém falar. Aí o próprio app manda o lembrete ao
 *    Orquestrador e escreve no chat o que travou. Custo zero.
 * 2. Modelo headless (`vigia_check`): só quando as regras não acham nada e alguém está ocioso,
 *    uma chamada barata lê o fim das telas e sugere a mensagem. O erro dele também vai ao chat:
 *    antes um erro sumia, e a missão parecia vigiada sem estar.
 */
export const VIGIA_NAME = "Vigia";
/** Sem saída por isto = candidato a ocioso. */
export const VIGIA_IDLE_MS = 90_000;
/** O mesmo agente não é reportado de novo antes disto (também é o intervalo entre lembretes). */
export const VIGIA_COOLDOWN_MS = 4 * 60_000;
/** Cada quanto o app confere a equipe. */
export const VIGIA_TICK_MS = 30_000;
/** Equipe quieta e o Orquestrador sem mandar nada por isto = travado. */
export const LEAD_SILENT_MS = 3 * 60_000;
/** Integrante sem tarefa depois disto do começo, com o Orquestrador sem mandar nada = travado. */
export const UNTASKED_MS = 5 * 60_000;
/** Integrante com uma tarefa aberta há isto, sem reportar nada, é cobrado do Orquestrador (status). */
export const OPEN_TASK_MS = 30 * 60_000;
/** Lembretes sem resposta do Orquestrador antes de só registrar no chat e parar de insistir. */
export const NUDGE_LIMIT = 3;
/** Um erro do modelo vai ao chat no máximo a cada isto. */
export const ERROR_REPORT_MS = 10 * 60_000;

export interface VigiaAgent { agentId: string; model: string; effort: string }

/**
 * Qual modelo barato usar, conforme o provedor do Orquestrador: Claude Code → Haiku (esforço
 * médio); Codex → GPT-6 Luna (esforço max). Outro provedor: o primeiro dos dois instalado.
 * `null` se nenhum estiver. Pura.
 */
export function vigiaAgentFor(leadAgentId: string, available: readonly string[]): VigiaAgent | null {
  const claude: VigiaAgent = { agentId: "claude-code", model: "haiku", effort: "medium" };
  const codex: VigiaAgent = { agentId: "codex", model: "gpt-6-luna", effort: "max" };
  if (leadAgentId === "codex" && available.includes("codex")) return codex;
  if (leadAgentId === "claude-code" && available.includes("claude-code")) return claude;
  if (available.includes("claude-code")) return claude;
  if (available.includes("codex")) return codex;
  return null;
}

/**
 * Quem está sem saída há `VIGIA_IDLE_MS` e não foi reportado nos últimos `VIGIA_COOLDOWN_MS`.
 * `lastPoke` guarda quando cada aba foi reportada. Pura.
 */
export function idleCandidates<T extends { id: string }>(
  tabs: readonly T[],
  now: number,
  lastOutput: (tabId: string) => number | undefined,
  lastPoke: ReadonlyMap<string, number>,
): T[] {
  return tabs.filter((tab) => {
    const out = lastOutput(tab.id);
    if (out !== undefined && now - out < VIGIA_IDLE_MS) return false;
    const poked = lastPoke.get(tab.id);
    return poked === undefined || now - poked >= VIGIA_COOLDOWN_MS;
  });
}

export interface WatchMember {
  id: string;
  name: string;
  /** Já recebeu alguma mensagem de outro agente (uma tarefa, na prática). */
  hasTask: boolean;
  lastOutput?: number;
  /** Quando recebeu a última mensagem. */
  taskAt?: number;
  /** Quando mandou a última mensagem a alguém (ou `undefined` se nunca mandou). */
  reportedAt?: number;
}

export interface WatchInput {
  now: number;
  /** Quando a missão começou a rodar (o briefing sai logo depois). */
  startedAt: number;
  lead: { id: string; name: string; lastOutput?: number };
  members: WatchMember[];
  /** Último `tell`/`ask` que o Orquestrador mandou. */
  leadLastSent?: number;
  /** Lembretes já mandados sem o Orquestrador reagir. */
  nudges: number;
  lastNudge?: number;
}

export type WatchFinding =
  | { kind: "untasked" | "open" | "silent"; stuck: string; nudge: string }
  | { kind: "limit"; stuck: string }
  | { kind: "done"; stuck: string };

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/**
 * O que está travado agora, sem modelo: o Orquestrador parado sem delegar, ou a equipe inteira
 * quieta sem ninguém falar. `null` = nada travado (ou ainda no cooldown do último lembrete). Pura.
 */
export function watchdogFinding(input: WatchInput): WatchFinding | null {
  const { now, startedAt, lead, members, leadLastSent, nudges, lastNudge } = input;
  // Todo mundo que recebeu tarefa já reportou e a equipe está quieta: a missão acabou. Não há o
  // que destravar, só falta concluí-la na tela (antes o Vigia seguia acusando "equipe parada").
  const withTask = members.filter((m) => m.taskAt !== undefined);
  const delivered = members.length > 0 && withTask.length > 0 && members.every((m) => m.hasTask)
    && withTask.every((m) => m.reportedAt !== undefined && m.reportedAt >= (m.taskAt ?? 0));
  if (delivered
    && now - (lead.lastOutput ?? startedAt) >= LEAD_SILENT_MS
    && members.every((m) => now - (m.lastOutput ?? startedAt) >= LEAD_SILENT_MS)) {
    return { kind: "done", stuck: "todos os integrantes reportaram" };
  }
  if (lastNudge !== undefined && now - lastNudge < VIGIA_COOLDOWN_MS) return null;
  const lastSent = leadLastSent ?? startedAt;
  const untasked = members.filter((m) => !m.hasTask);
  let finding: { kind: "untasked" | "open" | "silent"; stuck: string; nudge: string } | null = null;
  // Tarefa aberta: recebeu e não mandou nada desde então. Em missão longa é o integrante que
  // sumiu no meio (o trabalho pode ser legítimo, então só pede o status ao Orquestrador).
  const openTasks = members.filter((m) => m.taskAt !== undefined && now - m.taskAt >= OPEN_TASK_MS && (m.reportedAt === undefined || m.reportedAt < m.taskAt));
  if (untasked.length > 0 && now - startedAt >= UNTASKED_MS && now - lastSent >= UNTASKED_MS) {
    const names = untasked.map((m) => m.name).join(", ");
    finding = {
      kind: "untasked",
      stuck: `${names} sem tarefa há ${minutes(now - startedAt)} min; o ${lead.name} não enviou nada há ${minutes(now - lastSent)} min.`,
      nudge: `Você ainda não delegou a: ${names}. Mande a tarefa de cada um agora, com \`ags peer tell "<nome>" --file <arquivo>\` (o texto num arquivo fora do repositório). Se já delegou, ignore este aviso.`,
    };
  } else if (openTasks.length > 0) {
    const names = openTasks.map((m) => m.name).join(", ");
    const since = Math.min(...openTasks.map((m) => m.taskAt ?? now));
    finding = {
      kind: "open",
      stuck: `${names} há ${minutes(now - since)} min na mesma tarefa, sem reportar nada.`,
      nudge: `Peça o status a: ${names}, com \`ags peer check <nome>\` (ou \`ags peer ask\`). Quem terminou e não reportou, peça o relatório; quem está preso, reenvie a tarefa com \`ags peer tell "<nome>" --file <arquivo>\`. Se estiver trabalhando bem, ignore este aviso.`,
    };
  } else {
    const quiet = (at: number | undefined) => now - (at ?? startedAt) >= LEAD_SILENT_MS;
    const teamQuiet = quiet(lead.lastOutput) && quiet(leadLastSent) && members.every((m) => quiet(m.lastOutput));
    if (members.length > 0 && teamQuiet && now - startedAt >= LEAD_SILENT_MS) {
      finding = {
        kind: "silent",
        stuck: `equipe parada há ${minutes(LEAD_SILENT_MS)} min ou mais: ninguém escreve e o ${lead.name} não manda nada.`,
        nudge: "Toda a equipe está parada. Veja cada integrante com `ags peer check <nome>`: quem terminou e não reportou, peça o relatório; quem não tem tarefa, delegue agora com `ags peer tell \"<nome>\" --file <arquivo>`.",
      };
    }
  }
  if (!finding) return null;
  if (nudges >= NUDGE_LIMIT) return { kind: "limit", stuck: finding.stuck };
  return finding;
}

/** Linha do Vigia no chat: o que travou e o que foi feito. Pura. */
export function reportLine(stuck: string, done: string, label = "travado"): string {
  return `**Vigia** — ${label}: ${stuck} Feito: ${done}`;
}

/** O aviso de que a equipe inteira entregou: não é travamento, falta só concluir a missão. Pura. */
export function doneLine(): string {
  return "**Vigia** — equipe entregou: todos os integrantes reportaram e estão parados. Falta só concluir a missão em Missões (Finalizar); não há nada para destravar.";
}

/**
 * Uma mensagem de encerramento ou de espera ("Encerrado", "aguarde, sem nova tarefa") não é uma
 * tarefa: não reabre o trabalho de ninguém. Pura.
 */
export function isClosure(text: string | null | undefined): boolean {
  return /encerrad|conclu[ií]d|finalizad|sem (nova )?tarefa|n[ãa]o h[áa] mais tarefa|\baguard(e|ando|ar)\b|fique em espera/i.test(text ?? "");
}

interface VigiaAction { to: string; message: string }

/** Estado do Vigia por missão: quando começou e quantos lembretes foram sem resposta. */
export interface Watch { startedAt: number; nudges: number; lastNudge?: number; limitReported: boolean; doneAt?: number }

/**
 * O estado do Vigia depois de olhar a última TAREFA que o Orquestrador delegou (`latestTask`, o maior
 * `taskAt` do time). Pura.
 *
 * Antes qualquer mensagem do Orquestrador (um "ok", um "obrigado", uma resposta ao usuário) zerava a
 * conta de lembretes e rearmava o "equipe entregou": no banco real o mesmo "travado há N min" saiu 32
 * vezes numa missão, sempre como "lembrete 1/3", e o "equipe entregou" 8 vezes em 13 h. Agora só uma
 * tarefa nova (que já não conta "encerrado"/"aguarde", ver `isClosure`) faz isso.
 */
export function refreshWatch(watch: Watch, latestTask: number | undefined): Watch {
  if (latestTask === undefined) return watch;
  let next = watch;
  // Voltou a delegar depois do aviso de "entregou": vale outro quando acabar de novo.
  if (next.doneAt !== undefined && latestTask > next.doneAt) next = { ...next, doneAt: undefined };
  // Delegou depois do último lembrete: a conta recomeça.
  if (next.lastNudge !== undefined && latestTask > next.lastNudge) next = { ...next, nudges: 0, lastNudge: undefined, limitReported: false };
  return next;
}

/** O estado guardado por missão some depois disto (missões antigas não ficam no armazenamento). */
export const WATCH_KEEP_MS = 3 * 24 * 60 * 60_000;

/**
 * Quando cada aba mandou (`sentAt`) e recebeu (`gotAt`) uma mensagem entre agentes, e quando
 * recebeu a última TAREFA (`taskAt`, sem contar "encerrado"/"aguarde") e entregou (`finishedAt`). Ficam guardadas: ao
 * reabrir o app o Vigia lembrava de nada e acusava "você ainda não delegou" de uma missão pronta.
 */
const STORE_KEY = "ags.vigia.peers.v1";
function loadPeers(): { sent: Map<string, number>; got: Map<string, number>; task: Map<string, number>; finished: Map<string, number> } {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, Record<string, number>>;
    // As antigas saem: a mesma aba reaproveitada trazia "tem tarefa"/"reportou" de outro projeto.
    const cutoff = Date.now() - PEERS_KEEP_MS;
    const toMap = (o: Record<string, number> | undefined) => freshEntries(o, cutoff);
    return { sent: toMap(raw.sent), got: toMap(raw.got), task: toMap(raw.task), finished: toMap(raw.finished) };
  } catch {
    return { sent: new Map(), got: new Map(), task: new Map(), finished: new Map() };
  }
}
const peers = loadPeers();
const sentAt = peers.sent;
const gotAt = peers.got;
const taskAt = peers.task;
const finishedAt = peers.finished;
function rememberPeers(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ sent: Object.fromEntries(sentAt), got: Object.fromEntries(gotAt), task: Object.fromEntries(taskAt), finished: Object.fromEntries(finishedAt) }));
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
}
/**
 * O estado de cada missão também fica guardado: antes vivia só em memória e um HMR ou reabrir o app
 * repetia o "equipe entregou" e recomeçava a conta de lembretes.
 */
const WATCH_STORE_KEY = "ags.vigia.watches.v1";
function loadWatches(): Map<string, Watch> {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCH_STORE_KEY) ?? "{}") as Record<string, Watch>;
    const cutoff = Date.now() - WATCH_KEEP_MS;
    return new Map(Object.entries(raw).filter(([, w]) => w && Number.isFinite(w.startedAt) && w.startedAt >= cutoff));
  } catch {
    return new Map();
  }
}
const watches = loadWatches();
function rememberWatches(): void {
  try {
    localStorage.setItem(WATCH_STORE_KEY, JSON.stringify(Object.fromEntries(watches)));
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
}
/** Quando cada aba foi reportada ao modelo; missões com uma consulta em andamento. */
const lastPoke = new Map<string, number>();
const inFlight = new Set<string>();
const lastErrorReport = new Map<string, number>();
/** Quando o Vigia escreveu pela última vez no terminal de cada aba (uma cutucada por vez). */
const pokes = new Map<string, number>();

/** O destino está trabalhando agora? A tela, somada ao transcript (Claude Code/Codex) quando há canal. */
function busyNow(tabId: string): boolean {
  return workingWith(tabId, isWorking(screenOf(tabId)?.lines ?? []));
}

/** Pode escrever no terminal desta aba agora? Ver `pokeAllowed`. O interruptor vem primeiro (falha fechada). */
function mayPoke(tabId: string, now: number): boolean {
  // Um turno aberto no transcript (ferramenta longa e calada, diálogo de aprovação) também segura a cutucada.
  return vigiaActive() && pokeAllowed(pokes.get(tabId), sentAt.get(tabId), busyNow(tabId), now);
}

/**
 * Pura: a rechecagem logo antes de colar (a decisão veio do ciclo; entre ela e a colagem a TUI pode ter
 * voltado a trabalhar, ou o usuário desligou o Vigia). Só cola com o Vigia ligado e o destino parado.
 */
export function pokeGuard(active: () => boolean, busy: () => boolean): boolean {
  return active() && !busy();
}

function poke(tabId: string, text: string, now: number, onSent: () => void): void {
  const guard = () => pokeGuard(vigiaActive, () => busyNow(tabId));
  // Checado AQUI (onde o trabalho começa) e de novo dentro de `sendWhenReady`, logo antes de colar.
  if (!guard()) return;
  pokes.set(tabId, now);
  sendWhenReady(tabId, text, {
    guard,
    onSent: (at) => {
      pokes.set(tabId, at);
      onSent();
    },
  });
}

/** Por terminal Codex: desde quando a tela está igual (fora os contadores) em "Working". */
const loops = new Map<string, LoopWatch>();

/** Aviso do sistema ao usuário (e, na entrega, o span `team_delivered`). Ver `vigia_notify_user`. */
function notifyUser(missionId: string, missionTitle: string, kind: "team_delivered" | "user_decision", body?: string): void {
  invoke("vigia_notify_user", { missionId, missionTitle, kind, body: body ?? null }).catch((error: unknown) => console.error("[Vigia] não foi possível avisar o usuário", error));
}

/** Escreve no chat e no feed; falhas ficam visíveis no console do app. */
function reportToChat(tabId: string, text: string): void {
  invoke("vigia_report", { tabId, text }).catch((error: unknown) => console.error("[Vigia] não foi possível registrar o aviso", error));
}

/**
 * Terminais Codex no laço de raciocínio vazio: o spinner escreve (nem o silêncio de saída acusa),
 * mas a tela não muda há minutos. Só avisa (chat e tela); não interrompe o agente.
 */
function watchLoops(team: readonly { id: string; title: string; agentId: string }[], leadId: string, now: number): void {
  for (const tab of team) {
    if (tab.agentId !== "codex") continue;
    const step = loopStep(loops.get(tab.id), screenOf(tab.id)?.lines ?? null, now);
    if (step.next) loops.set(tab.id, step.next);
    else loops.delete(tab.id);
    if (step.stuckMs === undefined) continue;
    const stuck = loopStuck(tab.title, step.stuckMs);
    showBotToast({ title: VIGIA_NAME, text: stuck, tone: "warning", ms: 12_000 });
    reportToChat(leadId, reportLine(stuck, LOOP_DONE, "possível laço"));
  }
}

/**
 * Quando a missão começou, em milissegundos (a unidade de `now`). `mission.startedAt` vem do banco
 * em SEGUNDOS (epoch); sem converter, `now - startedAt` vale ~1,8e12 e o primeiro ciclo já acusa
 * "sem tarefa há milhões de minutos". Pura.
 */
export function missionStartMs(startedAtSec: number | null, now: number): number {
  return startedAtSec != null ? startedAtSec * 1000 : now;
}

/** O que o Vigia supervisiona: uma missão em andamento ou o time montado numa conversa de projeto. */
interface WatchedTeam {
  id: string;
  kind: "mission" | "conversation";
  title: string;
  /** Epoch em segundos (como vem do banco) ou `null` = desde que o Vigia viu o time. */
  startedAt: number | null;
  team: Tab[];
  lead: Tab;
}

/** Quando o Orquestrador foi avisado do fechamento antecipado de cada time, e quantas vezes seguidas. */
const closingNudges = new Map<string, { at: number; count: number }>();
/** O mesmo aviso de fechamento antecipado não se repete antes disto. */
export const CLOSING_COOLDOWN_MS = 3 * 60_000;

/**
 * Os times de conversa: o Orquestrador do canvas `#c:` com os terminais ligados a ele por corda que já
 * receberam tarefa dele. Fica de fora a conversa guardada, a sem delegação e a dormente (ver
 * `conversationWatchable`); um terminal ligado sem tarefa não é cobrado nem segura o "entregou".
 */
function conversationTeams(tabs: Tab[], boards: Record<string, Board>, now: number): WatchedTeam[] {
  const rows = useConversationsStore.getState().rows;
  const out: WatchedTeam[] = [];
  for (const [key, board] of Object.entries(boards)) {
    const conversation = conversationOfKey(key);
    if (!conversation) continue;
    const open = tabs.filter((tab) => tab.agentId !== "bash" && boardKeyOfTab(tab, boards) === key);
    const lead = open.find((tab) => board.orchestrators.includes(tab.id));
    if (!lead) continue;
    const linked = new Set(linkedPeers(board, lead.id));
    const members = open.filter((tab) => tab.id !== lead.id && linked.has(tab.id) && taskAt.has(tab.id));
    const team = [lead, ...members];
    const row = rows.find((r) => r.id === conversation) ?? null;
    if (!conversationWatchable({
      now,
      state: row?.state ?? null,
      taskTimes: members.map((tab) => taskAt.get(tab.id) as number),
      activity: team.flatMap((tab) => [lastOutputAt(tab.id), sentAt.get(tab.id)]),
    })) continue;
    // O nome da conversa, não o do terminal ("Decisão pendente — Claude Code" não dizia qual era).
    const title = row ? conversationTitle(row, parseTerminals(row.terminals)) : lead.title.split(" — ")[0];
    out.push({ id: `c:${conversation}`, kind: "conversation", title, startedAt: null, team, lead });
  }
  return out;
}

/** A última tarefa que o Orquestrador delegou a alguém do time (a "rodada"). */
function latestTask(mission: WatchedTeam): number | undefined {
  const times = mission.team.filter((tab) => tab.id !== mission.lead.id).map((tab) => taskAt.get(tab.id)).filter((at): at is number => at !== undefined);
  return times.length > 0 ? Math.max(...times) : undefined;
}

/** A rodada em que cada missão já avisou "Decisão pendente" ao usuário. */
const userDecisionRounds = new Map<string, number>();

/**
 * Um passo: as regras sem modelo primeiro; se não acharem nada, o modelo barato para os ociosos. A
 * promessa termina quando as consultas ao modelo deste passo terminam: o ciclo (`repeatAfterEach`) só
 * agenda o próximo depois disso.
 */
export function vigiaTick(now = Date.now()): Promise<void> {
  const pending: Promise<unknown>[] = [];
  // Desligado por padrão: o Vigia só age (lembra, cutuca, consulta o modelo) quando o usuário liga o
  // botão ao lado do chat. A detecção de "equipe entregou" roda sempre, só com regras e sem escrever em
  // terminal nenhum: é ela que avisa o usuário de que falta Finalizar.
  const enabled = vigiaActive();
  const { tabs, detectedAgents } = useTabsStore.getState();
  const running = useMissionsStore.getState().missions.filter((m) => m.status === "running");
  const boards = useCanvasStore.getState().boards;
  const byMission = tabsByMission(missionIndex(boards, tabs), tabs);
  const available = detectedAgents.filter((a) => a.available).map((a) => a.id);
  const watched: WatchedTeam[] = [];
  for (const mission of running) {
    const team = (byMission[mission.id] ?? [])
      .map((id) => tabs.find((tab) => tab.id === id))
      .filter((tab): tab is NonNullable<typeof tab> => !!tab && tab.agentId !== "bash");
    const board = Object.entries(boards).find(([key]) => key.endsWith(`#m:${mission.id}`))?.[1];
    const lead = team.find((tab) => board?.orchestrators.includes(tab.id)) ?? team[0];
    if (lead) watched.push({ id: mission.id, kind: "mission", title: mission.title, startedAt: mission.startedAt, team, lead });
  }
  // Uma conversa com o time montado (sem missão) também é supervisionada, enquanto tem trabalho delegado.
  if (enabled) watched.push(...conversationTeams(tabs, boards, now));
  for (const mission of watched) {
    const { team, lead } = mission;
    if (!enabled) {
      deliveryOnly(mission, now);
      continue;
    }
    watchLoops(team, lead.id, now);

    // Fechamento antecipado: o Orquestrador pede o OK para commit/PR com integrante ainda trabalhando.
    const closing = prematureClosing({
      leadLines: screenOf(lead.id)?.lines ?? null,
      members: team.filter((tab) => tab.id !== lead.id).map((tab) => ({
        name: tab.title.split(" — ")[0],
        working: workingWith(tab.id, isWorking(screenOf(tab.id)?.lines ?? [])),
        owesReport: taskAt.has(tab.id) && !memberFinished(taskAt.get(tab.id), finishedAt.get(tab.id)),
      })),
    });
    if (closing) {
      const before = closingNudges.get(mission.id);
      if ((!before || now - before.at >= CLOSING_COOLDOWN_MS) && (before?.count ?? 0) < NUDGE_LIMIT && mayPoke(lead.id, now)) {
        showBotToast({ title: VIGIA_NAME, text: closing.stuck, tone: "warning", ms: 12_000 });
        poke(lead.id, `[${VIGIA_NAME}] ${closing.nudge}`, now, () => {
          closingNudges.set(mission.id, { at: Date.now(), count: (closingNudges.get(mission.id)?.count ?? 0) + 1 });
          reportToChat(lead.id, reportLine(closing.stuck, `lembrei o ${lead.title.split(" — ")[0]} de esperar a entrega.`, "fechamento antecipado"));
        });
      }
      continue;
    }
    // Voltou ao normal: um próximo fechamento antecipado vale um aviso novo.
    closingNudges.delete(mission.id);

    const { watch, finding } = watchState(mission, now);
    if (finding?.kind === "done") {
      if (watch.doneAt === undefined) {
        watch.doneAt = now;
        rememberWatches();
        reportToChat(lead.id, doneLine());
        notifyUser(mission.id, mission.title, "team_delivered");
      }
      continue;
    }
    if (finding?.kind === "limit") {
      if (!watch.limitReported) {
        watch.limitReported = true;
        rememberWatches();
        reportToChat(lead.id, reportLine(finding.stuck, `já lembrei ${NUDGE_LIMIT} vezes e não houve resposta. Parei de insistir: reenvie a tarefa ao integrante parado ou finalize a missão.`));
      }
      continue;
    }
    if (finding) {
      // Orquestrador trabalhando, ou sem responder à cutucada anterior: espera o próximo ciclo.
      if (!mayPoke(lead.id, now)) continue;
      poke(lead.id, `[${VIGIA_NAME}] ${finding.nudge}`, now, () => {
        watch.nudges += 1;
        watch.lastNudge = Date.now();
        rememberWatches();
        reportToChat(lead.id, reportLine(finding.stuck, `lembrete ${watch.nudges}/${NUDGE_LIMIT} enviado ao ${lead.title}.`));
      });
      continue;
    }

    if (inFlight.has(mission.id)) continue;
    // Equipe que já entregou, ou integrante que já reportou a tarefa: parados com razão, não travados.
    if (watch.doneAt !== undefined) continue;
    // Sem saída há 90 s mas com o turno aberto no transcript não é ocioso: é uma ferramenta longa.
    // Numa conversa o Orquestrador parado está esperando o usuário, que conversa com ele: não é ocioso.
    const suspects = mission.kind === "conversation" ? team.filter((tab) => tab.id !== lead.id) : team;
    const idle = idleCandidates(suspects, now, lastOutputAt, lastPoke).filter((tab) => !memberFinished(taskAt.get(tab.id), finishedAt.get(tab.id)) && structuredVerdict(structuredOf(tab.id)) !== true);
    if (idle.length === 0) continue;
    const pick = vigiaAgentFor(lead.agentId, available);
    if (!pick) continue;
    for (const tab of idle) lastPoke.set(tab.id, now);
    inFlight.add(mission.id);
    pending.push(invoke<VigiaAction[]>("vigia_check", {
      agentId: pick.agentId,
      model: pick.model,
      effort: pick.effort,
      missionTitle: mission.title,
      cwd: lead.cwd,
      lead: { tabId: lead.id, name: lead.title },
      idle: idle.map((tab) => ({ tabId: tab.id, name: tab.title })),
    })
      .then((actions) => {
        for (const action of actions) {
          // A resposta chega até 2 min depois: o Vigia pode ter sido desligado no meio.
          if (!vigiaActive()) return;
          if (action.to === "usuario") {
            // Uma vez por rodada de tarefas numa missão; numa conversa, só o registro no chat.
            if (mission.kind === "conversation") {
              reportToChat(lead.id, reportLine(action.message, "nada: o Orquestrador está esperando a sua resposta nesta conversa.", "aviso"));
              continue;
            }
            const round = latestTask(mission);
            if (!userDecisionAllowed(mission.kind, userDecisionRounds.get(mission.id), round)) continue;
            userDecisionRounds.set(mission.id, round ?? 0);
            showBotToast({ title: VIGIA_NAME, text: action.message, tone: "warning", ms: 12_000 });
            notifyUser(mission.id, mission.title, "user_decision", action.message);
            reportToChat(lead.id, reportLine(action.message, "avisei você na tela: a decisão é sua.", "aviso"));
            continue;
          }
          const target = team.find((tab) => tab.title === action.to);
          if (!target || memberFinished(taskAt.get(target.id), finishedAt.get(target.id)) || !mayPoke(target.id, Date.now())) continue;
          poke(target.id, `[${VIGIA_NAME}] ${action.message}`, Date.now(), () => {
            reportToChat(lead.id, reportLine(action.message, `mandei a ${action.to}.`, "aviso"));
          });
        }
      })
      .catch((error: unknown) => {
        // Antes um erro aqui sumia e a missão parecia vigiada. Agora aparece no chat, com limite.
        const last = lastErrorReport.get(mission.id);
        if (last !== undefined && now - last < ERROR_REPORT_MS) return;
        lastErrorReport.set(mission.id, now);
        const reason = String(error).slice(0, 160);
        reportToChat(lead.id, reportLine(`o modelo do Vigia não respondeu (${reason}).`, "nada; as regras sem modelo continuam valendo e tento de novo no próximo ciclo.", "aviso"));
      })
      .finally(() => inFlight.delete(mission.id)));
  }
  return Promise.allSettled(pending).then(() => undefined);
}

/** O estado de uma missão e o que o watchdog acha dela agora, com as regras sem modelo. */
function watchState(mission: WatchedTeam, now: number): { watch: Watch; finding: WatchFinding | null } {
  const { team, lead } = mission;
  const stored = watches.get(mission.id) ?? { startedAt: missionStartMs(mission.startedAt, now), nudges: 0, limitReported: false };
  const leadSent = sentAt.get(lead.id);
  const taskTimes = team.filter((tab) => tab.id !== lead.id).map((tab) => taskAt.get(tab.id)).filter((at): at is number => at !== undefined);
  const watch = refreshWatch(stored, taskTimes.length > 0 ? Math.max(...taskTimes) : undefined);
  watches.set(mission.id, watch);
  if (watch !== stored) rememberWatches();
  const members = team
    .filter((tab) => tab.id !== lead.id)
    .map((tab) => ({
      id: tab.id,
      name: tab.title,
      hasTask: gotAt.has(tab.id),
      lastOutput: lastOutputAt(tab.id),
      taskAt: taskAt.get(tab.id),
      reportedAt: finishedAt.get(tab.id),
    }));
  const finding = watchdogFinding({
    now,
    startedAt: watch.startedAt,
    lead: { id: lead.id, name: lead.title, lastOutput: lastOutputAt(lead.id) },
    members,
    leadLastSent: leadSent,
    nudges: watch.nudges,
    lastNudge: watch.lastNudge,
  });
  return { watch, finding };
}

/** Com o Vigia desligado: só a entrega, uma vez por rodada de tarefas, com aviso do sistema. */
function deliveryOnly(mission: WatchedTeam, now: number): void {
  const { watch, finding } = watchState(mission, now);
  if (finding?.kind !== "done" || watch.doneAt !== undefined) return;
  watch.doneAt = now;
  rememberWatches();
  notifyUser(mission.id, mission.title, "team_delivered");
}

/** O Jev confirma como final uma mensagem ao Orquestrador que a regra local não reconheceu. Com o ponto desligado (padrão) ou com falha, não faz nada. */
export const JEV_FINAL_MIN_PROBABILITY = 0.5;
function askJevIfFinal(fromTabId: string, text: string | null | undefined, at: number): void {
  const body = (text ?? "").trim();
  if (body.length < 40 || body.includes("?")) return;
  invoke<{ label: string; confidence: number | null; probability: number | null } | null>("decision_classify_report", { text: body, local: "andamento" })
    .then((answer) => {
      if (!answer || answer.label !== "final" || (answer.probability !== null && answer.probability < JEV_FINAL_MIN_PROBABILITY)) return;
      if ((finishedAt.get(fromTabId) ?? 0) < at) finishedAt.set(fromTabId, at);
      rememberPeers();
    })
    .catch(() => {});
}

/** Liga o ciclo do Vigia e escuta as mensagens entre agentes (para saber quem delegou e quem tem tarefa). */
export function useVigiaDriver(): void {
  useEffect(() => {
    // O próximo ciclo só depois do anterior (e da consulta ao modelo dele); erro num ciclo não para o laço.
    const stop = repeatAfterEach(() => vigiaTick(), VIGIA_TICK_MS, (error) => console.error("[Vigia] ciclo falhou", error));
    const off = listen<{ kind?: string; fromTabId: string; toTabId: string | null; atMs: number; text?: string | null }>("cc-peer-message", (e) => {
      const at = e.payload.atMs || Date.now();
      sentAt.set(e.payload.fromTabId, at);
      const sender = useTabsStore.getState().tabs.find((tab) => tab.id === e.payload.fromTabId);
      const boards = useCanvasStore.getState().boards;
      const toLead = !!e.payload.toTabId && Object.values(boards).some((board) => board.orchestrators.includes(e.payload.toTabId as string));
      const final = isFinalReport(e.payload.text, e.payload.kind, sender?.title, toLead);
      if (final) finishedAt.set(e.payload.fromTabId, at);
      else if (toLead && e.payload.kind !== "ask") askJevIfFinal(e.payload.fromTabId, e.payload.text, at);
      if (e.payload.toTabId) {
        gotAt.set(e.payload.toTabId, at);
        // Tarefa nova só vem do Orquestrador: "confirmado, obrigado" entre integrantes não reabre a tarefa de ninguém
        // (isso fazia o Vigia cobrar "travado" de quem já tinha entregue).
        const fromLead = Object.values(boards).some((board) => board.orchestrators.includes(e.payload.fromTabId));
        if (fromLead && !final && !isClosure(e.payload.text)) taskAt.set(e.payload.toTabId, at);
      }
      rememberPeers();
    });
    return () => {
      stop();
      off.then((fn) => fn());
    };
  }, []);
}
