/** Progresso do balão de "Atualizando <agente>": o atualizador oficial não informa %, então a barra anda por etapas. */
export type UpdateStage = "closing" | "updating" | "reopening" | "restarting";

/** Onde a barra fica ao entrar em cada etapa. */
export const STAGE_START: Record<UpdateStage, number> = {
  closing: 8,
  updating: 20,
  restarting: 100,
  reopening: 100,
};

/** Durante o `updating` a barra sobe devagar até este teto e espera o resultado real. */
export const UPDATING_CEILING = 92;

/** Um passo da subida lenta: avança uma fração do que falta até o teto, sem nunca passar dele. Pura. */
export function creep(current: number): number {
  const next = current + (UPDATING_CEILING - current) * 0.07;
  return Math.min(UPDATING_CEILING, Math.round(next * 10) / 10);
}

/** "v1.0.67 → v1.0.70", ou só a nova (ou nada) quando falta a versão de partida. Pura. */
export function versionLine(current: string | null, latest: string | null): string {
  const fmt = (v: string) => (v.startsWith("v") ? v : `v${v}`);
  if (current && latest) return `${fmt(current)} → ${fmt(latest)}`;
  if (latest) return fmt(latest);
  return "";
}
