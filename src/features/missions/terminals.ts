import { invoke } from "@tauri-apps/api/core";

import { canvasActions, missionBoardKey, setWorkMode } from "@/features/canvas/store";
import type { FunctionalRole, Squad } from "@/features/squads/types";
import { useTabsStore } from "@/features/tabs/store";
import { sendWhenReady } from "@/features/terminal/terminalRegistry";

import type { Mission } from "./types";

/** Un integrante del equipo tal como se abre: su pestaña, su papel y qué hace. */
export interface TeamMember {
  /** Cómo se llama su pestaña (y cómo lo nombran los demás). Único en el equipo. */
  name: string;
  agentId: string;
  accountId: string | null;
  roleId: string;
  roleLabel: string;
  roleDescription: string;
  roleInstructions: string;
}

/** Nombres únicos: dos integrantes con el mismo papel quedan "Backend" y "Backend 2". */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const count = (seen.get(n.toLowerCase()) ?? 0) + 1;
    seen.set(n.toLowerCase(), count);
    return count === 1 ? n : `${n} ${count}`;
  });
}

/** El equipo de un Squad: un integrante por miembro, con su papel resuelto. Los papeles que ya no existen se muestran por su id. */
export function teamOf(squad: Squad | null, roles: FunctionalRole[]): TeamMember[] {
  if (!squad) return [];
  const labels = squad.members.map((m) => roles.find((r) => r.id === m.roleId)?.label ?? m.roleId);
  const names = uniqueNames(labels);
  return squad.members.map((m, i) => {
    const role = roles.find((r) => r.id === m.roleId);
    return {
      name: names[i],
      agentId: m.agentId,
      // Con "automática" no se fija cuenta: la que la TUI use por defecto.
      accountId: m.autoAccount ? null : m.accountId,
      roleId: m.roleId,
      roleLabel: role?.label ?? m.roleId,
      roleDescription: role?.description ?? "",
      roleInstructions: role?.instructions ?? "",
    };
  });
}

export const LEAD_NAME = "Orquestrador";

/** Lo primero que lee el orquestador: la misión, su equipo y cómo coordinarlo. Pura. */
export function leadBriefing(mission: Pick<Mission, "title" | "objective">, team: TeamMember[]): string {
  const people = team.length === 0
    ? "Você ainda não tem equipe: sume agentes com `ccode peer recruit <nome> --agent <id> --role <papel>`."
    : `SUA EQUIPE (já aberta e conectada a você no canvas):\n${team
        .map((m) => `- ${m.name} — ${m.roleLabel}${m.roleDescription ? `: ${m.roleDescription}` : ""}`)
        .join("\n")}`;
  return [
    `Você é o ORQUESTRADOR da missão "${mission.title}".`,
    "",
    "OBJETIVO",
    mission.objective,
    "",
    people,
    "",
    "COMO COORDENAR",
    "- `ccode peers` — quem está conectado com você.",
    '- `ccode peer ask "<nome>" "<pedido>"` — pergunta e ESPERA a resposta.',
    "- `ccode peer ask --batch '{\"A\":\"...\",\"B\":\"...\"}'` — vários ao mesmo tempo.",
    '- `ccode peer tell "<nome>" "<mensagem>"` — avisa sem esperar.',
    '- `ccode peer check "<nome>"` — vê a tela dele agora.',
    '- `ccode notify "<mensagem>"` — chama o usuário só quando precisar dele.',
    "",
    "Planeje, divida o trabalho conforme o papel de cada um, acompanhe e junte os resultados. Ao terminar, resuma o que foi feito.",
  ].join("\n");
}

/** Lo primero que lee cada integrante: de qué misión es, quién lo dirige y qué papel cumple. Pura. */
export function memberBriefing(mission: Pick<Mission, "title" | "objective">, member: TeamMember): string {
  return [
    `Você faz parte da equipe da missão "${mission.title}", dirigida pelo orquestrador "${LEAD_NAME}".`,
    "",
    "OBJETIVO DA MISSÃO",
    mission.objective,
    "",
    `SEU PAPEL: ${member.roleLabel}${member.roleDescription ? ` — ${member.roleDescription}` : ""}`,
    member.roleInstructions,
    "",
    `Aguarde as instruções do orquestrador. Responda ao que ele perguntar; para avisar algo por conta própria: \`ccode peer tell "${LEAD_NAME}" "<mensagem>"\`.`,
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");
}

export interface StartedTeam {
  leadTabId: string;
  memberTabIds: string[];
}

/**
 * Arranca una misión en terminales: la marca como en curso, abre al orquestador (con corona)
 * y una terminal por integrante del equipo —todas en el canvas de la misión, conectadas al
 * orquestador y rotuladas con su papel— y les manda a cada uno su primer mensaje cuando su
 * TUI termina de arrancar.
 */
export async function startMissionInTerminals(mission: Mission, squad: Squad | null, roles: FunctionalRole[]): Promise<StartedTeam> {
  const { addTab, detectedAgents, activateTab } = useTabsStore.getState();
  const team = teamOf(squad, roles);
  const leadAgentId = squad?.lead.agentId ?? mission.leadAgentId ?? "claude-code";

  // Todo se valida ANTES de marcar la misión o abrir nada: una TUI que no está instalada no
  // puede dejar la misión a medias.
  const agentFor = (id: string) => {
    const found = detectedAgents.find((a) => a.id === id);
    if (!found || !found.available) throw new Error(`O agente '${id}' não está disponível nesta máquina.`);
    return found;
  };
  const leadAgent = agentFor(leadAgentId);
  const memberAgents = team.map((m) => agentFor(m.agentId));

  await invoke("mission_start_terminals", { missionId: mission.id });

  const leadTabId = addTab({
    cwd: mission.cwd,
    agent: leadAgent,
    title: LEAD_NAME,
    titleIsCustom: true,
    accountId: squad && !squad.lead.autoAccount ? squad.lead.accountId ?? undefined : mission.autoAccount ? undefined : mission.leadAccountId ?? undefined,
  });
  const memberTabIds = team.map((m, i) =>
    addTab({ cwd: mission.cwd, agent: memberAgents[i], title: m.name, titleIsCustom: true, accountId: m.accountId ?? undefined }),
  );

  const key = missionBoardKey(mission.cwd, mission.id);
  canvasActions.buildMissionTeam(
    key,
    leadTabId,
    memberTabIds.map((tabId, i) => ({ tabId, roleId: team[i].roleLabel })),
  );
  setWorkMode(key, "canvas");
  activateTab(leadTabId);

  sendWhenReady(leadTabId, leadBriefing(mission, team));
  memberTabIds.forEach((tabId, i) => sendWhenReady(tabId, memberBriefing(mission, team[i])));

  return { leadTabId, memberTabIds };
}
