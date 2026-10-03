import type { AntigravityAccountDiscovery } from "@/features/accounts/ipc";

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
