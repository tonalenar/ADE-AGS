/**
 * Braço de um teste A/B marcado no título da missão: `[AB:<grupo>:<braço>] resto do título`.
 *
 * - `sem-memoria`: o briefing sai SEM a memória aprovada e SEM o resumo de missões anteriores (o que a
 *   equipe saberia só por elas), para medir o que a memória traz.
 * - `com-memoria`, `solo`, `squad` (e qualquer outro nome): só marcam o grupo para o relatório
 *   (`scripts/ab-report.mjs`); não mudam o comportamento.
 *
 * Sem marcador, nada muda: a missão corre como sempre.
 */
export interface AbArm {
  group: string;
  arm: string;
}

const MARK = /^\s*\[AB:([a-z0-9_-]{1,32}):([a-z0-9_-]{1,32})\]/i;

/** Lê o marcador do título, ou `null`. Pura. */
export function parseAbArm(title: string): AbArm | null {
  const found = MARK.exec(title);
  return found ? { group: found[1].toLowerCase(), arm: found[2].toLowerCase() } : null;
}

/** A missão é do braço que roda sem memória? Pura. */
export function isMemoryOff(title: string): boolean {
  return parseAbArm(title)?.arm === "sem-memoria";
}

/** O contexto de conhecimento prévio que entra no briefing: vazio no braço sem memória. Pura. */
export function priorContext(title: string, prepared: { precheck: string; memory: string }): { findings: string; memory: string } {
  return isMemoryOff(title) ? { findings: "", memory: "" } : { findings: prepared.precheck, memory: prepared.memory };
}
