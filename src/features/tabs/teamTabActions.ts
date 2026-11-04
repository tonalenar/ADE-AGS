import { defaultPolicy } from "@/features/chat/team/teamModel";
import { leadTeam, unleadTeam } from "@/features/chat/team/teamLead";
import { linkExisting, makeOrchestrator, unlinkMember, useTeamStore, type ConversationRef } from "@/features/chat/team/teamStore";
import { useTabsStore } from "@/features/tabs/store";
import type { UnifiedConversation } from "@/features/chat/unified/types";
import type { TeamMenuAction } from "@/features/tabs/teamTabs";
import { AlertaToast } from "@/shared/ui/alerts";
import i18n from "@/i18n";

const refOf = (c: UnifiedConversation): ConversationRef => ({
  key: c.ref, agentId: c.agentId, agentLabel: useTabsStore.getState().tabs.find((t) => t.id === c.ref)?.agentLabel ?? c.agentId, title: c.title, cwd: c.cwd,
});

/**
 * Executa uma ação de time numa aba, pelas mesmas funções do chat (`chat/team/*`, comandos `chat_team_*`):
 * nenhuma regra nova aqui. O erro do backend (um agente só em um time, por exemplo) vira aviso.
 */
export async function runTeamAction(action: TeamMenuAction, conv: UnifiedConversation, activeTeamId: string | null): Promise<void> {
  try {
    const teams = useTeamStore.getState().teams;
    switch (action) {
      case "create": await makeOrchestrator(refOf(conv)); break;
      case "link": if (activeTeamId) await linkExisting(activeTeamId, refOf(conv), "generalist", defaultPolicy("generalist")); break;
      case "unlink": if (conv.teamId) await unlinkMember(conv.teamId, conv.ref); break;
      case "lead": if (conv.teamId) await leadTeam(conv.teamId, refOf(conv)); break;
      case "unlead": {
        const team = teams.find((t) => t.id === conv.teamId);
        if (team) await unleadTeam(team);
        break;
      }
    }
  } catch (e) {
    void AlertaToast(i18n.t("tabs.team.title"), String(e), "error");
  }
}
