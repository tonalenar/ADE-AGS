import type { Box } from "./geometry";

/**
 * O retângulo que a pessoa desenhou para um terminal novo. O terminal só nasce depois do assistente de
 * agente, então o retângulo espera aqui até a aba existir (`takePlacement`) ou até o assistente fechar sem
 * criar nada (`clearPlacement`).
 */
let pending: { key: string; box: Box } | null = null;

export function setPlacement(key: string, box: Box): void {
  pending = { key, box };
}

/** Entrega o retângulo guardado, uma vez só. */
export function takePlacement(): { key: string; box: Box } | null {
  const placement = pending;
  pending = null;
  return placement;
}

export function clearPlacement(): void {
  pending = null;
}
