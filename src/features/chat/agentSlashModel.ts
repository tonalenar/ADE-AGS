/**
 * Entradas do `/` que vêm do agente (comandos e skills), sem React: junta o que o agente anunciou com o
 * que a varredura do disco achou, tira duplicatas e filtra pelo nome e pela descrição.
 * Fontes: o `initialize` do Claude (`conversa/claude.rs`) e `skills/agent_scan.rs` (só metadados).
 */
import type { AgentSkillScan } from "@/features/skills/types";

import type { ProviderSlashCommand } from "./chatModel";

export interface AgentSlashEntry {
  /** Nome como o agente o conhece, sem a barra: `design:design-critique`. */
  name: string;
  description: string;
  displayName?: string;
  userInvocationOnly?: boolean;
  inputHint: string | null;
  /** Prefixo de plugin (`design`), quando o nome tem `prefixo:`. */
  plugin: string | null;
  /** Escopo da skill, quando a varredura achou o arquivo. Comando nativo do agente não tem escopo. */
  scope: AgentSkillScan["scope"] | null;
  kind: "skill" | "command";
}

/** Agentes cuja lista de skills a varredura do disco cobre (ver `agent_skills_scan`). */
export const AGENTS_WITH_SKILL_SCAN: ReadonlySet<string> = new Set(["claude-code", "codex", "cursor", "antigravity"]);

/** Id da conversa por protocolo a partir da chave do composer (`thread:<id>`); abas e outras chaves dão `null`. */
export function threadIdOfConversation(key: string | null): string | null {
  return key?.startsWith("thread:") ? key.slice("thread:".length) || null : null;
}

/** Chave de comparação de nomes: sem diferenciar caixa nem espaços das bordas. */
export function agentNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function pluginOf(name: string): string | null {
  const at = name.indexOf(":");
  return at > 0 ? name.slice(0, at) : null;
}

/**
 * A lista do `/` para o agente atual. Com o agente já informado, a lista é a dele: a varredura só
 * acrescenta escopo e prefixo às skills que ele anuncia, e o que ele não anuncia fica de fora.
 * Sem o agente ter informado, a varredura do disco é o que há. Nome reservado (comando nativo do
 * ADE ou skill já anexada) não se repete. Skills vêm antes dos comandos, em ordem alfabética.
 */
export function buildAgentSlashEntries(input: {
  reported: ReadonlyArray<ProviderSlashCommand>;
  scanned: ReadonlyArray<AgentSkillScan>;
  reservedNames: ReadonlySet<string>;
}): AgentSlashEntry[] {
  const scannedByKey = new Map<string, AgentSkillScan>();
  for (const skill of input.scanned) {
    const key = agentNameKey(skill.name);
    if (!scannedByKey.has(key)) scannedByKey.set(key, skill);
  }

  const seen = new Set<string>();
  const entries: AgentSlashEntry[] = [];
  if (input.reported.length > 0) {
    for (const command of input.reported) {
      const key = agentNameKey(command.name);
      if (!key || input.reservedNames.has(key) || seen.has(key)) continue;
      seen.add(key);
      const name = command.name.trim();
      // Skill: a varredura a achou no disco, ou o próprio agente a anunciou como skill (o `skills/list` do Codex).
      const skill = scannedByKey.get(key);
      const isSkill = skill !== undefined || command.kind === "skill";
      entries.push({
        name,
        description: command.description || skill?.description || "",
        ...(skill?.displayName ? { displayName: skill.displayName } : {}),
        ...(skill?.userInvocationOnly ? { userInvocationOnly: true } : {}),
        inputHint: command.inputHint,
        plugin: skill?.plugin ?? pluginOf(name),
        scope: skill?.scope ?? null,
        kind: isSkill ? "skill" : "command",
      });
    }
  } else {
    for (const skill of input.scanned) {
      const key = agentNameKey(skill.name);
      if (!key || input.reservedNames.has(key) || seen.has(key)) continue;
      seen.add(key);
      entries.push({
        name: skill.name,
        description: skill.description ?? "",
        ...(skill.displayName ? { displayName: skill.displayName } : {}),
        ...(skill.userInvocationOnly ? { userInvocationOnly: true } : {}),
        inputHint: null,
        plugin: skill.plugin ?? pluginOf(skill.name),
        scope: skill.scope,
        kind: "skill",
      });
    }
  }

  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "skill" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function foldText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Posição de uma entrada pelo texto digitado (menor vem primeiro); `null` quando não casa. */
function rankOf(entry: AgentSlashEntry, query: string): number | null {
  const name = foldText(entry.name);
  if (name.startsWith(query)) return 0;
  if (name.split(/[:\-_]/).some((part) => part.startsWith(query))) return 1;
  if (name.includes(query)) return 2;
  if (foldText(entry.description).includes(query)) return 3;
  return null;
}

/**
 * Filtra pelo texto digitado depois da barra, sem diferenciar acento nem caixa. Quem começa pelo texto
 * vem antes de quem só casa numa palavra do nome, no nome, ou na descrição. Texto vazio devolve tudo.
 */
export function searchAgentSlashEntries(entries: ReadonlyArray<AgentSlashEntry>, query: string): AgentSlashEntry[] {
  const folded = foldText(query.replace(/^\/+/, "").trim());
  if (!folded) return [...entries];
  const ranked: { entry: AgentSlashEntry; rank: number }[] = [];
  for (const entry of entries) {
    const rank = rankOf(entry, folded);
    if (rank !== null) ranked.push({ entry, rank });
  }
  // `sort` é estável: dentro de cada posição, a ordem da lista (skills antes, depois alfabética) se mantém.
  return ranked.sort((a, b) => a.rank - b.rank).map(({ entry }) => entry);
}

/**
 * Texto que o composer insere ao escolher a entrada, com um espaço no fim. O Codex e o Cursor usam `$nome`;
 * os outros agentes recebem `/nome`.
 */
export function agentSlashInvocation(entry: Pick<AgentSlashEntry, "name">, agentId?: string | null): string {
  return agentId === "codex" || agentId === "cursor" ? `$${entry.name} ` : `/${entry.name} `;
}
