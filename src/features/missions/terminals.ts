import { invoke } from "@tauri-apps/api/core";

import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import { canvasActions, missionBoardKey, setWorkMode } from "@/features/canvas/store";
import type { FunctionalRole, Squad } from "@/features/squads/types";
import { useTabsStore } from "@/features/tabs/store";
import { sendWhenReady, type SendTimings } from "@/features/terminal/terminalRegistry";

import { getAutonomy, withAutonomy } from "./autonomy";
import { withModel } from "./modelFlags";
import { recordSpan } from "./timings";

import type { Mission } from "./types";

/** Un integrante del equipo tal como se abre: su pestaña, su papel y qué hace. */
export interface TeamMember {
  /** Cómo se llama su pestaña (y cómo lo nombran los demás). Único en el equipo. */
  name: string;
  agentId: string;
  /** Modelo y esfuerzo que el Squad eligió para este integrante; `null` = el de la TUI. */
  model?: string | null;
  effort?: string | null;
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
      model: m.model,
      effort: m.reasoningEffort ?? null,
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

/** Quantos terminais além da equipe o Orquestrador pode abrir sozinho (cada um gasta memória e tokens). */
export const MAX_EXTRA_TERMINALS = 3;

/** Lo primero que lee el orquestador: la misión, su equipo y cómo coordinarlo. Pura. */
export function leadBriefing(mission: Pick<Mission, "title" | "objective"> & { id?: string }, team: TeamMember[], findings = "", memory = ""): string {
  const people = team.length === 0
    ? "Você ainda não tem equipe: sume agentes com `ags peer recruit <nome> --agent <id> --role <papel>`."
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
    ...(findings.trim() ? [findings.trim(), ""] : []),
    ...(memory.trim() ? [memory.trim(), ""] : []),
    "COMO COORDENAR (use SOMENTE o `ags`; não use `maestri` nem skills de outros apps)",
    "- `ags peers` — quem está conectado com você.",
    '- `ags peer ask "<nome>" "<pedido>"` — pergunta e ESPERA a resposta.',
    "- `ags peer ask --batch '{\"A\":\"...\",\"B\":\"...\"}'` — vários ao mesmo tempo.",
    '- `ags peer tell "<nome>" "<mensagem>"` — avisa sem esperar.',
    '- `ags peer check "<nome>"` — vê a tela dele agora.',
    '- `ags notify "<mensagem>"` — chama o usuário só quando precisar dele.',
    "",
    "MENOS CONVERSA, MAIS REGISTRO:",
    "- Antes de perguntar de novo, releia o objetivo, os achados e a memória aprovada já recebidos. Pergunte apenas a lacuna concreta que bloqueia uma decisão ou o avanço.",
    "- Em tarefas do Mission Runtime, use o Handoff Structured v1 como entrega registrada; consulte `task_result` apenas quando precisar do payload completo. Não peça novamente resumo, arquivos, testes ou decisões que já constem no handoff.",
    "- Neste canvas de terminais, combine uma única entrega final curta por integrante: resultado, decisões, arquivos tocados, testes e bloqueios. Atualizações intermediárias servem para bloqueios ou mudanças de decisão.",
    "",
    "MAIS TERMINAIS (você tem autonomia):",
    '- `ags peer recruit "<nome>" --agent <id> --role <papel> [--model <id>] [--effort <nível>]` — abre outro terminal já conectado a você quando a equipe não der conta (ex.: uma tarefa paralela, uma revisão independente).',
    `- Máximo de ${MAX_EXTRA_TERMINALS} terminais extras por missão; cada um custa memória e tokens. Só abra quando houver trabalho real para ele, dê a ele um nome e papel claros e feche (ou deixe encerrar) quando acabar.`,
    "- Use um agente que já esteja disponível (`ags peers` mostra a equipe) e não repita um papel que já está livre.",
    "",
    "Planeje, divida o trabalho conforme o papel de cada um, acompanhe e junte os resultados. Ao terminar, resuma o que foi feito.",
    ...(mission.id ? ["", ...memorySuggestion(mission.id)] : []),
  ].join("\n");
}

/** O que se pede ao orquestrador ao terminar: deixar até 3 memórias para a próxima missão. Pura. */
export function memorySuggestion(missionId: string): string[] {
  return [
    "AO TERMINAR, sugira até 3 memórias duradouras úteis para missões futuras:",
    `- \`ags memory suggest --mission ${missionId} --scope mission --kind decision --key <nome-curto> --body "..."\``,
    "- Tipos: decision, constraint, finding, file, note. Escopo: workspace (vale para o projeto) ou mission.",
    "- Use mission para conhecimento duradouro desta missão; use workspace só para algo que vale no projeto todo.",
    "- Resultado, arquivos e testes da task ficam no Handoff Structured (Mission Runtime) ou na entrega final do canvas. Memória guarda apenas o que será útil depois e não é óbvio no código.",
    "- Você só SUGERE: a proposta fica pendente e só entra na busca após aprovação. Nunca sugira segredos, chaves, tokens ou dados pessoais.",
  ];
}

