import { useEffect } from "react";

import { useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";
import { lastOutputAt } from "@/features/terminal/activity";
import { sendWhenReady } from "@/features/terminal/terminalRegistry";
import { missionIndex, tabsByMission } from "./groups";
import { useMissionsStore } from "./store";

/**
 * O Vigia: um agente BARATO, ligado ao Orquestrador, que não implementa nada. Ele existe para
 * que ninguém da equipe fique ocioso (sem tarefa, esperando resposta que não vem, com texto
 * colado sem enviar, ou que terminou e não reportou).
 *
 * Quem decide QUANDO ele olha é o app, de graça: a cada `VIGIA_TICK_MS` o app vê quem está sem
 * saída há `VIGIA_IDLE_MS`. Só então acorda o Vigia com esses nomes; ele lê as telas e cutuca
 * o Orquestrador (ou o próprio agente). Assim o modelo barato só gasta quando há suspeita, e
 * não fica rodando em loop.
 */
export const VIGIA_NAME = "Vigia";
/** Sem saída por isto = candidato a ocioso. */
export const VIGIA_IDLE_MS = 90_000;
/** O mesmo agente não é reportado de novo antes disto. */
export const VIGIA_COOLDOWN_MS = 4 * 60_000;
/** Cada quanto o app confere a equipe. */
export const VIGIA_TICK_MS = 30_000;
/** O Vigia ainda escrevendo há menos que isto: está no meio de um ciclo, não se manda outro. */
const VIGIA_BUSY_MS = 8_000;

export interface VigiaAgent { agentId: string; model: string; effort: string }

/**
 * Qual agente e modelo baratos usar, conforme o provedor do Orquestrador: Claude Code → Haiku
 * (esforço médio); Codex → GPT-6 Luna (esforço max). Outro provedor: o primeiro dos dois que
 * estiver instalado. `null` se nenhum estiver. Pura.
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
 * O próprio Vigia fica de fora. `lastPoke` guarda quando cada aba foi reportada. Pura.
 */
export function idleCandidates(
  tabs: readonly { id: string; title: string }[],
  vigiaId: string,
  now: number,
  lastOutput: (tabId: string) => number | undefined,
  lastPoke: ReadonlyMap<string, number>,
): { id: string; title: string }[] {
  return tabs.filter((tab) => {
    if (tab.id === vigiaId) return false;
    const out = lastOutput(tab.id);
    if (out !== undefined && now - out < VIGIA_IDLE_MS) return false;
    const poked = lastPoke.get(tab.id);
    return poked === undefined || now - poked >= VIGIA_COOLDOWN_MS;
  });
}

/** O que o Vigia lê na primeira vez. Pura. */
export function vigiaBriefing(missionTitle: string, leadName: string, teamNames: readonly string[]): string {
  return [
    `Você é o VIGIA da missão "${missionTitle}". Você NÃO implementa, não edita arquivos, não roda testes e não faz commits.`,
    `Sua única função: garantir que ninguém da equipe fique ocioso. Equipe: ${leadName}${teamNames.length ? `, ${teamNames.join(", ")}` : ""}.`,
    "",
    "O app vai te mandar mensagens `[AGS] CICLO DO VIGIA` com os nomes de quem está sem saída há um tempo. A cada uma:",
    "1. Leia a tela de cada nome citado: `ags peer check \"<nome>\"` (só leitura).",
    "2. Classifique: trabalhando de verdade (pensando, build/teste longo) → não faça nada; esperando tarefa; terminou e não reportou; esperando resposta de alguém; texto colado sem enviar; travado em erro; esperando aprovação do usuário.",
    `3. Aja só quando alguém está ocioso de fato: avise o Orquestrador com UMA mensagem curta — \`ags peer tell "${leadName}" "[Vigia] <nome>: <situação>. Sugestão: <próximo passo>"\`. Se o próprio Orquestrador está ocioso com a equipe esperando, diga isso a ele.`,
    "4. Texto colado sem enviar ou integrante que terminou e não reportou: cutuque o próprio integrante com `ags peer tell \"<nome>\" \"[Vigia] ...\"`.",
    "5. Esperando aprovação/pergunta do usuário: use `ags notify \"<nome> espera você: <o quê>\"`.",
    "Regras: seja breve; não repita um aviso que já deu; não invente tarefas; nunca interrompa quem está trabalhando. Termine o turno logo depois de agir.",
    "Agora só confirme que entendeu em uma linha e aguarde o primeiro ciclo.",
  ].join("\n");
}

/** A mensagem de um ciclo. Pura. */
export function vigiaCycle(names: readonly string[]): string {
  return `[AGS] CICLO DO VIGIA — sem saída há mais de ${Math.round(VIGIA_IDLE_MS / 1000)} s: ${names.join(", ")}. Confira as telas e aja só se estiverem ociosos de fato.`;
}

/** Quando cada aba foi reportada ao Vigia pela última vez. Vive enquanto a janela vive. */
const lastPoke = new Map<string, number>();

/** Um passo do ciclo: para cada missão em andamento com Vigia, acorda-o se alguém parece ocioso. */
export function vigiaTick(now = Date.now()): void {
  const tabs = useTabsStore.getState().tabs;
  const running = new Set(useMissionsStore.getState().missions.filter((m) => m.status === "running").map((m) => m.id));
  if (running.size === 0) return;
  const byMission = tabsByMission(missionIndex(useCanvasStore.getState().boards, tabs), tabs);
  for (const [missionId, ids] of Object.entries(byMission)) {
    if (!running.has(missionId)) continue;
    const team = ids.map((id) => tabs.find((tab) => tab.id === id)).filter((tab) => !!tab && tab.agentId !== "bash") as { id: string; title: string }[];
    const vigia = team.find((tab) => tab.title === VIGIA_NAME);
    if (!vigia) continue;
    const vigiaOut = lastOutputAt(vigia.id);
    if (vigiaOut !== undefined && now - vigiaOut < VIGIA_BUSY_MS) continue;
    const idle = idleCandidates(team, vigia.id, now, lastOutputAt, lastPoke);
    if (idle.length === 0) continue;
    for (const tab of idle) lastPoke.set(tab.id, now);
    sendWhenReady(vigia.id, vigiaCycle(idle.map((tab) => tab.title)));
  }
}

/** Liga o ciclo do Vigia enquanto a janela está aberta. Montado junto do vigia de missões. */
export function useVigiaDriver(): void {
  useEffect(() => {
    const timer = window.setInterval(() => vigiaTick(), VIGIA_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
}
