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

/** Uma linha do catálogo, com os nomes de chamada que ela atende (`aliases`, ex.: `opus` → Claude Opus 5.5). */
export interface CatalogLike {
  id: string;
  aliases?: string[] | null;
}

/**
 * A linha do catálogo de um modelo salvo: pelo id completo ou por um alias (`opus`, `haiku`…). O alias continua
 * sendo o que a CLI recebe, mas a tela mostra e lê a linha que ele resolve, então o nome e o esforço batem com o modelo.
 */
export function findModel<T extends CatalogLike>(catalog: T[], model: string | null): T | undefined {
  if (model === null || model.trim().length === 0) return undefined;
  return catalog.find((entry) => entry.id === model) ?? catalog.find((entry) => entry.aliases?.includes(model));
}

export function modelIsUnverified(model: string | null, catalog: (CatalogLike & { source?: string | null })[]): boolean {
  if (model === null || model.trim().length === 0) return false;
  const entry = findModel(catalog, model.trim());
  return !entry || entry.source === "ade_history" || entry.source === "provider_catalog";
}

export function reasoningOptions(model: string | null, catalog: (CatalogLike & { reasoningLevels?: string[] | null })[]): string[] {
  return findModel(catalog, model)?.reasoningLevels ?? [];
}

/**
 * Os níveis de esforço que a CLI do Claude aceita para este modelo, pelo catálogo: o mesmo critério da validação do
 * backend. Modelo com linha e sem níveis (ex.: Haiku 4.5) não tem esforço, e modelo fora do catálogo também não.
 * `null` = o modelo padrão (sem modelo escolhido): a CLI decide, e quem chama escolhe a lista.
 */
export function claudeEffortLevels(model: string | null, catalog: (CatalogLike & { reasoningLevels?: string[] | null })[]): string[] | null {
  if (model === null) return null;
  return findModel(catalog, model)?.reasoningLevels ?? [];
}

export function withModelEffort(
  patch: { model: string | null; complexity: Complexity | null },
  effort: string | null,
  catalog: (CatalogLike & { reasoningLevels?: string[] | null })[],
) {
  return { ...patch, reasoningEffort: effort && patch.complexity === null && reasoningOptions(patch.model, catalog).includes(effort) ? effort : null };
}

/**
 * Si el modelo elegido ofrece el modo Fast de Codex según el catálogo. `unknown` = sin modelo
 * explícito (el de la TUI) o catálogo que no lo informa: no se avisa nada, solo `unsupported` avisa.
 */
export function fastModeSupport(
  model: string | null,
  catalog: (CatalogLike & { fastSupported?: boolean | null })[],
): "supported" | "unsupported" | "unknown" {
  const supported = findModel(catalog, model)?.fastSupported;
  if (supported === true) return "supported";
  return supported === false ? "unsupported" : "unknown";
}