/** Lo primero que lee cada integrante: de qué misión es, quién lo dirige y qué papel cumple. Pura. */
export function memberBriefing(mission: Pick<Mission, "title" | "objective"> & { id?: string }, member: TeamMember): string {
  return [
    `Você faz parte da equipe da missão "${mission.title}", dirigida pelo orquestrador "${LEAD_NAME}".`,
    "",
    "OBJETIVO DA MISSÃO",
    mission.objective,
    "",
    `SEU PAPEL: ${member.roleLabel}${member.roleDescription ? ` — ${member.roleDescription}` : ""}`,
    member.roleInstructions,
    "",
    ...(mission.id ? [
      `Memória aprovada do projeto e da missão: \`ags memory search "<assunto>" --mission ${mission.id}\` (só lê). Consulte-a antes de perguntar algo que talvez já esteja registrado.`,
      "",
    ] : []),
    `Ao concluir, envie UMA mensagem final curta ao orquestrador por \`ags peer tell "${LEAD_NAME}"\`, com resultado, decisões, arquivos tocados, testes e bloqueios. Use caminhos relativos e \`nenhum\` quando um campo estiver vazio.`,
    "Atualizações intermediárias só são necessárias para sinalizar um bloqueio ou uma mudança de decisão; não repita dados do briefing ou de entregas já registradas.",
    "Aguarde as instruções do orquestrador e responda ao que ele perguntar.",
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");
}

/**
 * El briefing tal como se manda a cada TUI. Claude Code recibe el texto con sus saltos de
 * línea; Codex y otras TUIs descartan los Enter de un pegado y lo dejan todo pegado
 * ("MISSÃOOBJETIVO…"), así que a esas se les manda en una sola línea con los apartados
 * separados por " | ". Pura.
 */
export function briefingFor(agentId: string, text: string): string {
  if (agentId === "claude-code") return text;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^- /, ""))
    .join(" | ");
}

/** Los nombres de las cuentas pedidas que todavía no tienen sesión iniciada. `null` = la del sistema. Pura. */
export function accountsNeedingLogin(
  ids: Array<string | null | undefined>,
  accounts: Pick<AgentAccount, "id" | "name" | "loggedIn" | "kind">[],
): string[] {
  const names = new Set<string>();
  for (const id of ids) {
    const account = id ? accounts.find((a) => a.id === id) : undefined;
    if (account && account.kind === "login" && !account.loggedIn) names.add(account.name);
  }
  return [...names];
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
export async function startMissionInTerminals(
  mission: Mission,
  squad: Squad | null,
  roles: FunctionalRole[],
  options?: { force?: boolean }
): Promise<StartedTeam> {
  const { addTab, detectedAgents, activateTab } = useTabsStore.getState();
  const team = teamOf(squad, roles);
  const leadAgentId = squad?.lead.agentId ?? mission.leadAgentId ?? "claude-code";

  // Todo se valida ANTES de marcar la misión o abrir nada: una TUI que no está instalada no
  // puede dejar la misión a medias.
  const agentFor = (id: string, model?: string | null, effort?: string | null) => {
    const found = detectedAgents.find((a) => a.id === id);
    if (!found || !found.available) throw new Error(`O agente '${id}' não está disponível nesta máquina.`);
    // O nível de permissões e o modelo/esforço do Squad vão no comando (e portanto também ao
    // retomar a sessão). Sem isso o terminal abria com o modelo padrão da TUI.
    const command = withModel(found.id, withAutonomy(found.id, found.command, getAutonomy()), model, effort);
    return { ...found, command };
  };
  const leadAgent = agentFor(leadAgentId, squad?.lead.model ?? mission.leadModel, squad?.lead.reasoningEffort);
  const memberAgents = team.map((m) => agentFor(m.agentId, m.model, m.effort));

  // Una cuenta sin login abriría el selector de login de la TUI, y el briefing se pegaría ahí.
  // Cada cuenta tiene su perfil aislado: el login se hace una vez, a mano, en Cuentas.
  const leadAccountId = squad && !squad.lead.autoAccount ? squad.lead.accountId ?? null : mission.autoAccount ? null : mission.leadAccountId ?? null;
  const missing = accountsNeedingLogin([leadAccountId, ...team.map((m) => m.accountId)], useAccountsStore.getState().accounts);
  if (missing.length > 0) {
    throw new Error(`Falta fazer login na conta: ${missing.join(", ")}. Entre nela uma vez em Contas (cada conta tem perfil isolado) e inicie a missão de novo.`);
  }

  // O que o repositório e as missões anteriores já dizem do objetivo: se o pedido já existe, o
  // Orquestrador sabe ANTES de convocar a equipe. Só leitura; se falhar, a missão segue sem isso.
  const findings = await invoke<string>("mission_precheck", { missionId: mission.id }).catch(() => "");
  // La memoria aprobada del proyecto y de la misión (solo lectura; vacío si no hay ninguna).
  const memory = await invoke<string>("mission_memory_context", { missionId: mission.id }).catch(() => "");

  await invoke("mission_start_terminals", { missionId: mission.id, force: Boolean(options?.force) });

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

  // Cronómetro: cuánto tardó cada terminal en estar lista, y cuánto en contestar el briefing.
  const openedAt = Date.now();
  const timed = (actor: string): SendTimings => {
    let sentAt = 0;
    return {
      onSent: (at) => {
        sentAt = at;
        recordSpan(mission.id, { kind: "boot", actor, startedMs: openedAt, endedMs: at });
      },
      onTurnEnd: (at) => sentAt > 0 && recordSpan(mission.id, { kind: "turn", actor, startedMs: sentAt, endedMs: at, detail: "briefing" }),
    };
  };
  sendWhenReady(leadTabId, briefingFor(leadAgentId, leadBriefing(mission, team, findings, memory)), timed(LEAD_NAME));
  memberTabIds.forEach((tabId, i) =>
    sendWhenReady(tabId, briefingFor(team[i].agentId, memberBriefing(mission, team[i])), timed(team[i].name)),
  );

  return { leadTabId, memberTabIds };
}
