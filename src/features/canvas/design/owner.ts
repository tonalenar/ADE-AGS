import type { Design } from "./designApi";

export interface OwnerTab { id: string; title: string }

/**
 * Quem recebe as mensagens de um design: o dono gravado, se a aba dele ainda existe; senão a
 * orquestradora (ou, na falta, qualquer aba) da missão do design. `null` = ninguém aberto. Pura.
 */
export function resolveOwner(design: Pick<Design, "ownerTabId" | "missionId">, tabs: OwnerTab[], missionOfTab: Record<string, string>): string | null {
  if (design.ownerTabId && tabs.some((t) => t.id === design.ownerTabId)) return design.ownerTabId;
  if (!design.missionId) return null;
  const mine = tabs.filter((t) => missionOfTab[t.id] === design.missionId);
  return (mine.find((t) => /orquestrador|orchestrat|lead/i.test(t.title)) ?? mine[0])?.id ?? null;
}

/**
 * O design que o painel abre sozinho: o mais recente que tem a quem entregar as mensagens (a lista vem
 * do mais antigo ao mais novo); se nenhum tem, o mais recente. Evita cair num duplicado sem dono. Pura.
 */
export function defaultDesignId(designs: Array<Pick<Design, "id" | "ownerTabId" | "missionId">>, tabs: OwnerTab[], missionOfTab: Record<string, string>): string | null {
  for (let i = designs.length - 1; i >= 0; i -= 1) {
    if (resolveOwner(designs[i], tabs, missionOfTab)) return designs[i].id;
  }
  return designs[designs.length - 1]?.id ?? null;
}
