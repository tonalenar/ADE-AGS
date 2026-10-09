import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";
import { lastOutputAt } from "@/features/terminal/activity";
import { sendWhenReady } from "@/features/terminal/terminalRegistry";
import { showBotToast } from "@/shared/brand/botToastStore";
import { missionIndex, tabsByMission } from "./groups";
import { useMissionsStore } from "./store";

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
  | { kind: "limit"; stuck: string };

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/**
 * O que está travado agora, sem modelo: o Orquestrador parado sem delegar, ou a equipe inteira
 * quieta sem ninguém falar. `null` = nada travado (ou ainda no cooldown do último lembrete). Pura.
 */
export function watchdogFinding(input: WatchInput): WatchFinding | null {
  const { now, startedAt, lead, members, leadLastSent, nudges, lastNudge } = input;
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
export function reportLine(stuck: string, done: string): string {
  return `**Vigia** — travado: ${stuck} Feito: ${done}`;
}

interface VigiaAction { to: string; message: string }

/** Estado do Vigia por missão: quando começou e quantos lembretes foram sem resposta. */
interface Watch { startedAt: number; nudges: number; lastNudge?: number; limitReported: boolean }

/** Quando cada aba mandou (`sentAt`) e recebeu (`gotAt`) a última mensagem entre agentes. */
const sentAt = new Map<string, number>();
const gotAt = new Map<string, number>();
const watches = new Map<string, Watch>();
/** Quando cada aba foi reportada ao modelo; missões com uma consulta em andamento. */
const lastPoke = new Map<string, number>();
const inFlight = new Set<string>();
const lastErrorReport = new Map<string, number>();

/** Escreve no chat do Orquestrador (é ali que o usuário lê). Falha silenciosa: é só registro. */
function reportToChat(tabId: string, text: string): void {
  invoke("vigia_report", { tabId, text }).catch(() => undefined);
}

/** Um passo: as regras sem modelo primeiro; se não acharem nada, o modelo barato para os ociosos. */
export function vigiaTick(now = Date.now()): void {
  const { tabs, detectedAgents } = useTabsStore.getState();
  const missions = useMissionsStore.getState().missions.filter((m) => m.status === "running");
  if (missions.length === 0) return;
  const boards = useCanvasStore.getState().boards;
  const byMission = tabsByMission(missionIndex(boards, tabs), tabs);
  const available = detectedAgents.filter((a) => a.available).map((a) => a.id);
  for (const mission of missions) {
    const team = (byMission[mission.id] ?? [])
      .map((id) => tabs.find((tab) => tab.id === id))
      .filter((tab): tab is NonNullable<typeof tab> => !!tab && tab.agentId !== "bash");
    const board = Object.entries(boards).find(([key]) => key.endsWith(`#m:${mission.id}`))?.[1];
    const lead = team.find((tab) => board?.orchestrators.includes(tab.id)) ?? team[0];
    if (!lead) continue;

    const watch = watches.get(mission.id) ?? { startedAt: mission.startedAt ?? now, nudges: 0, limitReported: false };
    watches.set(mission.id, watch);
    const leadSent = sentAt.get(lead.id);
    // O Orquestrador voltou a falar depois do último lembrete: a conta recomeça.
    if (leadSent !== undefined && watch.lastNudge !== undefined && leadSent > watch.lastNudge) {
      watch.nudges = 0;
      watch.lastNudge = undefined;
      watch.limitReported = false;
    }
    const members = team
      .filter((tab) => tab.id !== lead.id)
      .map((tab) => ({
        id: tab.id,
        name: tab.title,
        hasTask: gotAt.has(tab.id),
        lastOutput: lastOutputAt(tab.id),
        taskAt: gotAt.get(tab.id),
        reportedAt: sentAt.get(tab.id),
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
    if (finding?.kind === "limit") {
      if (!watch.limitReported) {
        watch.limitReported = true;
        reportToChat(lead.id, reportLine(finding.stuck, `já lembrei ${NUDGE_LIMIT} vezes e não houve resposta. Parei de insistir: reenvie a tarefa ao integrante parado ou finalize a missão.`));
      }
      continue;
    }
    if (finding) {
      watch.nudges += 1;
      watch.lastNudge = now;
      sendWhenReady(lead.id, `[${VIGIA_NAME}] ${finding.nudge}`);
      reportToChat(lead.id, reportLine(finding.stuck, `lembrete ${watch.nudges}/${NUDGE_LIMIT} enviado ao ${lead.title}.`));
      continue;
    }

    if (inFlight.has(mission.id)) continue;
    const idle = idleCandidates(team, now, lastOutputAt, lastPoke);
    if (idle.length === 0) continue;
    const pick = vigiaAgentFor(lead.agentId, available);
    if (!pick) continue;
    for (const tab of idle) lastPoke.set(tab.id, now);
    inFlight.add(mission.id);
    invoke<VigiaAction[]>("vigia_check", {
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
          if (action.to === "usuario") {
            showBotToast({ title: VIGIA_NAME, text: action.message, tone: "warning", ms: 12_000 });
            reportToChat(lead.id, reportLine(action.message, "avisei você na tela: a decisão é sua."));
            continue;
          }
          const target = team.find((tab) => tab.title === action.to);
          if (!target) continue;
          sendWhenReady(target.id, `[${VIGIA_NAME}] ${action.message}`);
          reportToChat(lead.id, reportLine(action.message, `mandei a ${action.to}.`));
        }
      })
      .catch((error: unknown) => {
        // Antes um erro aqui sumia e a missão parecia vigiada. Agora aparece no chat, com limite.
        const last = lastErrorReport.get(mission.id);
        if (last !== undefined && now - last < ERROR_REPORT_MS) return;
        lastErrorReport.set(mission.id, now);
        const reason = String(error).slice(0, 160);
        reportToChat(lead.id, reportLine(`o modelo do Vigia não respondeu (${reason}).`, "nada; as regras sem modelo continuam valendo e tento de novo no próximo ciclo."));
      })
      .finally(() => inFlight.delete(mission.id));
  }
}

/** Liga o ciclo do Vigia e escuta as mensagens entre agentes (para saber quem delegou e quem tem tarefa). */
export function useVigiaDriver(): void {
  useEffect(() => {
    const timer = window.setInterval(() => vigiaTick(), VIGIA_TICK_MS);
    const off = listen<{ fromTabId: string; toTabId: string | null; atMs: number }>("cc-peer-message", (e) => {
      const at = e.payload.atMs || Date.now();
      sentAt.set(e.payload.fromTabId, at);
      if (e.payload.toTabId) gotAt.set(e.payload.toTabId, at);
    });
    return () => {
      window.clearInterval(timer);
      off.then((fn) => fn());
    };
  }, []);
}
