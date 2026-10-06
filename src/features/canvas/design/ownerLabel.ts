import type { Design } from "./designApi";

/**
 * Por que o dono do design não recebe as mensagens, para o aviso: o que o backend informa
 * (`ownerWarning`); sem a informação, o que a UI resolveu (`resolved` = achou uma aba). `null` = recebe.
 */
export function ownerProblem(design: Pick<Design, "ownerWarning">, resolved: boolean): "missing" | "closed" | null {
  if (resolved) return null;
  if (design.ownerWarning) return design.ownerWarning;
  return "missing";
}
