import type { SkillSummary } from "@/features/skills/types";

export type RegistryRemovalList =
  | { status: "loading" }
  | { status: "unknown" }
  | { status: "empty" }
  | { status: "listed"; skills: SkillSummary[] };

/** O que o diálogo de remover repositório mostra depois da listagem (ou da falha). */
export function registryRemovalList(
  affected: SkillSummary[] | null,
  listFailed: boolean,
): RegistryRemovalList {
  if (listFailed) return { status: "unknown" };
  if (affected === null) return { status: "loading" };
  if (affected.length === 0) return { status: "empty" };
  return { status: "listed", skills: affected };
}
