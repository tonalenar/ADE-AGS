import { canvasActions, useCanvasStore } from "@/features/canvas/store";

import { chatTeamLead, chatTeamUnlead, type TeamView } from "./ipc";
import { reloadTeams, syncTeamCanvas, type ConversationRef } from "./teamStore";

/**
 * Tirar o papel de orquestrador (decisão P3 do desenho): o time e os integrantes ficam. No banco é
 * `chat_team_unlead`; no canvas a coroa sai dos canvases onde ela está. Idempotente.
 */
export async function unleadTeam(team: TeamView): Promise<void> {
  const lead = team.orchestrator;
  await chatTeamUnlead(team.id);
  await reloadTeams();
  if (!lead) return;
  for (const [key, board] of Object.entries(useCanvasStore.getState().boards)) {
    if (board.orchestrators.includes(lead)) canvasActions.toggleOrchestrator(key, lead);
  }
}

/** Dar (ou trocar) o orquestrador de um time: a conversa vira a coroa, e o canvas é posto em dia. */
export async function leadTeam(teamId: string, conv: ConversationRef): Promise<void> {
  await chatTeamLead({ teamId, orchestrator: conv.key, agentId: conv.agentId, label: conv.agentLabel });
  const team = (await reloadTeams()).find((t) => t.id === teamId);
  if (team) await syncTeamCanvas(team);
}
