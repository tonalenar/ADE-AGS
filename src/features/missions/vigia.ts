import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";
import { lastOutputAt } from "@/features/terminal/activity";
import { sendWhenReady } from "@/features/terminal/terminalRegistry";
import { showBotToast } from "@/shared/brand/botToastStore";
import { missionIndex, tabsByMission } from "./groups";
import { useMissionsStore } from "./store";

/**
 * O Vigia: um modelo BARATO, em segundo plano e SEM TERMINAL, que impede agentes ociosos (sem
 * tarefa, esperando resposta que não vem, com texto colado sem enviar, ou que terminaram e não
 * reportaram).
 *
 * Quem decide QUANDO ele olha é o app, de graça: a cada `VIGIA_TICK_MS` vê quem está sem saída
 * há `VIGIA_IDLE_MS`. Só então chama `vigia_check` (backend), que lê o fim das telas, faz UMA
 * chamada headless do modelo barato e devolve as mensagens; o processo termina ali. Nada fica
 * aberto consumindo memória, e o modelo só gasta quando há suspeita.
 */
export const VIGIA_NAME = "Vigia";
/** Sem saída por isto = candidato a ocioso. */
export const VIGIA_IDLE_MS = 90_000;
/** O mesmo agente não é reportado de novo antes disto. */
export const VIGIA_COOLDOWN_MS = 4 * 60_000;
/** Cada quanto o app confere a equipe. */
export const VIGIA_TICK_MS = 30_000;

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

interface VigiaAction { to: string; message: string }

/** Quando cada aba foi reportada ao Vigia; missões com uma consulta em andamento. */
const lastPoke = new Map<string, number>();
const inFlight = new Set<string>();

/** Um passo: para cada missão em andamento, consulta o Vigia se alguém parece ocioso. */
export function vigiaTick(now = Date.now()): void {
  const { tabs, detectedAgents } = useTabsStore.getState();
  const missions = useMissionsStore.getState().missions.filter((m) => m.status === "running");
  if (missions.length === 0) return;
  const boards = useCanvasStore.getState().boards;
  const byMission = tabsByMission(missionIndex(boards, tabs), tabs);
  const available = detectedAgents.filter((a) => a.available).map((a) => a.id);
  for (const mission of missions) {
    if (inFlight.has(mission.id)) continue;
    const team = (byMission[mission.id] ?? [])
      .map((id) => tabs.find((tab) => tab.id === id))
      .filter((tab): tab is NonNullable<typeof tab> => !!tab && tab.agentId !== "bash");
    const board = Object.entries(boards).find(([key]) => key.endsWith(`#m:${mission.id}`))?.[1];
    const lead = team.find((tab) => board?.orchestrators.includes(tab.id)) ?? team[0];
    if (!lead) continue;
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
            continue;
          }
          const target = team.find((tab) => tab.title === action.to);
          if (target) sendWhenReady(target.id, `[${VIGIA_NAME}] ${action.message}`);
        }
      })
      .catch(() => undefined)
      .finally(() => inFlight.delete(mission.id));
  }
}

/** Liga o ciclo do Vigia enquanto a janela está aberta. Montado junto do vigia de missões. */
export function useVigiaDriver(): void {
  useEffect(() => {
    const timer = window.setInterval(() => vigiaTick(), VIGIA_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
}
