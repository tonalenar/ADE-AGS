import type { Complexity } from "@/features/runs/types";

export type ModelSelectionMode = "provider-default" | "complexity" | "specific";

export function modelSelectionMode(model: string | null, complexity: Complexity | null): ModelSelectionMode {
  if (model !== null) return "specific";
  return complexity === null ? "provider-default" : "complexity";
}

export function modelSelectionPatch(
  mode: ModelSelectionMode,
  model: string | null,
  complexity: Complexity | null,
): { model: string | null; complexity: Complexity | null } {
  switch (mode) {
    case "provider-default":
      return { model: null, complexity: null };
    case "complexity":
      return { model: null, complexity: complexity ?? "standard" };
    case "specific":
      return { model: model ?? "", complexity: null };
  }
}

export function modelsForAccount<TModel>(
  agent: { models: TModel[]; accounts: { accountId: string | null; models: TModel[] }[] } | undefined,
  accountId: string | null,
  autoAccount: boolean,
): TModel[] {
  if (!agent) return [];
  if (autoAccount || accountId === null) return agent.models;
  return agent.accounts.find((account) => account.accountId === accountId)?.models ?? [];
}

export function modelIsUnverified(model: string | null, catalog: { id: string; source?: string | null }[]): boolean {
  if (model === null || model.trim().length === 0) return false;
  const entry = catalog.find((item) => item.id === model.trim());
  return !entry || entry.source === "ade_history";
}

export function reasoningOptions(model: string | null, catalog: { id: string; reasoningLevels?: string[] | null }[]): string[] {
  return catalog.find((entry) => entry.id === model)?.reasoningLevels ?? [];
}

export function withModelEffort(
  patch: { model: string | null; complexity: Complexity | null },
  effort: string | null,
  catalog: { id: string; reasoningLevels?: string[] | null }[],
) {
  return { ...patch, reasoningEffort: effort && patch.complexity === null && reasoningOptions(patch.model, catalog).includes(effort) ? effort : null };
}
