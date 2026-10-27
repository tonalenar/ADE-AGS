import type { AgyGroup, AntigravityAccountDiscovery } from "@/features/accounts/ipc";

/** O anel do `agy`: a janela mais gasta de todos os grupos, arredondada. `null` = nenhuma. Pura. */
export function agyTopPercent(groups: AgyGroup[] | null | undefined): number | null {
  let top: number | null = null;
  for (const g of groups ?? []) for (const w of g.windows) if (Number.isFinite(w.usedPct)) top = Math.max(top ?? 0, w.usedPct);
  return top === null ? null : Math.round(Math.max(0, Math.min(100, top)));
}

/** Una barra por modelo con cupo informado: cuánto se USÓ (no cuánto queda) y cuándo se reinicia. */
export interface ModelMeter {
  id: string;
  name: string;
  percent: number;
  resetsAt: number | null;
}

/** Los modelos del catálogo que informan cupo, los más gastados primero. Pura. */
export function modelMeters(models: AntigravityAccountDiscovery["models"]): ModelMeter[] {
  return models
    .filter((m) => typeof m.remainingFraction === "number" && Number.isFinite(m.remainingFraction))
    .map((m) => {
      const reset = m.resetTime ? Date.parse(m.resetTime) : NaN;
      return {
        id: m.id,
        name: m.name,
        percent: Math.round((1 - Math.max(0, Math.min(1, m.remainingFraction as number))) * 100),
        resetsAt: Number.isFinite(reset) ? Math.floor(reset / 1000) : null,
      };
    })
    .sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name));
}
